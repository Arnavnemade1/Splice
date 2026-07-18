#!/usr/bin/env python3
"""
Splice Model Mind Lab — see a real model think.

Runs the interpretability experiments described in lab/RESEARCH.md on a real
open-weights model (GPT-2 class, CPU-friendly), from scratch — every number is
computed in this one file:

  jacobian   The Jacobian space: d logit / d input-embedding. Per-token
             saliency for the predicted token, plus an SVD of the token x logit
             Jacobian — the model-side sibling of Splice's JSpace.ts spectrum.
  lens       Logit lens: decode the residual stream after every layer and
             watch the answer crystallize (planning made visible).
  patch      Activation patching (causal tracing) on the classic IOI task:
             swap clean activations into a corrupted run, cell by
             (layer x position), and map where the computation lives.
  steer      Concept injection (the protocol behind Anthropic's introspection
             experiments): build a concept vector from contrastive prompts,
             inject it at a layer across a strength sweep, and watch the
             "sweet spot" -> incoherence arc.
  attention  Induction-head scan: find the [A][B]...[A] -> [B] heads that
             implement in-context learning, by prefix-matching score.
  report     All of the above -> one self-contained HTML report.

Honest scope: this operates on models whose weights you hold locally. It makes
no claim about any hosted model's internals — that line (documented across the
Splice codebase) is unchanged.

Usage:
  python3 mindlab.py report                       # defaults: gpt2, built-in prompts
  python3 mindlab.py report --model distilgpt2 --prompt "The capital of France is"
  python3 mindlab.py jacobian --prompt "..."      # single experiment, JSON to stdout
  python3 mindlab.py steer --concept "the ocean" --layer 6

Dependencies (lab/requirements.txt): torch, transformers, numpy.
"""

from __future__ import annotations

import argparse
import html
import json
import math
import sys
import time
from dataclasses import asdict, dataclass, field
from typing import Any

try:
    import numpy as np
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
except ImportError as exc:  # pragma: no cover
    sys.stderr.write(
        f"Missing dependency: {exc.name}. Install with:\n"
        "  python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt\n"
    )
    sys.exit(2)

torch.manual_seed(0)

# ─── model plumbing ──────────────────────────────────────────────────────────


class Lab:
    """A loaded model plus the handful of internals every experiment needs."""

    def __init__(self, model_name: str = "gpt2"):
        self.model_name = model_name
        self.tok = AutoTokenizer.from_pretrained(model_name)
        # Eager attention materializes attention weights (SDPA returns None
        # for output_attentions) — required by the induction-head scan.
        self.model = AutoModelForCausalLM.from_pretrained(model_name, attn_implementation="eager")
        self.model.eval()
        cfg = self.model.config
        self.n_layer = cfg.n_layer if hasattr(cfg, "n_layer") else cfg.num_hidden_layers
        self.n_head = cfg.n_head if hasattr(cfg, "n_head") else cfg.num_attention_heads
        # GPT-2 family internals used by lens/patch/steer hooks.
        self.blocks = self.model.transformer.h
        self.ln_f = self.model.transformer.ln_f
        self.unembed = self.model.get_output_embeddings().weight  # [vocab, d]

    def ids(self, prompt: str) -> torch.Tensor:
        return self.tok(prompt, return_tensors="pt").input_ids

    def toks(self, ids: torch.Tensor) -> list[str]:
        return [self.tok.decode([t]) for t in ids[0].tolist()]

    def decode_head(self, resid: torch.Tensor) -> torch.Tensor:
        """Residual-stream vector -> logits, through the model's own readout."""
        return self.ln_f(resid) @ self.unembed.T


# ─── 1. The Jacobian space (saliency + sensitivity SVD) ─────────────────────


@dataclass
class JacobianResult:
    prompt: str
    tokens: list[str]
    predicted: str
    predicted_prob: float
    top_logits: list[dict[str, Any]]
    #: L2 norm of d logit(pred) / d emb(token) — total leverage per input token.
    saliency: list[float]
    #: input x gradient — signed first-order contribution per token.
    input_x_grad: list[float]
    #: SVD of the [top-k logits x tokens] Jacobian-norm matrix.
    dominant_token_mix: list[dict[str, float]]
    dominant_logit_mix: list[dict[str, float]]
    dominant_mode_energy: float
    note: str = (
        "d logit / d input-embedding, computed by autograd — the model-side "
        "sibling of Splice's exact scorer Jacobian (see RESEARCH.md §1.4)."
    )


