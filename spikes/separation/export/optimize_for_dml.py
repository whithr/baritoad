"""Post-process an exported htdemucs ONNX for DirectML: fold the exporter's
shape bookkeeping (onnxsim, static input shape) and, for exports made before
stft_onnx.py switched to a MatMul STFT (2026-09-30), rewrite the forward-STFT
Conv1d as frame-gather + one MatMul.

Why: ConvSTFT (stft_onnx.py) is a Conv1d with a 4096-tap kernel at stride
1024. DirectML runs it as one ~260 ms dispatch per 7.8 s segment on an RTX
2080 SUPER — over half the segment's GPU time — and nothing else on the GPU
(the desktop compositor included) can run while it does: a GPU-drawn window
fell to 28 fps with ~400 ms hitches during separation. As a
[C, 340, 4096] x [4096, 4096] MatMul the whole segment drops from 431 to
169 ms and the window stays at 120 fps (measured 2026-09-30, ORT 1.24
DirectML, htdemucs_ft vocals). Output is bit-identical on DirectML; CPU
parity vs the original is unchanged.

Since the frames are 4 consecutive 1024-sample blocks (kernel = 4 x stride),
frame t = concat(blocks[t..t+4]) — an exact rewrite, no approximation.

usage: python optimize_for_dml.py <in.onnx> <out.onnx>
needs: onnx, onnxsim (export-time only; nothing here ships)
"""
import sys

import numpy as np
import onnx
import onnxsim
from onnx import helper, numpy_helper, shape_inference

SEGMENT = 343980  # int(7.8 s * 44100), fixed by the export
KERNEL, HOP = 4096, 1024


def simplify(m):
    ms, ok = onnxsim.simplify(m, overwrite_input_shapes={"mix": [1, 2, SEGMENT]})
    assert ok, "onnxsim check failed"
    return ms


def stft_conv_to_matmul(m):
    g = m.graph
    inits = {t.name: t for t in g.initializer}
    hit = None
    for i, n in enumerate(g.node):
        if n.op_type != "Conv" or len(n.input) != 2:
            continue
        a = {x.name: helper.get_attribute_value(x) for x in n.attribute}
        if list(a.get("kernel_shape", [])) == [KERNEL] and list(a.get("strides", [])) == [HOP]:
            assert a.get("group", 1) == 1
            assert list(a.get("pads", [0, 0])) == [0, 0]
            assert list(a.get("dilations", [1])) == [1]
            hit = (i, n)
            break
    if hit is None:
        return m, False  # a current export: stft_onnx.py already emits the MatMul
    idx, conv = hit
    x_name, w_name = conv.input
    y_name = conv.output[0]
    w = numpy_helper.to_array(inits[w_name])  # [out, 1, KERNEL]
    out_ch = w.shape[0]
    assert w.shape == (out_ch, 1, KERNEL), w.shape

    shapes = shape_inference.infer_shapes(m)
    vi = {v.name: v for v in list(shapes.graph.value_info) + list(shapes.graph.input)}
    batch, cin, length = [d.dim_value for d in vi[x_name].type.tensor_type.shape.dim]
    assert cin == 1 and length % HOP == 0, (batch, cin, length)
    blocks = length // HOP
    frames = (length - KERNEL) // HOP + 1
    taps = KERNEL // HOP

    p = "stft_mm"
    new_inits = [
        numpy_helper.from_array(np.array([batch, blocks, HOP], dtype=np.int64), f"{p}/blk_shape"),
        numpy_helper.from_array(np.ascontiguousarray(w.reshape(out_ch, KERNEL).T).astype(np.float32), f"{p}/w_t"),
        numpy_helper.from_array(np.array([1], dtype=np.int64), f"{p}/axis1"),
    ]
    nodes = [helper.make_node("Reshape", [x_name, f"{p}/blk_shape"], [f"{p}/blocks"], name=f"{p}/reshape")]
    parts = []
    for j in range(taps):
        s = numpy_helper.from_array(np.array([j], dtype=np.int64), f"{p}/s{j}")
        e = numpy_helper.from_array(np.array([j + frames], dtype=np.int64), f"{p}/e{j}")
        new_inits += [s, e]
        nodes.append(helper.make_node("Slice", [f"{p}/blocks", s.name, e.name, f"{p}/axis1"], [f"{p}/sl{j}"], name=f"{p}/slice{j}"))
        parts.append(f"{p}/sl{j}")
    nodes.append(helper.make_node("Concat", parts, [f"{p}/frames"], axis=2, name=f"{p}/concat"))
    nodes.append(helper.make_node("MatMul", [f"{p}/frames", f"{p}/w_t"], [f"{p}/spec_t"], name=f"{p}/matmul"))
    nodes.append(helper.make_node("Transpose", [f"{p}/spec_t"], [y_name], perm=[0, 2, 1], name=f"{p}/transpose"))

    rebuilt = list(g.node[:idx]) + nodes + list(g.node[idx + 1:])
    del g.node[:]
    g.node.extend(rebuilt)
    if not any(w_name in n.input for n in g.node):
        keep = [t for t in g.initializer if t.name != w_name]
        del g.initializer[:]
        g.initializer.extend(keep)
    g.initializer.extend(new_inits)
    return m, True


def main():
    src, dst = sys.argv[1], sys.argv[2]
    m = onnx.load(src)
    before = len(m.graph.node)
    m, rewrote = stft_conv_to_matmul(simplify(m))
    onnx.checker.check_model(m)
    onnx.save(m, dst)
    what = "STFT Conv -> MatMul" if rewrote else "STFT already a MatMul"
    print(f"{src}: {before} -> {len(m.graph.node)} nodes, {what}; wrote {dst}")


if __name__ == "__main__":
    main()
