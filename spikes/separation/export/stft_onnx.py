"""ONNX-exportable replacements for htdemucs's STFT/iSTFT (the known-fiddly part).

torch.stft/istft do not export to ONNX (istft has no ONNX op at all, and the
STFT op that exists in opset 17 is unsupported on the DirectML EP), so we
express both with fixed DFT-matrix weights. All shapes are static: htdemucs
processes fixed 7.8 s segments.

The forward STFT is frame-gather + one MatMul, not Conv1d: DirectML runs a
4096-tap Conv1d as one ~260 ms dispatch per segment that stalls the whole
desktop (optimize_for_dml.py docstring has the measurements). The kernel is
4 x the hop, so each frame is 4 consecutive hop-sized blocks.

Layout conventions match htdemucs exactly:
  - ConvSTFT(x: (B, C, L)) -> (B, C*2, 2048, T)   # CaC layout [c0_re, c0_im, c1_re, c1_im]
    replicating model._spec + model._magnitude (cac=True).
  - ConvISTFT(m: (B, S, C*2, 2048, T)) -> (B, S, C, L)
    replicating model._mask (cac identity) + model._ispec.

Verified numerically against demucs's own implementation by run_selftest().
"""
import math

import torch
import torch.nn.functional as F
from torch import nn

NFFT = 4096
HOP = 1024


