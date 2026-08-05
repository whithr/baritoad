"""Summarize all *.align.json runs into a table + quality heuristics."""
import glob, json, os
import numpy as np

OUT = os.path.join(os.path.dirname(__file__), "..", "out")
rows = []
for p in sorted(glob.glob(os.path.join(OUT, "*.align.json"))):
    r = json.load(open(p))
    w = r["words"]
    durs = np.array([x["end"] - x["start"] for x in w]) if w else np.array([0.0])
    gaps = np.array([b["start"] - a["end"] for a, b in zip(w, w[1:])]) if len(w) > 1 else np.array([0.0])
    scores = np.array([x["score"] for x in w]) if w else np.array([0.0])
    rows.append({
        "song": r["song"],
        "dur_s": round(r["audio_duration_s"], 1),
        "whisper_s": round(r["stage_whisper_s"], 1),
        "w2v_s": round(r["stage_w2v_inference_s"], 1),
        "trellis_s": round(r["stage_trellis_s"], 3),
        "align_total_s": round(r["total_alignment_stage_s"], 1),
        "rtf": round(r["realtime_factor"], 2),
        "norm_210s": round(r["realtime_factor"] * 210, 1),
        "n_words": r["n_words"],
        "word_dur_med": round(float(np.median(durs)), 2),
        "word_dur_p95": round(float(np.percentile(durs, 95)), 2),
        "words_gt_2s": int((durs > 2.0).sum()),
        "score_med": round(float(np.median(scores)), 2),
        "score_p10": round(float(np.percentile(scores, 10)), 2),
    })
keys = list(rows[0].keys())
print("\t".join(keys))
for r in rows:
    print("\t".join(str(r[k]) for k in keys))
