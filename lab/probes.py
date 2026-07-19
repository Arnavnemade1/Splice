#!/usr/bin/env python3
"""
Splice Model Mind Lab — novel probes.

mindlab.py replicates established interpretability experiments. This file goes
one step further: it ports Splice's OWN decision-geometry instrument onto a
real transformer, and runs measurements that are not standard figures.

Honest framing (see NOVEL.md): these are novel *syntheses and measurements*,
not novel primitives. Each is built from gradients, leave-one-out ablations,
and activation differences you can read in this file. The claim is not "new
interpretability method" — it is "the exact battery Splice runs over its own
action scorer, run for the first time over a real model's next-token
decision, plus one open question that battery lets us ask."

  geometry   The Splice <-> model bridge. For one prediction, compute the same
             quantities Splice reports for its own decisions:
               - token-deletion robustness (does top-1 survive leave-one-out?)
               - per-token flip distance (linearized embedding-space margin to
                 the decision boundary) — the model-side flip boundary
               - effective dimension (participation ratio of the Jacobian
                 spectrum) — how many directions the decision occupies
               - the load-bearing token (largest margin collapse on deletion)

  calibrate  Is the model calibrated to its OWN fragility? Across a prompt set,
             correlate softmax confidence with geometric robustness. A model
             can be confident AND one token-swap from flipping; this measures
             whether its confidence knows that.

  transport  Does a concept live in a shared basis across depth? Build a
             concept vector at every layer and measure (a) cross-layer
             alignment (cosine matrix) and (b) functional transport — inject
             one layer's vector at every layer and measure the KL shift it
             causes on a neutral prompt.

Usage:
  python3 probes.py geometry  --prompt "The Eiffel Tower is located in the city of"
  python3 probes.py calibrate
  python3 probes.py transport --concept "the ocean"
  python3 probes.py all --out probes.json
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import asdict, dataclass, field
from typing import Any

try:
    import numpy as np
    import torch
except ImportError as exc:  # pragma: no cover
    sys.stderr.write(f"Missing dependency: {exc.name}. Install: pip install -r requirements.txt\n")
    sys.exit(2)

from mindlab import Lab, concept_vector, CONCEPT_CONTRASTS  # reuse the loaded-model plumbing

torch.manual_seed(0)


# ─── 1. Decision geometry (the Splice <-> model bridge) ─────────────────────


@dataclass
class GeometryResult:
    prompt: str
    tokens: list[str]
    predicted: str
    runner_up: str
    predicted_prob: float
    margin: float
    #: participation ratio of the token x logit Jacobian spectrum — Splice's
    #: effectiveDimension formula, (sum lambda)^2 / sum lambda^2.
    effective_dimension: float
    #: per input token: does deleting it flip the prediction, and the
    #: linearized embedding-space distance to the flip boundary along it.
    per_token: list[dict[str, Any]]
    robust_to_deletion: bool
    load_bearing_token: str | None
    nearest_flip_token: str | None
    interpretation: list[str]
    note: str = (
        "The exact battery JSpace.ts runs over Splice's action scorer, computed "
        "over a real transformer's next-token decision. Flip distance is a "
        "first-order embedding-space margin (not a discrete token swap)."
    )


def _participation_ratio(sv: torch.Tensor) -> float:
    lam = (sv**2)
    total = float(lam.sum())
    if total < 1e-12:
        return 0.0
    return float((total**2) / float((lam**2).sum()))


def run_geometry(lab: Lab, prompt: str, k: int = 8) -> GeometryResult:
    ids = lab.ids(prompt)
    tokens = lab.toks(ids)
    seq = ids.shape[1]

    embs = lab.model.get_input_embeddings()(ids).detach().requires_grad_(True)
    logits = lab.model(inputs_embeds=embs).logits[0, -1]
    top = torch.topk(logits.detach(), max(k, 2))
    top1, top2 = int(top.indices[0]), int(top.indices[1])
    probs = torch.softmax(logits.detach(), dim=-1)
    margin = float(logits[top1] - logits[top2])

    # Gradient of the winner-vs-runner-up margin w.r.t. each token embedding.
    gm = torch.autograd.grad(logits[top1] - logits[top2], embs, retain_graph=True)[0][0]
    gnorm = gm.norm(dim=-1)  # [seq]

    # Effective dimension: SVD of the top-k logit x token Jacobian (norm-reduced).
    rows = []
    for j in range(min(k, top.indices.numel())):
        g = torch.autograd.grad(logits[int(top.indices[j])], embs, retain_graph=True)[0][0]
        rows.append(g.norm(dim=-1))
    Jm = torch.stack(rows)  # [k, seq]
    sv = torch.linalg.svdvals(Jm)
    eff_dim = round(_participation_ratio(sv), 3)

    # Token-deletion robustness (leave-one-out over the real model).
    per_token: list[dict[str, Any]] = []
    for i in range(seq):
        entry: dict[str, Any] = {
            "token": tokens[i],
            "flip_distance": round(margin / float(gnorm[i]), 4) if float(gnorm[i]) > 1e-9 else None,
        }
        if seq > 1:
            keep = torch.cat([ids[:, :i], ids[:, i + 1:]], dim=1)
            with torch.no_grad():
                lg = lab.model(keep).logits[0, -1]
            new_top = int(lg.argmax())
            new_margin = float(lg[top1] - lg.topk(2).values[1]) if new_top == top1 else None
            entry["deletion_flips"] = new_top != top1
            entry["deletion_new_top"] = lab.tok.decode([new_top])
            entry["margin_after_deletion"] = round(new_margin, 3) if new_margin is not None else None
        per_token.append(entry)

    robust = not any(t.get("deletion_flips") for t in per_token)
    # Load-bearing: largest margin collapse among non-flipping deletions.
    kept = [t for t in per_token if t.get("margin_after_deletion") is not None]
    load_bearing = min(kept, key=lambda t: t["margin_after_deletion"])["token"] if kept else None
    flippers = [t for t in per_token if t.get("deletion_flips")]
    if flippers:
        load_bearing = flippers[0]["token"]
    reachable = [t for t in per_token if t["flip_distance"] is not None]
    nearest = min(reachable, key=lambda t: t["flip_distance"])["token"] if reachable else None

    interp = [
        f'"{prompt}" -> {lab.tok.decode([top1])!r} over {lab.tok.decode([top2])!r}, margin {round(margin, 2)}.',
        (f'Robust: deleting any single token still predicts the same word.' if robust
         else f'Fragile: deleting "{(flippers[0]["token"]).strip()}" flips the prediction to '
              f'{flippers[0]["deletion_new_top"]!r}.'),
        f'The decision occupies an effectively {eff_dim}-dimensional slice of logit space '
        f'(participation ratio of the {min(k, sv.numel())}-logit Jacobian).',
        f'Nearest decision boundary lies along "{(nearest or "n/a").strip()}"; the most '
        f'load-bearing token is "{(load_bearing or "n/a").strip()}".',
    ]
    return GeometryResult(
        prompt=prompt, tokens=tokens, predicted=lab.tok.decode([top1]),
        runner_up=lab.tok.decode([top2]), predicted_prob=round(float(probs[top1]), 4),
        margin=round(margin, 3), effective_dimension=eff_dim, per_token=per_token,
        robust_to_deletion=robust, load_bearing_token=load_bearing,
        nearest_flip_token=nearest, interpretation=interp,
    )


# ─── 2. Confidence-vs-fragility calibration ─────────────────────────────────


@dataclass
class CalibrateResult:
    prompts: int
    #: Pearson r between softmax confidence and geometric robustness (margin).
    confidence_vs_margin_r: float
    #: Pearson r between confidence and min per-token flip distance.
    confidence_vs_flipdist_r: float
    #: confident (top decile) yet fragile (bottom-half robustness) cases.
    confident_but_fragile: list[dict[str, Any]]
    points: list[dict[str, Any]]
    interpretation: list[str]
    note: str = (
        "Novel question, not a novel method: does the model's stated confidence "
        "track how geometrically robust the decision actually is? r near 1 = "
        "calibrated to its own fragility; r near 0 = confidence is blind to it."
    )


CALIBRATION_PROMPTS = [
    "The Eiffel Tower is located in the city of",
    "The capital of Japan is",
    "The chemical symbol for gold is",
    "Two plus two equals",
    "The opposite of hot is",
    "The first president of the United States was",
    "Water is made of hydrogen and",
    "The largest planet in the solar system is",
    "A group of lions is called a",
    "The author of Romeo and Juliet is",
    "The square root of sixty-four is",
    "The color of a clear daytime sky is",
    "The freezing point of water in Celsius is",
    "The currency used in Japan is the",
]


def _pearson(x: list[float], y: list[float]) -> float:
    if len(x) < 2:
        return 0.0
    a, b = np.array(x), np.array(y)
    if a.std() < 1e-9 or b.std() < 1e-9:
        return 0.0
    return round(float(np.corrcoef(a, b)[0, 1]), 3)


def run_calibrate(lab: Lab, prompts: list[str] | None = None) -> CalibrateResult:
    prompts = prompts or CALIBRATION_PROMPTS
    points: list[dict[str, Any]] = []
    for p in prompts:
        g = run_geometry(lab, p, k=4)
        flips = [t["flip_distance"] for t in g.per_token if t["flip_distance"] is not None]
        deletion_flips = sum(1 for t in g.per_token if t.get("deletion_flips"))
        points.append({
            "prompt": p,
            "predicted": g.predicted,
            "confidence": g.predicted_prob,
            "margin": g.margin,
            "min_flip_distance": round(min(flips), 4) if flips else None,
            "deletion_flips": deletion_flips,
            "robust": g.robust_to_deletion,
        })

    conf = [pt["confidence"] for pt in points]
    r_margin = _pearson(conf, [pt["margin"] for pt in points])
    withflip = [pt for pt in points if pt["min_flip_distance"] is not None]
    r_flip = _pearson([pt["confidence"] for pt in withflip],
                      [pt["min_flip_distance"] for pt in withflip])

    conf_sorted = sorted(points, key=lambda pt: -pt["confidence"])
    cutoff = conf_sorted[max(0, len(conf_sorted) // 4)]["confidence"]
    median_margin = float(np.median([pt["margin"] for pt in points]))
    confident_but_fragile = [
        {"prompt": pt["prompt"], "predicted": pt["predicted"], "confidence": pt["confidence"],
         "margin": pt["margin"], "deletion_flips": pt["deletion_flips"]}
        for pt in points
        if pt["confidence"] >= cutoff and (not pt["robust"] or pt["margin"] < median_margin)
    ]

    interp = [
        f"Across {len(points)} prompts, confidence vs margin r = {r_margin}, "
        f"confidence vs flip-distance r = {r_flip}.",
        ("Confidence tracks robustness fairly well — the model's certainty is partly "
         "geometric." if r_margin >= 0.5 else
         "Confidence is a weak predictor of geometric robustness — the model can be "
         "confident and fragile at once."),
        (f"{len(confident_but_fragile)} high-confidence prediction(s) were geometrically "
         f"fragile (flip on deletion or below-median margin) — confidence did not warn of it."
         if confident_but_fragile else
         "No high-confidence prediction was geometrically fragile in this set."),
    ]
    return CalibrateResult(
        prompts=len(points), confidence_vs_margin_r=r_margin, confidence_vs_flipdist_r=r_flip,
        confident_but_fragile=confident_but_fragile, points=points, interpretation=interp,
    )


# ─── 3. Cross-layer concept transport ───────────────────────────────────────


@dataclass
class TransportResult:
    concept: str
    layers: int
    #: cosine(v_L, v_L') — is the concept the same direction at every depth?
    alignment: list[list[float]]
    mean_adjacent_alignment: float
    #: inject the mid-layer concept vector at each layer; KL(steered || base)
    #: and probability mass moved onto the concept's own promoted tokens.
    functional_transport: list[dict[str, Any]]
    source_layer: int
    #: what the source vector itself promotes through the readout — the
    #: (principled, not hand-picked) target set for concept_mass_gain.
    concept_tokens: list[str]
    interpretation: list[str]
    note: str = (
        "Concept vectors (concept-prompt minus control-prompt residuals) built at "
        "every layer. Alignment asks if the direction is shared across depth; "
        "functional transport asks if one layer's direction still DOES something "
        "when injected elsewhere. Residual stream shares one basis across GPT-2 "
        "layers, so cross-layer injection is well-defined."
    )


def _cosine(a: torch.Tensor, b: torch.Tensor) -> float:
    na, nb = a.norm(), b.norm()
    if na < 1e-9 or nb < 1e-9:
        return 0.0
    return float((a @ b) / (na * nb))


def run_transport(lab: Lab, concept: str = "the ocean",
                  neutral: str = "The weather today is") -> TransportResult:
    L = lab.n_layer
    vecs = [concept_vector(lab, concept, layer) for layer in range(L)]

    alignment = [[round(_cosine(vecs[i], vecs[j]), 3) for j in range(L)] for i in range(L)]
    adj = [alignment[i][i + 1] for i in range(L - 1)]
    mean_adj = round(float(np.mean(adj)), 3) if adj else 0.0

    # Functional transport: inject the mid-layer vector at each layer, measure
    # both KL (total disturbance) and the probability mass moved onto the
    # concept's OWN promoted tokens (directional effect). The concept-promoted
    # tokens come from reading the source vector through the model's readout
    # (logit lens on the raw direction), so the target set is principled, not
    # hand-picked.
    src = L // 2
    unit = vecs[src] / (vecs[src].norm() + 1e-9)
    alpha = 14.0
    concept_token_ids = torch.topk(lab.ln_f(vecs[src]) @ lab.unembed.T, 40).indices.tolist()
    concept_words = [lab.tok.decode([i]).strip() for i in concept_token_ids[:10]]
    ids = lab.ids(neutral)
    with torch.no_grad():
        base = torch.softmax(lab.model(ids).logits[0, -1], dim=-1)
    base_mass = float(base[concept_token_ids].sum())

    functional: list[dict[str, Any]] = []
    for layer in range(L):
        def hook(_m, _i, output, *, _u=unit):
            output[0].add_(alpha * _u)  # all positions, like the steering experiment
            return output
        h = lab.blocks[layer].register_forward_hook(hook)
        with torch.no_grad():
            steered = torch.softmax(lab.model(ids).logits[0, -1], dim=-1)
        h.remove()
        kl = float((steered * (steered.clamp_min(1e-12).log() - base.clamp_min(1e-12).log())).sum())
        concept_gain = float(steered[concept_token_ids].sum()) - base_mass
        functional.append({"inject_layer": layer, "kl_from_base": round(kl, 4),
                           "concept_mass_gain": round(concept_gain, 4),
                           "top_token": lab.tok.decode([int(steered.argmax())])})

    peak = max(functional, key=lambda f: f["concept_mass_gain"])
    if peak["concept_mass_gain"] < 1e-3:  # degenerate direction: fall back to disturbance
        peak = max(functional, key=lambda f: f["kl_from_base"])
    interp = [
        f'Concept "{concept}" as a direction at each of {L} layers; the source vector '
        f"itself promotes: {', '.join(concept_words[:6])}.",
        (f"Adjacent layers are highly aligned (mean cosine {mean_adj}) — the concept "
         f"is nearly one shared direction across depth."
         if mean_adj >= 0.6 else
         f"Adjacent-layer alignment is moderate (mean cosine {mean_adj}) — the concept "
         f"rotates as it moves up the stack."),
        f"Injecting layer {src}'s vector lands hardest at layer {peak['inject_layer']}: "
        f"concept-token mass {'+' if peak['concept_mass_gain'] >= 0 else ''}{peak['concept_mass_gain']}, "
        f"KL {peak['kl_from_base']}, next token {peak['top_token']!r}.",
    ]
    return TransportResult(
        concept=concept, layers=L, alignment=alignment, mean_adjacent_alignment=mean_adj,
        functional_transport=functional, source_layer=src, concept_tokens=concept_words,
        interpretation=interp,
    )


# ─── CLI ────────────────────────────────────────────────────────────────────


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("probe", choices=["geometry", "calibrate", "transport", "all"])
    ap.add_argument("--model", default="gpt2")
    ap.add_argument("--prompt", default="The Eiffel Tower is located in the city of")
    ap.add_argument("--concept", default="the ocean")
    ap.add_argument("--out", default="probes.json")
    args = ap.parse_args()

    t0 = time.time()
    sys.stderr.write(f"[probes] loading {args.model}...\n")
    lab = Lab(args.model)

    if args.probe == "all":
        sys.stderr.write("[probes] 1/3 geometry...\n")
        geo = run_geometry(lab, args.prompt)
        sys.stderr.write("[probes] 2/3 calibrate...\n")
        cal = run_calibrate(lab)
        sys.stderr.write("[probes] 3/3 transport...\n")
        tr = run_transport(lab, args.concept)
        payload = {"model": args.model, "geometry": asdict(geo),
                   "calibrate": asdict(cal), "transport": asdict(tr)}
        with open(args.out, "w") as f:
            json.dump(payload, f, indent=2)
        sys.stderr.write(f"[probes] wrote {args.out} in {time.time() - t0:.1f}s\n")
        for name, res in [("GEOMETRY", geo), ("CALIBRATE", cal), ("TRANSPORT", tr)]:
            sys.stderr.write(f"\n=== {name} ===\n")
            for line in res.interpretation:
                sys.stderr.write(f"  - {line}\n")
        return

    res = {"geometry": run_geometry, "calibrate": run_calibrate, "transport": run_transport}[args.probe]
    out = res(lab, args.prompt) if args.probe == "geometry" else (
        res(lab, args.concept) if args.probe == "transport" else res(lab))
    json.dump(asdict(out), sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