def _dft_basis(nfft: int, window: torch.Tensor):
    """Forward DFT basis (normalized), for rfft bins 0..nfft/2."""
    n = torch.arange(nfft, dtype=torch.float64)
    k = torch.arange(nfft // 2 + 1, dtype=torch.float64)
    theta = 2.0 * math.pi * k[:, None] * n[None, :] / nfft  # (F, N)
    scale = 1.0 / math.sqrt(nfft)  # torch.stft(normalized=True)
    re = torch.cos(theta) * window[None, :].double() * scale
    im = -torch.sin(theta) * window[None, :].double() * scale
    return re.float(), im.float()


class ConvSTFT(nn.Module):
    """Replicates HTDemucs._spec + ._magnitude for fixed-length input."""

    def __init__(self, length: int):
        super().__init__()
        self.length = length
        self.le = int(math.ceil(length / HOP))
        self.pad = HOP // 2 * 3  # 1536
        self.pad_right = self.pad + self.le * HOP - length
        window = torch.hann_window(NFFT, periodic=True)
        re, im = _dft_basis(NFFT, window)
        # drop the last freq bin (htdemucs keeps 2048 of 2049), block layout [re | im]
        weight = torch.cat([re[:-1], im[:-1]], dim=0)  # (4096 out, 4096 taps)
        self.register_buffer("weight_t", weight.t().contiguous())  # (taps, out)

    def forward(self, x):  # (B, C, L)
        B, C, L = x.shape
        # outer pad from _spec (reflect), then torch.stft center pad (reflect)
        x = F.pad(x, (self.pad, self.pad_right), mode="reflect")
        x = F.pad(x, (NFFT // 2, NFFT // 2), mode="reflect")
        n = x.shape[-1]  # (le + 7) * HOP: both pads are whole hops
        blocks = x.reshape(B * C, n // HOP, HOP)
        taps = NFFT // HOP
        # frame t = blocks t..t+3; htdemucs keeps frames 2..2+le
        frames = torch.cat([blocks[:, 2 + j: 2 + j + self.le] for j in range(taps)], dim=-1)  # (B*C, le, NFFT)
        z = (frames @ self.weight_t).transpose(1, 2)  # (B*C, 4096, le)
        z = z.reshape(B, C, 2, NFFT // 2, self.le)  # [re | im] block -> dim 2
        z = z.reshape(B, C * 2, NFFT // 2, self.le)  # [c0_re, c0_im, c1_re, c1_im]
        return z


class ConvISTFT(nn.Module):
    """Replicates HTDemucs._mask (cac) + ._ispec for fixed-length output."""

    def __init__(self, length: int):
        super().__init__()
        self.length = length
        le_frames = int(math.ceil(length / HOP))  # frames before (2,2) pad
        self.frames = le_frames + 4
        self.out_pad = HOP // 2 * 3  # 1536
        self.out_le = HOP * le_frames + 2 * self.out_pad  # istft length arg
        window = torch.hann_window(NFFT, periodic=True)
        n = torch.arange(NFFT, dtype=torch.float64)
        k = torch.arange(NFFT // 2 + 1, dtype=torch.float64)
        theta = 2.0 * math.pi * k[:, None] * n[None, :] / nfft_const()
        # irfft coefficients: c_k = 2/N except bins 0 and N/2 (1/N); imag of
        # bins 0 and N/2 is ignored by irfft (Hermitian assumption).
        c = torch.full((NFFT // 2 + 1,), 2.0 / NFFT, dtype=torch.float64)
        c[0] = 1.0 / NFFT
        c[-1] = 1.0 / NFFT
        scale = math.sqrt(NFFT)  # torch.istft(normalized=True)
        wre = (c[:, None] * torch.cos(theta)) * window[None, :].double() * scale
        wim = (-c[:, None] * torch.sin(theta)) * window[None, :].double() * scale
        wim[0] = 0.0
        wim[-1] = 0.0
        # (4098, 4096) synthesis basis, used via MatMul instead of
        # ConvTranspose1d: DirectML materializes an enormous im2col buffer for
        # kernel-4096/stride-1024 transposed convs and OOMs on 8 GB cards.
        weight = torch.cat([wre, wim], dim=0).float()
        self.register_buffer("weight", weight)
        # window-square overlap-add envelope (torch.istft denominator),
        # precomputed for the fixed frame count, sliced to the output region
        ola_len = (self.frames - 1) * HOP + NFFT
        env = torch.zeros(ola_len, dtype=torch.float64)
        w2 = (window.double()) ** 2
        for t in range(self.frames):
            env[t * HOP: t * HOP + NFFT] += w2
        start = NFFT // 2 + self.out_pad  # istft center trim + _ispec pad trim
        env = env[start: start + length].float()
        self.register_buffer("env", env)
        self.start = start

    def forward(self, m):  # (B, S, C2, 2048, T) CaC
        B, S, C2, Fr, T = m.shape
        C = C2 // 2
        z = F.pad(m, (0, 0, 0, 1))  # add back highest freq bin (zeros)
        z = F.pad(z, (2, 2))  # pad frames -> T+4
        z = z.reshape(B * S * C, 2 * (NFFT // 2 + 1), self.frames)
        # synthesis: frames (BSC, T, 4098) @ (4098, 4096) -> windowed time frames
        frames = z.transpose(1, 2) @ self.weight  # (BSC, T, 4096)
        # overlap-add with hop 1024 = sum of 4 shifted quarter-frame streams
        f = frames.reshape(-1, self.frames, 4, HOP)
        total = self.frames * HOP
        x = None
        for j in range(4):
            seq = f[:, :, j, :].reshape(-1, total)
            seq = F.pad(seq, (j * HOP, (3 - j) * HOP))
            x = seq if x is None else x + seq
        # x: (BSC, ola_len) with ola_len = (frames-1)*HOP + NFFT
        x = x[..., self.start: self.start + self.length]
        x = x / self.env
        return x.reshape(B, S, C, self.length)


def nfft_const():
    return NFFT


def run_selftest(segment_length: int):
    """Compare against demucs's real _spec/_ispec on random data."""
    from demucs import spec as dspec

    torch.manual_seed(0)
    results = {}

    # --- forward STFT parity (vs _spec + _magnitude, cac layout) ---
    x = torch.randn(1, 2, segment_length)
    hl, nfft = HOP, NFFT
    le = int(math.ceil(x.shape[-1] / hl))
    pad = hl // 2 * 3
    xp = F.pad(x, (pad, pad + le * hl - x.shape[-1]), mode="reflect")
    z = dspec.spectro(xp, nfft, hl)[..., :-1, :]
    z = z[..., 2: 2 + le]
    Bz, Cz, Frz, Tz = z.shape
    ref = torch.view_as_real(z).permute(0, 1, 4, 2, 3).reshape(Bz, Cz * 2, Frz, Tz)

    got = ConvSTFT(segment_length)(x)
    err = (got - ref).abs().max().item()
    rel = err / ref.abs().max().item()
    results["stft_max_abs_err"] = err
    results["stft_max_rel_err"] = rel

    # --- inverse STFT parity (vs _ispec) ---
    m = torch.randn(1, 4, 4, NFFT // 2, le)  # (B, S, C*2, Fr, T)
    B, S, C2, Fr, T = m.shape
    zc = m.view(B, S, C2 // 2, 2, Fr, T).permute(0, 1, 2, 4, 5, 3).contiguous()
    zc = torch.view_as_complex(zc)
    zz = F.pad(zc, (0, 0, 0, 1))
    zz = F.pad(zz, (2, 2))
    le_out = hl * int(math.ceil(segment_length / hl)) + 2 * pad
    xr = dspec.ispectro(zz, hl, length=le_out)
    ref_x = xr[..., pad: pad + segment_length]

    got_x = ConvISTFT(segment_length)(m)
    err_i = (got_x - ref_x).abs().max().item()
    rel_i = err_i / ref_x.abs().max().item()
    results["istft_max_abs_err"] = err_i
    results["istft_max_rel_err"] = rel_i
    return results


if __name__ == "__main__":
    seg = int(7.8 * 44100)
    res = run_selftest(seg)
    for k, v in res.items():
        print(f"{k}: {v:.3e}")
    ok = res["stft_max_rel_err"] < 1e-4 and res["istft_max_rel_err"] < 1e-4
    print("SELFTEST", "PASS" if ok else "FAIL")
