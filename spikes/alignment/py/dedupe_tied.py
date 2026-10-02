"""Store whisper's tied embedding once in the merged decoder.

optimum's export writes the token embedding twice: as the Gather table
[vocab, d_model] and, transposed, as the output projection's MatMul weight
[d_model, vocab] — 159 MB of duplicate bytes in whisper-small. This keeps the
first and makes the second with a Transpose node of the same name, so every
consumer (inside the merged decoder's If branches too) is unchanged. ONNX
Runtime folds the Transpose at session load, so inference is the same; only
the file shrinks. Export-time only; nothing here ships.

usage: python dedupe_tied.py <in.onnx> <out.onnx>
"""
import sys

import numpy as np
import onnx
from onnx import helper, numpy_helper

src, dst = sys.argv[1], sys.argv[2]
m = onnx.load(src)
g = m.graph
inits = {i.name: i for i in g.initializer}
by_shape = {}
for i in g.initializer:
    if len(i.dims) == 2:
        by_shape.setdefault(tuple(i.dims), []).append(i)

pairs = []
for (a, b), group in list(by_shape.items()):
    # Keep the [vocab, d_model] table (the taller one); drop its transpose.
    if a <= b:
        continue
    for x in group:
        for y in by_shape.get((b, a), []):
            if x.data_type != y.data_type:
                continue
            ax, ay = numpy_helper.to_array(x), numpy_helper.to_array(y)
            if ax.size > 1_000_000 and np.array_equal(ax.T, ay):
                pairs.append((x.name, y.name))
seen = set()
pairs = [(k, t) for k, t in pairs if not (t in seen or seen.add(t))]
if not pairs:
    sys.exit("no transposed duplicate found")
for keep, drop in pairs:
    print(f"keep {keep} {tuple(inits[keep].dims)}; {drop} becomes Transpose({keep})")
    g.initializer.remove(inits[drop])
    g.node.insert(0, helper.make_node("Transpose", [keep], [drop], perm=[1, 0], name=f"tied_{drop}"))
onnx.checker.check_model(m)
onnx.save(m, dst)
print("saved", dst)