def run_jacobian(lab: Lab, prompt: str, k: int = 6) -> JacobianResult:
    ids = lab.ids(prompt)
    embs = lab.model.get_input_embeddings()(ids).detach().requires_grad_(True)
    logits = lab.model(inputs_embeds=embs).logits[0, -1]
    probs = torch.softmax(logits.detach(), dim=-1)
    top = torch.topk(logits.detach(), k)
    pred_id = int(top.indices[0])

    # Saliency for the predicted token.
    grad_pred = torch.autograd.grad(logits[pred_id], embs, retain_graph=True)[0][0]
    saliency = grad_pred.norm(dim=-1)
    ixg = (grad_pred * embs[0]).sum(dim=-1)

    # Token x logit Jacobian (norm-reduced over the embedding dimension).
    rows = []
    for j in range(k):
        g = torch.autograd.grad(logits[int(top.indices[j])], embs, retain_graph=True)[0][0]
        rows.append(g.norm(dim=-1))
    J = torch.stack(rows)  # [k, seq]
    U, S, Vh = torch.linalg.svd(J, full_matrices=False)
    energy = float((S[0] ** 2 / (S**2).sum()).item()) if S.numel() else 0.0
    tokens = lab.toks(ids)
    top_names = [lab.tok.decode([int(i)]) for i in top.indices]

    return JacobianResult(
        prompt=prompt,
        tokens=tokens,
        predicted=top_names[0],
        predicted_prob=round(float(probs[pred_id]), 4),
        top_logits=[
            {"token": top_names[j], "logit": round(float(top.values[j]), 3),
             "prob": round(float(probs[int(top.indices[j])]), 4)}
            for j in range(k)
        ],
        saliency=[round(float(v), 4) for v in saliency],
        input_x_grad=[round(float(v), 4) for v in ixg],
        dominant_token_mix=[
            {"token": tokens[i], "weight": round(float(Vh[0, i]), 3)} for i in range(len(tokens))
        ],
        dominant_logit_mix=[
            {"token": top_names[j], "weight": round(float(U[j, 0]), 3)} for j in range(k)
        ],
        dominant_mode_energy=round(energy, 3),
    )


# ─── 2. Logit lens (watch the answer crystallize) ────────────────────────────


@dataclass
class LensLayer:
    layer: int
    top: list[dict[str, Any]]
    answer_prob: float
    answer_rank: int


@dataclass
class LensResult:
    prompt: str
    answer: str
    crystallized_at: int | None
    layers: list[LensLayer]
    note: str = (
        "Residual stream after each block, decoded through the model's own "
        "final layer-norm + unembedding (nostalgebraist's logit lens; "
        "RESEARCH.md §1.5). 'Crystallized' = first layer where the final "
        "answer is already top-1."
    )


def run_lens(lab: Lab, prompt: str) -> LensResult:
    ids = lab.ids(prompt)
    with torch.no_grad():
        out = lab.model(ids, output_hidden_states=True)
        answer_id = int(out.logits[0, -1].argmax())
        answer = lab.tok.decode([answer_id])
        layers: list[LensLayer] = []
        crystallized: int | None = None
        final_index = len(out.hidden_states) - 1
        for layer_index, h in enumerate(out.hidden_states):  # 0 = embeddings
            # transformers applies ln_f to the FINAL hidden_states entry
            # already — re-applying it would distort the last row.
            logits = (h[0, -1] @ lab.unembed.T) if layer_index == final_index else lab.decode_head(h[0, -1])
            probs = torch.softmax(logits, dim=-1)
            top = torch.topk(probs, 3)
            rank = int((probs > probs[answer_id]).sum()) + 1
            if rank == 1 and crystallized is None and layer_index > 0:
                crystallized = layer_index
            layers.append(LensLayer(
                layer=layer_index,
                top=[{"token": lab.tok.decode([int(i)]), "prob": round(float(p), 4)}
                     for p, i in zip(top.values, top.indices)],
                answer_prob=round(float(probs[answer_id]), 4),
                answer_rank=rank,
            ))
    return LensResult(prompt=prompt, answer=answer, crystallized_at=crystallized, layers=layers)


