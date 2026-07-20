#!/usr/bin/env python3
"""
Splice Model Mind Lab — the scaling question.

probes.py found that gpt2's softmax confidence is nearly blind to the
geometric robustness of its own decisions (r ≈ 0.14 over 14 prompts). This
experiment asks the question that finding begs:

    Does confidence become better calibrated to decision geometry as
    models scale?

Protocol (per model, per prompt):
  - confidence          softmax P(top-1)
  - margin              logit(top-1) − logit(top-2)
  - min flip distance   min over tokens of margin / ‖∂margin/∂emb_i‖
                        (first-order embedding-space distance to the boundary)
  - deletion flips      # of single-token deletions that change top-1
Then per model: Pearson and Spearman correlations of confidence against
margin and flip distance, plus the share of top-third-confidence predictions
that are fragile (any deletion flip). Across models: the correlation as a
function of parameter count.

Notes on comparability: correlations are computed WITHIN each model (raw
flip distances are not comparable across models — embedding norms differ).
The prompt set is fixed across models. GPT-2-family only, so tokenization
is shared.

Usage:
  python3 scaling.py --models distilgpt2,gpt2,gpt2-medium,gpt2-large \
                     --out results/scaling-calibration.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

import numpy as np

from mindlab import Lab
from probes import run_geometry

PARAM_COUNTS = {
    "distilgpt2": 82_000_000,
    "gpt2": 124_000_000,
    "gpt2-medium": 355_000_000,
    "gpt2-large": 774_000_000,
    "gpt2-xl": 1_558_000_000,
}

# 40 short completions with a reasonably clear continuation, mixed domains.
PROMPTS = [
    "The Eiffel Tower is located in the city of",
    "The capital of Japan is",
    "The capital of France is",
    "The capital of Italy is",
    "The chemical symbol for gold is",
    "The chemical symbol for oxygen is",
    "Two plus two equals",
    "Ten minus three equals",
    "The opposite of hot is",
    "The opposite of dark is",
    "The opposite of up is",
    "The first president of the United States was",
    "Water is made of hydrogen and",
    "The largest planet in the solar system is",
    "The closest planet to the sun is",
    "A group of lions is called a",
    "A baby dog is called a",
    "The author of Romeo and Juliet is",
    "The square root of sixty-four is",
    "The color of a clear daytime sky is",
    "The color of grass is",
    "The freezing point of water in Celsius is",
    "The currency used in Japan is the",
    "The currency used in the United States is the",
    "The number of days in a week is",
    "The number of legs on a spider is",
    "The largest ocean on Earth is the",
    "The longest river in the world is the",
    "Humans breathe in oxygen and breathe out carbon",
    "The sun rises in the east and sets in the",
    "A doctor works in a hospital and a teacher works in a",
    "The past tense of run is",
    "The plural of mouse is",
    "Ice is frozen",
    "The moon orbits the",
    "Lightning is followed by",
    "The king lived in a large",
    "She poured the tea into a",
    "He locked the door with a",
    "The fastest land animal is the",
]


def spearman(x: list[float], y: list[float]) -> float:
    if len(x) < 2:
        return 0.0
    rx = np.argsort(np.argsort(x)).astype(float)
    ry = np.argsort(np.argsort(y)).astype(float)
    if rx.std() < 1e-9 or ry.std() < 1e-9:
        return 0.0
    return round(float(np.corrcoef(rx, ry)[0, 1]), 3)


def pearson(x: list[float], y: list[float]) -> float:
    if len(x) < 2:
        return 0.0
    a, b = np.array(x, dtype=float), np.array(y, dtype=float)
    if a.std() < 1e-9 or b.std() < 1e-9:
        return 0.0
    return round(float(np.corrcoef(a, b)[0, 1]), 3)


def run_model(name: str) -> dict:
    t0 = time.time()
    sys.stderr.write(f"[scaling] {name}: loading…\n")
    lab = Lab(name)
    points = []
    for i, prompt in enumerate(PROMPTS):
        g = run_geometry(lab, prompt, k=4)
        flips = [t["flip_distance"] for t in g.per_token if t["flip_distance"] is not None]
        points.append({
            "prompt": prompt,
            "predicted": g.predicted,
            "confidence": g.predicted_prob,
            "margin": g.margin,
            "min_flip_distance": round(min(flips), 4) if flips else None,
            "deletion_flips": sum(1 for t in g.per_token if t.get("deletion_flips")),
        })
        if (i + 1) % 10 == 0:
            sys.stderr.write(f"[scaling] {name}: {i + 1}/{len(PROMPTS)}\n")

    conf = [p["confidence"] for p in points]
    margin = [p["margin"] for p in points]
    withflip = [p for p in points if p["min_flip_distance"] is not None]

    # Fragile share among the top-third most confident predictions.
    by_conf = sorted(points, key=lambda p: -p["confidence"])
    top_third = by_conf[: max(1, len(points) // 3)]
    fragile_top = [p for p in top_third if p["deletion_flips"] > 0]

    summary = {
        "model": name,
        "params": PARAM_COUNTS.get(name),
        "prompts": len(points),
        "pearson_conf_margin": pearson(conf, margin),
        "spearman_conf_margin": spearman(conf, margin),
        "pearson_conf_flipdist": pearson([p["confidence"] for p in withflip],
                                         [p["min_flip_distance"] for p in withflip]),
        "spearman_conf_flipdist": spearman([p["confidence"] for p in withflip],
                                           [p["min_flip_distance"] for p in withflip]),
        "mean_confidence": round(float(np.mean(conf)), 4),
        "mean_margin": round(float(np.mean(margin)), 3),
        "fragile_share_top_conf": round(len(fragile_top) / len(top_third), 3),
        "runtime_s": round(time.time() - t0, 1),
        "points": points,
    }
    sys.stderr.write(
        f"[scaling] {name}: pearson(conf,margin)={summary['pearson_conf_margin']} "
        f"spearman={summary['spearman_conf_margin']} "
        f"fragile-top-conf={summary['fragile_share_top_conf']} "
        f"({summary['runtime_s']}s)\n")
    del lab
    return summary


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--models", default="distilgpt2,gpt2,gpt2-medium,gpt2-large")
    ap.add_argument("--out", default="results/scaling-calibration.json")
    args = ap.parse_args()

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    results = [run_model(m) for m in models]

    trend = [{"model": r["model"], "params": r["params"],
              "pearson_conf_margin": r["pearson_conf_margin"],
              "spearman_conf_margin": r["spearman_conf_margin"],
              "spearman_conf_flipdist": r["spearman_conf_flipdist"],
              "fragile_share_top_conf": r["fragile_share_top_conf"]} for r in results]

    payload = {
        "question": "Does softmax confidence become better calibrated to decision geometry with scale?",
        "protocol": "40 fixed prompts; per prompt: confidence, top1-vs-top2 margin, min per-token "
                    "linearized flip distance, single-token-deletion flips. Correlations within model.",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "trend": trend,
        "models": results,
    }
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(payload, f, indent=2)
    sys.stderr.write(f"[scaling] wrote {args.out}\n\n=== TREND ===\n")
    for t in trend:
        sys.stderr.write(f"  {t['model']:<12} {str(t['params']):<12} "
                         f"pearson {t['pearson_conf_margin']:<7} spearman {t['spearman_conf_margin']:<7} "
                         f"fragile-top {t['fragile_share_top_conf']}\n")


if __name__ == "__main__":
    main()
