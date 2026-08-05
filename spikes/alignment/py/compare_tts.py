"""Compare pipeline word onsets against SAPI TTS ground truth (machine-exact
word onsets). Matches words by text within a sliding window after sorting the
truth by onset (Get-Event can deliver events out of order)."""
import json, os, sys
import numpy as np

OUT = os.path.join(os.path.dirname(__file__), "..", "out")
truth = json.load(open(os.path.join(OUT, "tts-reference.truth.json"), encoding="utf-8-sig"))
truth = sorted(truth, key=lambda r: r["onset_s"])
res = json.load(open(os.path.join(OUT, "tts-reference.align.json")))
words = res["words"]

def norm(w):
    return "".join(c for c in w.upper() if c.isalpha() or c == "'")

truth_n = [(norm(r["word"]), r["onset_s"]) for r in truth]
pred_n = [(w["word"], w["start"]) for w in words]

# greedy in-order matching
errs = []
pairs = []
j = 0
for tw, tt in truth_n:
    for k in range(j, min(j + 4, len(pred_n))):
        if pred_n[k][0] == tw:
            errs.append(pred_n[k][1] - tt)
            pairs.append((tw, tt, pred_n[k][1]))
            j = k + 1
            break

errs = np.array(errs)
print(f"matched {len(errs)}/{len(truth_n)} words (pred has {len(pred_n)})")
print(f"onset error (pred - truth) seconds:")
print(f"  median {np.median(errs):+.3f}  mean {errs.mean():+.3f}")
print(f"  abs: median {np.median(np.abs(errs)):.3f}  p90 {np.percentile(np.abs(errs),90):.3f}  max {np.abs(errs).max():.3f}")
print(f"  within 100ms: {(np.abs(errs)<=0.1).mean()*100:.0f}%   within 50ms: {(np.abs(errs)<=0.05).mean()*100:.0f}%")
worst = sorted(pairs, key=lambda p: abs(p[2]-p[1]))[-5:]
print("worst:", [(w, round(t,2), round(p,2)) for w,t,p in worst])