# ─── 3. Activation patching (causal tracing on IOI) ─────────────────────────


@dataclass
class PatchResult:
    clean: str
    corrupt: str
    answer: str
    foil: str
    clean_logit_diff: float
    corrupt_logit_diff: float
    tokens: list[str]
    #: recovery[layer][position] in [~0, ~1]: how much of the clean answer
    #: returns when this single cell is patched from the clean run.
    recovery: list[list[float]]
    best: dict[str, Any]
    note: str = (
        "Residual-stream activation patching on the indirect-object task "
        "(RESEARCH.md §1.3). Metric: normalized recovery of the "
        "logit(answer) - logit(foil) difference."
    )


def run_patch(lab: Lab, clean: str, corrupt: str, answer: str, foil: str) -> PatchResult:
    clean_ids, corrupt_ids = lab.ids(clean), lab.ids(corrupt)
    if clean_ids.shape != corrupt_ids.shape:
        raise SystemExit("patch: clean and corrupt prompts must tokenize to the same length")
    a_id = lab.tok.encode(answer)[0]
    f_id = lab.tok.encode(foil)[0]

    def logit_diff(logits: torch.Tensor) -> float:
        return float(logits[0, -1, a_id] - logits[0, -1, f_id])

    with torch.no_grad():
        clean_out = lab.model(clean_ids, output_hidden_states=True)
        clean_hs = clean_out.hidden_states  # [L+1] x [1, seq, d]
        clean_diff = logit_diff(clean_out.logits)
        corrupt_diff = logit_diff(lab.model(corrupt_ids).logits)

    seq = clean_ids.shape[1]
    denom = clean_diff - corrupt_diff or 1e-9
    recovery: list[list[float]] = []
    for layer in range(lab.n_layer):
        row: list[float] = []
        for pos in range(seq):
            patch_h = clean_hs[layer + 1][:, pos].clone()

            def hook(_module, _inputs, output, *, _p=pos, _h=patch_h):
                output[0][:, _p] = _h
                return output

            handle = lab.blocks[layer].register_forward_hook(hook)
            with torch.no_grad():
                patched_diff = logit_diff(lab.model(corrupt_ids).logits)
            handle.remove()
            row.append(round((patched_diff - corrupt_diff) / denom, 3))
        recovery.append(row)

    flat = [(r, l, p) for l, row in enumerate(recovery) for p, r in enumerate(row)]
    best_r, best_l, best_p = max(flat)
    tokens = lab.toks(clean_ids)
    return PatchResult(
        clean=clean, corrupt=corrupt, answer=answer, foil=foil,
        clean_logit_diff=round(clean_diff, 3), corrupt_logit_diff=round(corrupt_diff, 3),
        tokens=tokens, recovery=recovery,
        best={"layer": best_l, "position": best_p, "token": tokens[best_p], "recovery": best_r},
    )


# ─── 4. Concept injection / steering (strength sweep) ────────────────────────


@dataclass
class SteerResult:
    concept: str
    layer: int
    vector_norm: float
    baseline_prompt: str
    sweep: list[dict[str, Any]]
    note: str = (
        "Concept vector = mean residual difference between concept and control "
        "prompts at one layer, injected during generation at each strength "
        "(the protocol behind Anthropic's introspection experiments; "
        "RESEARCH.md §1.2). Watch for the sweet spot -> incoherence arc."
    )


CONCEPT_CONTRASTS: dict[str, tuple[list[str], list[str]]] = {
    "the ocean": (
        ["The ocean stretched to the horizon, waves crashing on the shore.",
         "Salt spray and seafoam; the tide pulled at the sand.",
         "Deep beneath the sea, whales sang across the dark water."],
        ["The committee reviewed the quarterly budget spreadsheet.",
         "He parked the car and walked into the office building.",
         "The recipe called for two cups of flour and an egg."],
    ),
    "shouting": (
        ["HE SCREAMED AT THE TOP OF HIS LUNGS. EVERYONE HEARD IT.",
         "THE CROWD ROARED, LOUD AND WILD AND DEAFENING.",
         "SHE YELLED THE ANSWER AS LOUD AS SHE COULD."],
        ["He mentioned it quietly during the meeting.",
         "The library was calm and silent that afternoon.",
         "She whispered the answer so nobody else would hear."],
    ),
}


