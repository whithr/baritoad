"""Insert GPU yield points into an htdemucs ONNX for DirectML (run after
optimize_for_dml.py).

Why: DirectML runs a session's work in long command lists, and while one
runs nothing else on the GPU gets a turn — not the desktop compositor, not a
game. With RuneLite open (~19% of the 3D engine), separation held a 120 fps
probe window to 57 fps with 47 frames over 50 ms during a 157.6 s song's
inference (RTX 2080 SUPER, ORT 1.24 DirectML, 2026-09-30). No single op was
to blame (the slowest, the inverse-STFT MatMul, is ~10 ms) — the work just
never paused.

How: at each cut point, a tiny branch the DML EP can't run — a 1-element
slice of the activation crossing the cut, Cast to STRING and back — forces
ONNX Runtime to copy it to the CPU, which waits for every queued GPU command
(a drain the GPU scheduler hands to other processes); the result times zero
is added back onto that activation so later nodes depend on it. x + 0*f == x,
so output is bit-identical on DirectML (CPU: max abs diff 2.2e-7, fusion
order). One session, one allocator: no extra VRAM, unlike running the model
as separately-synchronized parts (the same smoothness, but +6 GB — 32
sessions each keep their own buffer cache).

Each cut anchors on the most recently produced tensor crossing it. (The
largest crossing tensor is usually a U-Net skip made far earlier; anchoring
there bunches the drains near its producer — 59 fps instead of 109.)

Measured on that song, RuneLite running, 31 evenly spaced cuts + 6 where GPU
time is dense (--extra-cuts 116,1369,1415,1448,1459,1462 — the second encoder
layer, the last two time-decoder blocks, around the output ConvTranspose and
the inverse-STFT MatMul): separation inference 114 fps, 1 frame over 50 ms
(max 50 ms), 6.0 s instead of 5.6 s. The four htdemucs_ft files share the
base graph's node order, so the same cuts apply.

usage: python add_sync_points.py <in.onnx> <out.onnx> --points 31 \\
           --extra-cuts 116,1369,1415,1448,1459,1462
needs: onnx (export-time only; nothing here ships)
"""
import argparse

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper, shape_inference


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--points", type=int, required=True, help="evenly spaced cuts (by node index)")
    ap.add_argument("--extra-cuts", default="", help="more cut node indices, where measured GPU time is dense")
    a = ap.parse_args()

    m = onnx.load(a.src)
    inferred = shape_inference.infer_shapes(m)
    vi = {v.name: v for v in list(inferred.graph.value_info) + list(inferred.graph.input) + list(inferred.graph.output)}
    g = m.graph
    nodes = list(g.node)
    inits = {t.name for t in g.initializer}
    producer = {o: i for i, n in enumerate(nodes) for o in n.output if o}
    consumers = {}
    for i, n in enumerate(nodes):
        for t in n.input:
            if t and t not in inits:
                consumers.setdefault(t, []).append(i)

    def numel(t):
        v = vi.get(t)
        if v is None or v.type.tensor_type.elem_type != TensorProto.FLOAT:
            return -1
        dims = [d.dim_value for d in v.type.tensor_type.shape.dim]
        if not dims or any(d <= 0 for d in dims):
            return -1
        return int(np.prod(dims))

    n = len(nodes)
    cuts = {round(n * k / (a.points + 1)) for k in range(1, a.points + 1)}
    cuts |= {int(c) for c in a.extra_cuts.split(",") if c}
    cuts = sorted(c for c in cuts if 0 < c < n)

    g.initializer.extend([
        numpy_helper.from_array(np.array(0.0, dtype=np.float32), "ksync_zero"),
        numpy_helper.from_array(np.array([], dtype=np.int64), "ksync_scalar_shape"),
        numpy_helper.from_array(np.array([0], dtype=np.int64), "ksync_starts"),
        numpy_helper.from_array(np.array([1], dtype=np.int64), "ksync_ends"),
        numpy_helper.from_array(np.array([1], dtype=np.int64), "ksync_axes"),
    ])

    inserted, rename = {}, []
    for j, c in enumerate(cuts):
        crossing = [t for t, cs in consumers.items() if t in producer and producer[t] < c and any(x >= c for x in cs)]
        crossing = [t for t in crossing if numel(t) > 0]
        if not crossing:
            print(f"cut {c}: no float tensor crosses it — skipped")
            continue
        x = max(crossing, key=lambda t: (producer[t], numel(t)))
        p = f"ksync{j}_"
        inserted[c] = [
            helper.make_node("Flatten", [x], [p + "flat"], axis=0),
            helper.make_node("Slice", [p + "flat", "ksync_starts", "ksync_ends", "ksync_axes"], [p + "one"]),
            helper.make_node("Cast", [p + "one"], [p + "str"], to=TensorProto.STRING),
            helper.make_node("Cast", [p + "str"], [p + "back"], to=TensorProto.FLOAT),
            helper.make_node("Mul", [p + "back", "ksync_zero"], [p + "z"]),
            helper.make_node("Reshape", [p + "z", "ksync_scalar_shape"], [p + "zs"]),
            helper.make_node("Add", [x, p + "zs"], [p + "x"]),
        ]
        rename.append((c, x, p + "x"))
        print(f"cut {c:5d} before {nodes[c].op_type:22s} anchored on {x} (from node {producer[x]})")

    graph_outputs = {o.name for o in g.output}
    for c, old, new in rename:
        if old in graph_outputs:
            raise SystemExit(f"cut tensor {old} is a graph output")
        for node in nodes[c:]:
            for k, t in enumerate(node.input):
                if t == old:
                    node.input[k] = new

    out_nodes = []
    for i, node in enumerate(nodes):
        out_nodes.extend(inserted.get(i, []))
        out_nodes.append(node)
    del g.node[:]
    g.node.extend(out_nodes)
    onnx.checker.check_model(m)
    onnx.save(m, a.dst)
    print(f"{len(inserted)} sync points in {n} nodes -> {a.dst}")


if __name__ == "__main__":
    main()