def concept_vector(lab: Lab, concept: str, layer: int) -> torch.Tensor:
    pos_set, neg_set = CONCEPT_CONTRASTS.get(
        concept,
        ([f"I keep thinking about {concept}. {concept.capitalize()} is everywhere.",
          f"A story about {concept}: it filled every thought.",
          f"{concept.capitalize()} again — always {concept}."],
         ["I keep thinking about ordinary things. Nothing in particular.",
          "A story about a plain afternoon: unremarkable in every way.",
          "Routine again — always routine."]),
    )
    def mean_resid(prompts: list[str]) -> torch.Tensor:
        acc = []
        with torch.no_grad():
            for p in prompts:
                hs = lab.model(lab.ids(p), output_hidden_states=True).hidden_states
                # Last-token residual: the position where the sentence's
                # accumulated meaning lives (sharper than a positional mean).
                acc.append(hs[layer + 1][0, -1])
        return torch.stack(acc).mean(dim=0)
    return mean_resid(pos_set) - mean_resid(neg_set)


def run_steer(lab: Lab, concept: str, layer: int, alphas: list[float],
              baseline_prompt: str = "I woke up this morning and", max_new: int = 36) -> SteerResult:
    vec = concept_vector(lab, concept, layer)
    unit = vec / (vec.norm() + 1e-9)
    sweep: list[dict[str, Any]] = []
    for alpha in alphas:
        def hook(_module, _inputs, output, *, _a=alpha):
            output[0].add_(_a * unit)
            return output

        handle = lab.blocks[layer].register_forward_hook(hook) if alpha != 0 else None
        torch.manual_seed(7)
        prompt_ids = lab.ids(baseline_prompt)
        with torch.no_grad():
            out_ids = lab.model.generate(
                prompt_ids, attention_mask=torch.ones_like(prompt_ids),
                max_new_tokens=max_new, do_sample=True,
                temperature=0.9, top_k=40, pad_token_id=lab.tok.eos_token_id,
            )
        if handle:
            handle.remove()
        text = lab.tok.decode(out_ids[0][lab.ids(baseline_prompt).shape[1]:])
        sweep.append({"alpha": alpha, "text": text.strip().replace("\n", " ")})
    return SteerResult(concept=concept, layer=layer, vector_norm=round(float(vec.norm()), 2),
                       baseline_prompt=baseline_prompt, sweep=sweep)


# ─── 5. Induction heads ─────────────────────────────────────────────────────


@dataclass
class AttentionResult:
    sequence_length: int
    top_heads: list[dict[str, Any]]
    best_head_grid: list[list[float]]
    best_head: str
    note: str = (
        "Induction heads implement [A][B] ... [A] -> [B] (Olsson et al.; "
        "RESEARCH.md §1.5). Score = mean attention from each second-half "
        "token back to the token AFTER its previous occurrence."
    )


def run_attention(lab: Lab, period: int = 25) -> AttentionResult:
    g = torch.Generator().manual_seed(1)
    base = torch.randint(1000, 8000, (period,), generator=g)
    ids = torch.cat([base, base]).unsqueeze(0)
    with torch.no_grad():
        att = lab.model(ids, output_attentions=True).attentions  # [L] x [1, H, T, T]
    total = 2 * period
    scores: list[tuple[float, int, int]] = []
    for layer, a in enumerate(att):
        for head in range(lab.n_head):
            m = a[0, head]
            score = float(torch.stack([m[t, t - period + 1] for t in range(period, total)]).mean())
            scores.append((score, layer, head))
    scores.sort(reverse=True)
    best_score, best_layer, best_head = scores[0]
    grid = att[best_layer][0, best_head]
    step = max(1, total // 50)
    grid_small = [[round(float(grid[i, j]), 3) for j in range(0, total, step)]
                  for i in range(0, total, step)]
    return AttentionResult(
        sequence_length=total,
        top_heads=[{"head": f"L{l}.H{h}", "induction_score": round(s, 3)} for s, l, h in scores[:5]],
        best_head_grid=grid_small,
        best_head=f"L{best_layer}.H{best_head} (score {best_score:.3f})",
    )


# ─── HTML report ────────────────────────────────────────────────────────────


def _heat(value: float, lo: float, hi: float) -> str:
    """Light-theme heat: white -> indigo, saturating at hi."""
    t = 0.0 if hi <= lo else max(0.0, min(1.0, (value - lo) / (hi - lo)))
    return f"background:rgba(79,70,229,{0.04 + 0.86 * t:.3f});color:{'#fff' if t > 0.55 else '#1f2937'}"


def render_html(model_name: str, jac: JacobianResult, lens: LensResult,
                patch: PatchResult, steer: SteerResult, attn: AttentionResult,
                elapsed_s: float) -> str:
    e = html.escape
    css = """
    :root{--ink:#111827;--mut:#6b7280;--line:#e5e7eb;--brand:#4f46e5;--bg:#fafafa}
    *{box-sizing:border-box;margin:0}body{font:15px/1.6 -apple-system,'Segoe UI',sans-serif;
    color:var(--ink);background:var(--bg);padding:48px 20px}main{max-width:980px;margin:0 auto}
    h1{font-size:26px;letter-spacing:-.02em}h2{font-size:17px;margin:44px 0 6px}
    .sub{color:var(--mut);font-size:13.5px}.note{color:var(--mut);font-size:12.5px;margin:6px 0 12px;max-width:76ch}
    .card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin-top:10px;overflow-x:auto}
    .chips{display:flex;flex-wrap:wrap;gap:4px}.chip{font-family:ui-monospace,monospace;font-size:12.5px;
    padding:3px 7px;border-radius:6px;border:1px solid var(--line);white-space:pre}
    table{border-collapse:collapse;font-size:13px;width:100%}td,th{padding:4px 9px;text-align:left;border-bottom:1px solid var(--line)}
    th{color:var(--mut);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em}
    .mono{font-family:ui-monospace,monospace;white-space:pre}.grid{display:grid;gap:1px}
    .cell{width:100%;aspect-ratio:1;border-radius:1px}.bar{height:7px;border-radius:99px;background:var(--brand)}
    .barbox{background:var(--line);border-radius:99px;min-width:120px}.tag{color:var(--brand);font-weight:600}
    footer{margin-top:52px;color:var(--mut);font-size:12.5px;border-top:1px solid var(--line);padding-top:14px;max-width:80ch}
    """
    parts: list[str] = [f"<style>{css}</style><main>"]
    parts.append(
        f"<h1>Model Mind Lab</h1><div class='sub'>model <b>{e(model_name)}</b> · "
        f"{time.strftime('%Y-%m-%d %H:%M')} · {elapsed_s:.1f}s · every number computed "
        f"from the weights by <span class='mono'>lab/mindlab.py</span></div>")

    # 1. Jacobian
    parts.append("<h2>1 · The Jacobian space — which words carry the prediction</h2>")
    parts.append(f"<div class='note'>{e(jac.note)}</div><div class='card'>")
    parts.append(f"<div class='sub'>prompt → predicted <b class='tag'>{e(jac.predicted)}</b> "
                 f"(p={jac.predicted_prob})</div><div class='chips' style='margin-top:8px'>")
    hi = max(jac.saliency) or 1.0
    for tok, s in zip(jac.tokens, jac.saliency):
        parts.append(f"<span class='chip' title='saliency {s}' style='{_heat(s, 0, hi)}'>{e(tok)}</span>")
    parts.append("</div><table style='margin-top:12px'><tr><th>token</th><th>‖∂logit/∂emb‖</th><th>input×grad</th></tr>")
    for tok, s, g in zip(jac.tokens, jac.saliency, jac.input_x_grad):
        parts.append(f"<tr><td class='mono'>{e(tok)}</td><td>{s}</td><td>{g}</td></tr>")
    tmix = ", ".join(f"{e(t['token'])} ({t['weight']})" for t in
                     sorted(jac.dominant_token_mix, key=lambda x: -abs(x['weight']))[:4])
    lmix = ", ".join(f"{e(t['token'])} ({t['weight']})" for t in jac.dominant_logit_mix[:4])
    parts.append(f"</table><div class='note' style='margin-top:10px'>Dominant sensitivity mode "
                 f"(energy {jac.dominant_mode_energy}): input mix {e(tmix)} → output mix {e(lmix)} — "
                 f"the same SVD Splice runs over its scorer Jacobian.</div></div>")

    # 2. Logit lens
    parts.append("<h2>2 · Logit lens — watching the answer crystallize</h2>")
    parts.append(f"<div class='note'>{e(lens.note)}</div><div class='card'>")
    cryst = f"layer {lens.crystallized_at}" if lens.crystallized_at is not None else "only at the end"
    parts.append(f"<div class='sub'>answer <b class='tag'>{e(lens.answer)}</b> crystallizes at <b>{cryst}</b> "
                 f"of {len(lens.layers) - 1}</div>")
    parts.append("<table style='margin-top:8px'><tr><th>layer</th><th>top tokens (via final readout)</th><th>p(answer)</th></tr>")
    for L in lens.layers:
        tops = " · ".join(f"{e(t['token'])} {t['prob']}" for t in L.top)
        w = int(min(1.0, L.answer_prob) * 100)
        name = "emb" if L.layer == 0 else str(L.layer)
        parts.append(f"<tr><td>{name}</td><td class='mono'>{tops}</td>"
                     f"<td><div class='barbox'><div class='bar' style='width:{max(w,1)}%'></div></div></td></tr>")
    parts.append("</table></div>")

    # 3. Patching
    parts.append("<h2>3 · Activation patching — where the computation lives</h2>")
    parts.append(f"<div class='note'>{e(patch.note)}</div><div class='card'>")
    parts.append(f"<div class='sub'>clean “{e(patch.clean)}” → <b class='tag'>{e(patch.answer)}</b> · "
                 f"corrupt “{e(patch.corrupt)}” → <b>{e(patch.foil)}</b> · strongest cell: layer "
                 f"{patch.best['layer']}, token <span class='mono'>{e(patch.best['token'])}</span> "
                 f"(recovery {patch.best['recovery']})</div>")
    ncols = len(patch.tokens)
    parts.append(f"<div class='grid' style='grid-template-columns:56px repeat({ncols},minmax(14px,1fr));margin-top:12px'>")
    parts.append("<div></div>" + "".join(
        f"<div class='sub mono' style='font-size:9.5px;writing-mode:vertical-rl;transform:rotate(180deg)'>{e(t)}</div>"
        for t in patch.tokens))
    for layer_index, row in enumerate(patch.recovery):
        parts.append(f"<div class='sub' style='font-size:10.5px'>L{layer_index}</div>")
        for r in row:
            parts.append(f"<div class='cell' title='L{layer_index} r={r}' style='{_heat(r, 0, 1)}'></div>")
    parts.append("</div></div>")

    # 4. Steering
    parts.append("<h2>4 · Concept injection — pushing a thought into the stream</h2>")
    parts.append(f"<div class='note'>{e(steer.note)}</div><div class='card'>")
    parts.append(f"<div class='sub'>concept <b class='tag'>{e(steer.concept)}</b> at layer {steer.layer} · "
                 f"‖v‖={steer.vector_norm} · prompt “{e(steer.baseline_prompt)}”</div>")
    parts.append("<table style='margin-top:8px'><tr><th>strength α</th><th>continuation</th></tr>")
    for s in steer.sweep:
        parts.append(f"<tr><td><b>{s['alpha']}</b></td><td>{e(s['text'])}</td></tr>")
    parts.append("</table></div>")

    # 5. Induction
    parts.append("<h2>5 · Induction heads — the in-context learning mechanism</h2>")
    parts.append(f"<div class='note'>{e(attn.note)}</div><div class='card'>")
    parts.append("<div class='sub'>top heads: " + " · ".join(
        f"<b>{e(h['head'])}</b> {h['induction_score']}" for h in attn.top_heads) + "</div>")
    n = len(attn.best_head_grid)
    parts.append(f"<div class='sub' style='margin-top:10px'>attention pattern of {e(attn.best_head)} — "
                 "the off-diagonal stripe is induction:</div>")
    parts.append(f"<div class='grid' style='grid-template-columns:repeat({n},minmax(5px,1fr));max-width:420px;margin-top:8px'>")
    for row in attn.best_head_grid:
        for v in row:
            parts.append(f"<div class='cell' style='{_heat(v, 0, 0.4)}'></div>")
    parts.append("</div></div>")

    parts.append(
        "<footer>Every experiment here runs on locally held open weights; nothing probes a hosted "
        "model's internals. Methods and sources: <span class='mono'>lab/RESEARCH.md</span> — attribution "
        "graphs &amp; circuit tracing, concept injection (introspection), persona vectors, Jacobian "
        "scopes, causal tracing, logit lens, induction heads.</footer></main>")
    return "<!doctype html><meta charset='utf-8'><title>Model Mind Lab</title>" + "".join(parts)


# ─── CLI ────────────────────────────────────────────────────────────────────

DEFAULT_PROMPT = "The Eiffel Tower is located in the city of"
IOI_CLEAN = "When John and Mary went to the store, John gave a drink to"
IOI_CORRUPT = "When John and Mary went to the store, Mary gave a drink to"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("experiment", choices=["report", "jacobian", "lens", "patch", "steer", "attention"])
    ap.add_argument("--model", default="gpt2")
    ap.add_argument("--prompt", default=DEFAULT_PROMPT)
    ap.add_argument("--clean", default=IOI_CLEAN)
    ap.add_argument("--corrupt", default=IOI_CORRUPT)
    ap.add_argument("--answer", default=" Mary")
    ap.add_argument("--foil", default=" John")
    ap.add_argument("--concept", default="the ocean")
    ap.add_argument("--layer", type=int, default=None, help="steering layer (default n_layer//2)")
    ap.add_argument("--alphas", default="0,6,10,16,26")
    ap.add_argument("--out", default="mindlab-report.html")
    args = ap.parse_args()

    t0 = time.time()
    sys.stderr.write(f"[mindlab] loading {args.model}…\n")
    lab = Lab(args.model)
    layer = args.layer if args.layer is not None else lab.n_layer // 2
    alphas = [float(a) for a in args.alphas.split(",")]

    if args.experiment == "report":
        sys.stderr.write("[mindlab] 1/5 jacobian…\n")
        jac = run_jacobian(lab, args.prompt)
        sys.stderr.write("[mindlab] 2/5 logit lens…\n")
        lens = run_lens(lab, args.prompt)
        sys.stderr.write("[mindlab] 3/5 activation patching…\n")
        patch = run_patch(lab, args.clean, args.corrupt, args.answer, args.foil)
        sys.stderr.write("[mindlab] 4/5 concept injection…\n")
        steer = run_steer(lab, args.concept, layer, alphas)
        sys.stderr.write("[mindlab] 5/5 induction heads…\n")
        attn = run_attention(lab)
        html_text = render_html(args.model, jac, lens, patch, steer, attn, time.time() - t0)
        with open(args.out, "w") as f:
            f.write(html_text)
        with open(args.out.replace(".html", ".json"), "w") as f:
            json.dump({"model": args.model, "jacobian": asdict(jac), "lens": asdict(lens),
                       "patch": asdict(patch), "steer": asdict(steer), "attention": asdict(attn)},
                      f, indent=2)
        sys.stderr.write(f"[mindlab] report → {args.out} (+ .json) in {time.time() - t0:.1f}s\n")
        return

    result: Any
    if args.experiment == "jacobian":
        result = run_jacobian(lab, args.prompt)
    elif args.experiment == "lens":
        result = run_lens(lab, args.prompt)
    elif args.experiment == "patch":
        result = run_patch(lab, args.clean, args.corrupt, args.answer, args.foil)
    elif args.experiment == "steer":
        result = run_steer(lab, args.concept, layer, alphas)
    else:
        result = run_attention(lab)
    json.dump(asdict(result), sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
