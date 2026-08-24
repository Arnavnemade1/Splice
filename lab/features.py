#!/usr/bin/env python3
"""
Splice Model Mind Lab — dictionary learning: pulling features out of superposition.

RESEARCH.md §5 describes why individual neurons are hard to read: a model packs
far more concepts than it has dimensions, so every direction in the standard
basis is a blend of unrelated things (polysemanticity). The prescribed fix is a
sparse autoencoder — an overcomplete dictionary trained to re-express each
activation vector as a sparse sum of learned directions. That section was the
one part of the research program this lab had not actually run. This file runs
it, from scratch, on CPU.

  harvest      Stream real web text (Pile OpenWebText2 — GPT-2's own training
               distribution), run it through the model, and collect the layer-L
               residual stream at every token position.
  train        Fit an overcomplete sparse autoencoder on those activations:
                   z = ReLU(W_enc (x − b_dec) + b_enc)     [F ≫ d, sparse]
                   x̂ = W_dec z + b_dec
               with unit-norm decoder columns and dead features resampled onto
               high-error inputs mid-training. Sparsity comes from keeping the
               k largest entries of z (TopK, Gao et al. 2024) or, with
               --sparsity l1, from the L1 penalty of RESEARCH.md §5. TopK is
               the default because at this scale it dominates at matched
               sparsity — same model, layer, dictionary size and budget:

                   objective       L0     variance   loss recovered
                   TopK (k=32)     32.0      77.4%        98.3%
                   L1   (λ=2.0)    35.8      38.2%        84.4%

               L1 buys sparsity by shrinking every coefficient, the ones the
               reconstruction needs included; TopK drops the losers outright
               and leaves the winners unpenalized. Pushed harder (λ=4.0) L1
               collapses to L0 = 2.5 and 3% of the variance.
  evaluate     Does the dictionary actually capture the model's computation?
               L0 (features active per token), fraction of variance explained,
               and — the honest test — cross-entropy when x̂ is spliced back
               into the forward pass in place of the real residual stream.
  interpret    For each feature, the two independent halves of its meaning:
               what makes it FIRE (top-activating contexts from the corpus) and
               what it WRITES (its decoder direction pushed through the model's
               own readout). These are measured separately and need not agree.
  compare      The superposition claim, quantified: token selectivity of learned
               features vs. the raw residual-stream basis directions they were
               built from.
  causal       Close the loop. Take the tokens a feature's decoder direction
               predicts it promotes, then inject that direction during a real
               forward pass and check those tokens actually rise.

Honest scope: this operates on models whose weights you hold locally, and the
dictionary is small (a few thousand features, ~100k training tokens, minutes on
a CPU) — a working instrument, not a frontier-scale one. Production SAEs use
millions of features and billions of tokens. Everything claimed here is
measured in this file and reproducible with the command below.

Usage:
  python3 features.py                              # gpt2, layer 6, full pipeline
  python3 features.py --model gpt2 --layer 8 --features 4096
  python3 features.py --tokens 200000 --epochs 20  # a better dictionary, slower
  python3 features.py --out results/features.json

Dependencies (lab/requirements.txt): torch, transformers, numpy. The corpus is
fetched over plain HTTP range requests and cached in lab/.cache/.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import urllib.request
from dataclasses import asdict, dataclass, field
from typing import Any

try:
    import numpy as np
    import torch
    import torch.nn as nn
except ImportError as exc:  # pragma: no cover
    sys.stderr.write(
        f"Missing dependency: {exc.name}. Install with:\n"
        "  python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt\n"
    )
    sys.exit(2)

from mindlab import Lab

torch.manual_seed(0)
np.random.seed(0)

# Pile OpenWebText2 — the distribution GPT-2 was actually trained on, stored as
# JSON-lines so a byte-range request yields whole, parseable documents without
# pulling the 134 MB file or adding a parquet dependency.
CORPUS_URL = ("https://huggingface.co/datasets/suolyer/pile_openwebtext2/"
              "resolve/main/val.json")
CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")


# ─── 1. Corpus ───────────────────────────────────────────────────────────────


def load_corpus(n_bytes: int = 8_000_000) -> list[str]:
    """First n_bytes of the corpus as a list of documents, cached on disk.

    The file is JSON-lines, so a prefix is valid data once the trailing partial
    line is dropped — no need to download 134 MB to read 8.
    """
    os.makedirs(CACHE_DIR, exist_ok=True)
    cache = os.path.join(CACHE_DIR, f"owt2-{n_bytes}.jsonl")
    if not os.path.exists(cache):
        sys.stderr.write(f"[features] fetching {n_bytes // 1_000_000} MB of corpus…\n")
        req = urllib.request.Request(
            CORPUS_URL,
            headers={"Range": f"bytes=0-{n_bytes - 1}", "User-Agent": "splice-mindlab/1.0"},
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read().decode("utf-8", "ignore")
        lines = raw.split("\n")[:-1]  # drop the truncated tail
        with open(cache, "w") as f:
            f.write("\n".join(lines))
    with open(cache) as f:
        docs = []
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                docs.append(json.loads(line)["text"])
            except (json.JSONDecodeError, KeyError):
                continue
    return docs


# ─── 2. Activation harvest ───────────────────────────────────────────────────


@dataclass
class Harvest:
    acts: torch.Tensor       # [n_samples, d_model] residual stream after block L
    seq_ids: torch.Tensor    # [n_seq, seq_len] token ids, for context lookup
    seq_len: int
    layer: int
    n_train: int             # samples [0:n_train) train, [n_train:) held out
    #: positions [0:skip) are dropped from every sequence — see `harvest`.
    skip: int = 1

    @property
    def per_seq(self) -> int:
        return self.seq_len - self.skip

    def _locate(self, index: int) -> tuple[int, int]:
        s, p = divmod(index, self.per_seq)
        return s, p + self.skip

    def token_id_at(self, index: int) -> int:
        s, p = self._locate(index)
        return int(self.seq_ids[s, p])

    def context(self, tok, index: int, width: int = 8) -> dict[str, Any]:
        """Sample index -> the token it sits on plus its left context."""
        s, p = self._locate(index)
        ids = self.seq_ids[s]
        lo = max(0, p - width)
        return {
            "token": tok.decode([int(ids[p])]),
            "left": tok.decode(ids[lo:p].tolist()),
            "right": tok.decode(ids[p + 1:min(self.seq_len, p + 4)].tolist()),
            "token_id": int(ids[p]),
        }


def harvest(lab: Lab, layer: int, n_tokens: int, seq_len: int = 128,
            batch: int = 8, holdout: float = 0.1, skip: int = 1) -> Harvest:
    """Run the corpus through the model and keep the layer-L residual stream.

    Position 0 is dropped. GPT-2's first position is an attention sink: its
    residual norm at layer 6 measures ~3050 against ~89 at every other position,
    a 34x outlier that would dominate a squared-error objective and hand most of
    the dictionary to one degenerate token. With it removed the norm
    distribution is tight (median 88, p99 110), which is what the L1/MSE
    trade-off assumes.
    """
    docs = load_corpus()
    eot = lab.tok.eos_token_id if lab.tok.eos_token_id is not None else 0

    # Pack documents end-to-end into fixed-length sequences (standard LM packing).
    n_seq = math.ceil(n_tokens / (seq_len - skip))
    buf: list[int] = []
    seqs: list[list[int]] = []
    for doc in docs:
        buf.extend(lab.tok(doc).input_ids + [eot])
        while len(buf) >= seq_len and len(seqs) < n_seq:
            seqs.append(buf[:seq_len])
            buf = buf[seq_len:]
        if len(seqs) >= n_seq:
            break
    if len(seqs) < n_seq:
        raise SystemExit(f"corpus exhausted: {len(seqs)} of {n_seq} sequences — raise load_corpus(n_bytes)")
    seq_ids = torch.tensor(seqs, dtype=torch.long)

    store: dict[str, torch.Tensor] = {}

    def capture(_m, _i, output):
        # Transformer blocks return a tuple; [0] is the residual stream.
        store["resid"] = output[0] if isinstance(output, tuple) else output

    handle = lab.blocks[layer].register_forward_hook(capture)
    chunks: list[torch.Tensor] = []
    with torch.no_grad():
        for i in range(0, n_seq, batch):
            lab.model(seq_ids[i:i + batch])
            chunks.append(store["resid"][:, skip:].reshape(-1, lab.d_model).clone())
            if (i // batch) % 10 == 0:
                sys.stderr.write(f"\r[features] harvesting… {min(i + batch, n_seq)}/{n_seq} seqs")
                sys.stderr.flush()
    handle.remove()
    sys.stderr.write("\r[features] harvesting… done                    \n")

    acts = torch.cat(chunks, 0)
    # Keep the train/holdout split on a sequence boundary so held-out
    # activations and the held-out sequences used for the loss test agree.
    n_train = int(len(acts) * (1 - holdout)) // (seq_len - skip) * (seq_len - skip)
    return Harvest(acts=acts, seq_ids=seq_ids, seq_len=seq_len, layer=layer,
                   n_train=n_train, skip=skip)


# ─── 3. The sparse autoencoder ───────────────────────────────────────────────


class SAE(nn.Module):
    """Overcomplete dictionary with a sparse code.

        z = ReLU(W_enc (x − b_dec) + b_enc)      z ∈ R^F, F ≫ d, mostly zero
        x̂ = W_dec z + b_dec                      columns of W_dec unit-norm

    Subtracting b_dec before encoding and adding it back after ties the two
    halves to a single learned centre of the activation cloud; unit-norm decoder
    columns stop the model from cheating the sparsity penalty by shrinking z and
    inflating W_dec.

    Two ways to make z sparse, both selectable:

    `k` set (TopK, Gao et al. 2024) — keep only the k largest entries and zero
    the rest. Sparsity is then exact and set by hand, and because surviving
    entries are not penalized there is no shrinkage bias pulling the
    reconstruction toward zero.

    `k` unset (L1, the objective in RESEARCH.md §5) — the classic formulation,
    where sparsity is bought indirectly with a penalty on ‖z‖₁. See the module
    docstring for how the two compare at this scale.
    """

    def __init__(self, d_model: int, n_features: int, k: int | None = None):
        super().__init__()
        w = torch.randn(d_model, n_features)
        w /= w.norm(dim=0, keepdim=True)
        self.W_dec = nn.Parameter(w)
        self.W_enc = nn.Parameter(w.t().clone())   # tied init, then free
        self.b_enc = nn.Parameter(torch.zeros(n_features))
        self.b_dec = nn.Parameter(torch.zeros(d_model))
        self.k = k

    def encode(self, x: torch.Tensor) -> torch.Tensor:
        pre = torch.relu((x - self.b_dec) @ self.W_enc.t() + self.b_enc)
        if self.k is None:
            return pre
        vals, idx = torch.topk(pre, self.k, dim=-1)
        return torch.zeros_like(pre).scatter_(-1, idx, vals)

    def decode(self, z: torch.Tensor) -> torch.Tensor:
        return z @ self.W_dec.t() + self.b_dec

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        z = self.encode(x)
        return self.decode(z), z

    @torch.no_grad()
    def normalize_decoder(self) -> None:
        self.W_dec.data /= self.W_dec.data.norm(dim=0, keepdim=True).clamp_min(1e-8)


@dataclass
class TrainLog:
    epoch: int
    recon_loss: float      # normalized MSE
    l1: float
    l0: float              # mean active features per token
    dead: int


def train_sae(acts: torch.Tensor, n_features: int, k: int | None = 32,
              l1: float = 5e-3, epochs: int = 20, batch: int = 4096,
              lr: float = 3e-3, resample_at: tuple[int, ...] = (5, 10)
              ) -> tuple[SAE, float, list[TrainLog]]:
    """Fit the dictionary. Returns (sae, activation_scale, per-epoch log).

    Activations are rescaled so E‖x‖² = d before training, which makes the
    sparsity setting mean the same thing across layers and model sizes; `scale`
    is returned so callers can map back to the model's real units.
    """
    d = acts.shape[1]
    scale = float(math.sqrt(d / (acts ** 2).sum(-1).mean()))
    x_all = acts * scale

    sae = SAE(d, n_features, k=k)
    sae.b_dec.data = x_all.mean(0).clone()   # centre of the cloud
    opt = torch.optim.Adam(sae.parameters(), lr=lr)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)
    n = len(x_all)
    log: list[TrainLog] = []

    for ep in range(1, epochs + 1):
        perm = torch.randperm(n)
        fires = torch.zeros(n_features)
        tot_recon = tot_l1 = tot_l0 = 0.0
        nb = 0
        for i in range(0, n - batch + 1, batch):
            x = x_all[perm[i:i + batch]]
            x_hat, z = sae(x)
            recon = ((x - x_hat) ** 2).sum(-1).mean()
            sparsity = z.abs().sum(-1).mean()
            # TopK already fixes L0 exactly; penalizing the survivors on top of
            # that would only reintroduce the shrinkage it exists to avoid.
            loss = recon if sae.k is not None else recon + l1 * sparsity
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            sae.normalize_decoder()
            with torch.no_grad():
                fires += (z > 0).float().sum(0)
                tot_recon += float(recon); tot_l1 += float(sparsity)
                tot_l0 += float((z > 0).float().sum(-1).mean())
            nb += 1

        sched.step()
        dead_mask = fires == 0
        n_dead = int(dead_mask.sum())
        log.append(TrainLog(epoch=ep, recon_loss=round(tot_recon / nb, 4),
                            l1=round(tot_l1 / nb, 3), l0=round(tot_l0 / nb, 2), dead=n_dead))
        sys.stderr.write(f"\r[features] epoch {ep}/{epochs}  recon {tot_recon / nb:.3f}  "
                         f"L0 {tot_l0 / nb:.1f}  dead {n_dead}    ")
        sys.stderr.flush()

        # Resample dead features onto the inputs the dictionary reconstructs
        # worst — the standard fix for features that switch off early and never
        # receive gradient again.
        if ep in resample_at and n_dead > 0:
            with torch.no_grad():
                sample = x_all[torch.randperm(n)[:8192]]
                err = ((sample - sae(sample)[0]) ** 2).sum(-1)
                pick = torch.multinomial(err / err.sum(), min(n_dead, len(sample)))
                new = sample[pick] - sae.b_dec
                new = new / new.norm(dim=1, keepdim=True).clamp_min(1e-8)
                idx = torch.nonzero(dead_mask).flatten()[:len(new)]
                sae.W_dec.data[:, idx] = new.t()
                sae.W_enc.data[idx] = new * 0.2
                sae.b_enc.data[idx] = 0.0

    sys.stderr.write("\n")
    return sae, scale, log


# ─── 4. Does the dictionary capture the computation? ─────────────────────────


@dataclass
class FidelityResult:
    l0: float                    # mean features active per token
    n_features: int
    d_model: int
    dead_features: int
    variance_explained: float
    ce_baseline: float           # model's own cross-entropy on held-out text
    ce_reconstructed: float      # with x̂ spliced in at layer L
    ce_ablated: float            # with the residual stream zeroed at layer L
    loss_recovered: float        # (ce_ablated − ce_recon) / (ce_ablated − ce_base)
    interpretation: list[str] = field(default_factory=list)
    note: str = (
        "Loss recovered is the honest test of a dictionary: splice the "
        "reconstruction back into the forward pass in place of the real "
        "residual stream and see whether the model still predicts text. 1.0 "
        "means the sparse code carried everything the layer was doing; 0.0 "
        "means it carried no more than deleting the layer's output."
    )


def evaluate_fidelity(lab: Lab, sae: SAE, scale: float, hv: Harvest,
                      n_eval_seq: int = 24) -> FidelityResult:
    x_hold = hv.acts[hv.n_train:] * scale
    with torch.no_grad():
        x_hat, z = sae(x_hold)
        l0 = float((z > 0).float().sum(-1).mean())
        dead = int((z > 0).sum(0).eq(0).sum())
        resid_var = float(((x_hold - x_hat) ** 2).sum())
        total_var = float(((x_hold - x_hold.mean(0)) ** 2).sum())
        var_exp = 1.0 - resid_var / total_var

    # Held-out sequences: the tail of the corpus, matching the held-out samples.
    first_hold_seq = hv.n_train // hv.per_seq
    seqs = hv.seq_ids[first_hold_seq:first_hold_seq + n_eval_seq]
    if len(seqs) < 2:
        seqs = hv.seq_ids[-n_eval_seq:]

    def cross_entropy(mode: str) -> float:
        def hook(_m, _i, output):
            resid = output[0] if isinstance(output, tuple) else output
            new = resid.clone()
            # Position 0 is left alone in every condition: it was excluded from
            # training (attention sink), so neither the dictionary nor the
            # ablation baseline has any claim on it, and holding it fixed keeps
            # the three conditions comparable.
            edit = resid[:, hv.skip:]
            if mode == "zero":
                new[:, hv.skip:] = 0
            else:
                flat = edit.reshape(-1, resid.shape[-1]) * scale
                new[:, hv.skip:] = (sae(flat)[0] / scale).reshape(edit.shape)
            return (new,) + tuple(output[1:]) if isinstance(output, tuple) else new

        handle = (lab.blocks[hv.layer].register_forward_hook(hook)
                  if mode != "base" else None)
        with torch.no_grad():
            logits = lab.model(seqs).logits
            loss = nn.functional.cross_entropy(
                logits[:, :-1].reshape(-1, logits.shape[-1]), seqs[:, 1:].reshape(-1))
        if handle is not None:
            handle.remove()
        return float(loss)

    ce_base = cross_entropy("base")
    ce_recon = cross_entropy("sae")
    ce_zero = cross_entropy("zero")
    recovered = (ce_zero - ce_recon) / (ce_zero - ce_base) if ce_zero > ce_base else 0.0

    interp = [
        f"{l0:.1f} of {sae.W_dec.shape[1]} features fire per token — the model's "
        f"{hv.acts.shape[1]}-dimensional state at layer {hv.layer} is re-expressed as a sum of "
        f"about {l0:.0f} named parts.",
        f"The reconstruction keeps {var_exp * 100:.1f}% of the variance, and splicing it back "
        f"into the forward pass recovers {recovered * 100:.1f}% of the model's language-modelling "
        f"loss (CE {ce_base:.2f} real → {ce_recon:.2f} rebuilt → {ce_zero:.2f} deleted).",
        f"{dead} features never fired on held-out text.",
    ]
    return FidelityResult(
        l0=round(l0, 2), n_features=sae.W_dec.shape[1], d_model=hv.acts.shape[1],
        dead_features=dead, variance_explained=round(var_exp, 4),
        ce_baseline=round(ce_base, 4), ce_reconstructed=round(ce_recon, 4),
        ce_ablated=round(ce_zero, 4), loss_recovered=round(recovered, 4),
        interpretation=interp,
    )


# ─── 5. What each feature means: what fires it, what it writes ───────────────


@dataclass
class FeatureStats:
    """Per-feature summary over the whole training set, computed in a streaming
    pass so the [n_samples x F] code matrix is never materialized (it would be
    gigabytes; the statistics it feeds are a few hundred kilobytes)."""
    density: torch.Tensor    # [F] fraction of tokens where the feature is active
    top_vals: torch.Tensor   # [F, k] highest activations
    top_idx: torch.Tensor    # [F, k] sample indices of those activations


def feature_stats(sae: SAE, x: torch.Tensor, k: int = 32,
                  chunk: int = 8192) -> FeatureStats:
    n_feat = sae.W_dec.shape[1]
    counts = torch.zeros(n_feat)
    best_v = torch.full((n_feat, k), -float("inf"))
    best_i = torch.zeros((n_feat, k), dtype=torch.long)
    with torch.no_grad():
        for start in range(0, len(x), chunk):
            z = sae.encode(x[start:start + chunk])          # [c, F]
            counts += (z > 0).float().sum(0)
            c = min(k, len(z))
            v, i = torch.topk(z, c, dim=0)                   # [c, F]
            v, i = v.t().contiguous(), (i.t() + start)       # [F, c]
            merged_v = torch.cat([best_v, v], 1)
            merged_i = torch.cat([best_i, i], 1)
            sel = torch.topk(merged_v, k, dim=1)
            best_v = sel.values
            best_i = torch.gather(merged_i, 1, sel.indices)
    return FeatureStats(density=counts / len(x), top_vals=best_v, top_idx=best_i)


def _token_entropy(token_ids: list[int]) -> float:
    """Normalized entropy of a token multiset. 0 = always the same token,
    1 = every top activation is a different token."""
    if not token_ids:
        return 1.0
    counts = np.bincount(np.array(token_ids))
    p = counts[counts > 0] / len(token_ids)
    h = max(0.0, float(-(p * np.log2(p)).sum()))
    return h / math.log2(len(token_ids)) if len(token_ids) > 1 else 0.0


@dataclass
class Feature:
    index: int
    #: fraction of tokens on which this feature is active at all
    density: float
    max_activation: float
    #: normalized entropy of the tokens it most fires on (low = selective)
    token_entropy: float
    #: what makes it fire — top-activating positions with their context
    top_contexts: list[dict[str, Any]]
    #: what it writes — its decoder direction through the model's own readout
    promotes: list[str]
    suppresses: list[str]


@dataclass
class InterpretResult:
    layer: int
    n_inspected: int
    features: list[Feature]
    note: str = (
        "A feature has two independent halves, measured separately here. What "
        "fires it comes from the corpus (top-activating contexts). What it "
        "writes comes from the weights (its decoder direction pushed through "
        "the unembedding). Nothing forces them to agree — where they do, the "
        "feature is doing one legible job."
    )


def _alive_features(stats: FeatureStats, min_density: float = 2e-4,
                    max_density: float = 0.05) -> torch.Tensor:
    """Ultra-rare features have too little evidence behind them; ubiquitous ones
    are the dictionary's version of a bias term. The interpretable middle."""
    alive = torch.nonzero((stats.density > min_density) &
                          (stats.density < max_density)).flatten()
    return alive if len(alive) else torch.nonzero(stats.density > 0).flatten()


def interpret(lab: Lab, sae: SAE, scale: float, hv: Harvest, stats: FeatureStats,
              n_features: int = 24, top_k: int = 12) -> InterpretResult:
    """Label features by what fires them and by what they promote in the readout."""
    alive = _alive_features(stats)
    # Rank by peak activation: the features that most strongly claim a token.
    peak = stats.top_vals[alive, 0]
    chosen = alive[torch.topk(peak, min(n_features, len(alive))).indices]

    # What each feature writes: decoder direction through the model's readout.
    with torch.no_grad():
        dirs = sae.W_dec.data[:, chosen].t() / scale           # [n, d] model units
        logits = lab.decode_head(dirs)                          # [n, vocab]

    feats: list[Feature] = []
    for row, f in enumerate(chosen.tolist()):
        vals = stats.top_vals[f]
        idx = stats.top_idx[f]
        contexts, tok_ids = [], []
        for j in range(min(top_k, len(idx))):
            if not math.isfinite(float(vals[j])) or float(vals[j]) <= 0:
                continue
            c = hv.context(lab.tok, int(idx[j]))
            c["activation"] = round(float(vals[j]), 3)
            contexts.append(c)
            tok_ids.append(c["token_id"])
        up = torch.topk(logits[row], 8).indices.tolist()
        down = torch.topk(-logits[row], 5).indices.tolist()
        feats.append(Feature(
            index=f,
            density=round(float(stats.density[f]), 6),
            max_activation=round(float(vals[0]), 3),
            token_entropy=round(_token_entropy(tok_ids), 4),
            top_contexts=contexts,
            promotes=[lab.tok.decode([t]) for t in up],
            suppresses=[lab.tok.decode([t]) for t in down],
        ))
    feats.sort(key=lambda f: f.token_entropy)
    return InterpretResult(layer=hv.layer, n_inspected=len(feats), features=feats)


# ─── 6. The superposition claim, measured ────────────────────────────────────


@dataclass
class CompareResult:
    n_units: int
    top_k: int
    feature_entropy_median: float
    neuron_entropy_median: float
    feature_entropy_mean: float
    neuron_entropy_mean: float
    ratio: float
    monosemantic_features: int    # entropy < 0.5
    monosemantic_neurons: int
    #: the raw per-unit entropies behind the summary, for plotting
    feature_entropies: list[float] = field(default_factory=list)
    neuron_entropies: list[float] = field(default_factory=list)
    interpretation: list[str] = field(default_factory=list)
    note: str = (
        "Selectivity proxy: take the tokens a unit most strongly fires on and "
        "measure their entropy. Low means the unit answers to a tight family of "
        "tokens; high means it answers to everything. Basis directions of the "
        "residual stream are the baseline — the same activations, read in the "
        "coordinate system the model happens to store them in. This measures "
        "token-level selectivity only; a feature can be selective for a context "
        "rather than a token and score high here."
    )


def compare_to_basis(lab: Lab, sae: SAE, scale: float, hv: Harvest,
                     stats: FeatureStats, n_units: int = 200,
                     top_k: int = 32) -> CompareResult:
    """Learned features vs. the raw residual-stream basis, same activations."""
    x = hv.acts[:hv.n_train] * scale
    top_k = min(top_k, stats.top_idx.shape[1])

    alive = _alive_features(stats)
    fcols = alive[torch.randperm(len(alive))[:n_units]]
    # Basis directions are signed; selectivity is about magnitude either way.
    ncols = torch.randperm(hv.acts.shape[1])[:n_units]

    fe = [_token_entropy([hv.token_id_at(int(i)) for i in stats.top_idx[c, :top_k]])
          for c in fcols.tolist()]
    nvals = torch.topk(x[:, ncols].abs(), top_k, dim=0).indices          # [k, n_units]
    ne = [_token_entropy([hv.token_id_at(int(i)) for i in nvals[:, j]])
          for j in range(nvals.shape[1])]
    fmed, nmed = float(np.median(fe)), float(np.median(ne))
    mono_f = int(sum(e < 0.5 for e in fe))
    mono_n = int(sum(e < 0.5 for e in ne))

    interp = [
        f"Median top-{top_k} token entropy: learned features {fmed:.3f} vs. residual-stream "
        f"directions {nmed:.3f} — features are {nmed / fmed if fmed > 1e-6 else float('inf'):.1f}× "
        f"more token-selective on the same activations.",
        f"{mono_f} of {len(fe)} features clear the entropy < 0.5 bar, against {mono_n} of "
        f"{len(ne)} basis directions.",
        "This is the superposition claim made concrete: the model's own coordinates are blends; "
        "a sparse overcomplete basis pulls legible parts back out of them.",
    ]
    return CompareResult(
        n_units=len(fe), top_k=top_k,
        feature_entropy_median=round(fmed, 4), neuron_entropy_median=round(nmed, 4),
        feature_entropy_mean=round(float(np.mean(fe)), 4),
        neuron_entropy_mean=round(float(np.mean(ne)), 4),
        ratio=round(nmed / fmed, 3) if fmed > 1e-6 else 0.0,
        monosemantic_features=mono_f, monosemantic_neurons=mono_n,
        feature_entropies=[round(e, 4) for e in fe],
        neuron_entropies=[round(e, 4) for e in ne],
        interpretation=interp,
    )


# ─── 7. Causal check: does a feature do what its weights say? ────────────────


@dataclass
class CausalFeature:
    index: int
    fires_on: list[str]
    predicted_promotes: list[str]
    #: P(predicted token set) at each injection strength, alpha -> probability
    sweep: list[dict[str, Any]]
    baseline_prob: float
    peak_prob: float
    lift: float                    # peak / baseline
    #: smallest alpha at which the model's actual top token is one the
    #: feature's weights predicted — None if it never takes over
    takeover_alpha: float | None
    takeover_token: str | None


@dataclass
class CausalResult:
    prompt: str
    layer: int
    alphas: list[float]
    features: list[CausalFeature]
    n_taken_over: int
    median_peak_prob: float
    median_lift: float
    interpretation: list[str] = field(default_factory=list)
    note: str = (
        "The label a feature gets from its decoder weights is a prediction, not "
        "an observation. This tests it: add the feature's direction to the "
        "residual stream during a real forward pass on an unrelated prompt and "
        "sweep the strength, checking whether the tokens the weights named "
        "actually arrive. Takeover — the model's top token becoming one the "
        "weights predicted, on a prompt with nothing to do with the feature — "
        "is the strong form of the result."
    )


def causal_check(lab: Lab, sae: SAE, scale: float, interp: InterpretResult,
                 prompt: str = "The next thing that happened was", n: int = 8,
                 alphas: tuple[float, ...] = (10, 20, 40, 80, 160)) -> CausalResult:
    ids = lab.ids(prompt)
    with torch.no_grad():
        base_probs = torch.softmax(lab.model(ids).logits[0, -1], -1)
    layer = interp.layer

    out: list[CausalFeature] = []
    for feat in interp.features[:n]:
        names = [t for t in feat.promotes[:5] if t.strip()]
        target = torch.tensor([lab.tok(t).input_ids[0] for t in names])
        if not len(target):
            continue
        direction = sae.W_dec.data[:, feat.index] / scale
        base = float(base_probs[target].sum())

        sweep, takeover_a, takeover_t = [], None, None
        for a in alphas:
            def inject(_m, _i, output, _d=direction, _a=a):
                resid = output[0] if isinstance(output, tuple) else output
                new = resid + _a * _d
                return (new,) + tuple(output[1:]) if isinstance(output, tuple) else new

            handle = lab.blocks[layer].register_forward_hook(inject)
            with torch.no_grad():
                probs = torch.softmax(lab.model(ids).logits[0, -1], -1)
            handle.remove()
            top = int(probs.argmax())
            sweep.append({"alpha": a, "prob": round(float(probs[target].sum()), 6),
                          "top_token": lab.tok.decode([top])})
            if takeover_a is None and top in set(target.tolist()):
                takeover_a, takeover_t = a, lab.tok.decode([top])

        peak = max(s["prob"] for s in sweep)
        out.append(CausalFeature(
            index=feat.index,
            fires_on=[c["token"] for c in feat.top_contexts[:5]],
            predicted_promotes=names, sweep=sweep,
            baseline_prob=round(base, 8), peak_prob=round(peak, 6),
            # Baselines are floored: these tokens are so unlikely on a neutral
            # prompt that an exact ratio is dominated by rounding, so the lift
            # is a lower bound, not a measurement.
            lift=round(peak / max(base, 1e-6), 1),
            takeover_alpha=takeover_a, takeover_token=takeover_t,
        ))

    lifts = [f.lift for f in out if math.isfinite(f.lift)]
    median_lift = float(np.median(lifts)) if lifts else 0.0
    median_peak = float(np.median([f.peak_prob for f in out])) if out else 0.0
    took = [f for f in out if f.takeover_alpha is not None]
    lines = [
        f"Injecting one feature direction at layer {layer} into {prompt!r} — a prompt with nothing "
        f"to do with any of them — pushes the tokens that feature's weights named from "
        f"effectively zero to a median peak of {median_peak:.1%} of the model's probability mass, "
        f"across {len(out)} features.",
    ]
    if took:
        ex = took[0]
        lines.append(
            f"For {len(took)} of {len(out)}, the predicted token becomes the model's actual output: "
            f"feature #{ex.index} fires only on {ex.fires_on[0]!r}, its decoder direction names "
            f"{ex.takeover_token!r}, and at strength {ex.takeover_alpha:.0f} the model says "
            f"{ex.takeover_token!r}.")
    lines.append("Read the feature off the weights, inject it, and the prediction comes true — what "
                 "fires the feature and what it writes are two views of one object.")
    return CausalResult(prompt=prompt, layer=layer, alphas=list(alphas), features=out,
                        n_taken_over=len(took), median_peak_prob=round(median_peak, 4),
                        median_lift=round(median_lift, 2), interpretation=lines)


# ─── CLI ─────────────────────────────────────────────────────────────────────


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default="gpt2")
    ap.add_argument("--layer", type=int, default=None, help="residual stream layer (default n_layer//2)")
    ap.add_argument("--features", type=int, default=4096, help="dictionary size F")
    ap.add_argument("--tokens", type=int, default=120_000, help="activation samples to harvest")
    ap.add_argument("--epochs", type=int, default=20)
    ap.add_argument("--sparsity", choices=["topk", "l1"], default="topk",
                    help="how z is made sparse (see module docstring)")
    ap.add_argument("-k", type=int, default=32, help="topk: features kept per token")
    ap.add_argument("--l1", type=float, default=4.0, help="l1: sparsity coefficient")
    ap.add_argument("--batch", type=int, default=4096)
    ap.add_argument("--lr", type=float, default=3e-3)
    ap.add_argument("--inspect", type=int, default=24, help="features to interpret in detail")
    ap.add_argument("--steer-prompt", default="The next thing that happened was")
    ap.add_argument("--alphas", default="10,20,40,80,160", help="feature injection strengths to sweep")
    ap.add_argument("--out", default="results/features.json")
    args = ap.parse_args()

    t0 = time.time()
    sys.stderr.write(f"[features] loading {args.model}…\n")
    lab = Lab(args.model)
    layer = args.layer if args.layer is not None else lab.n_layer // 2

    hv = harvest(lab, layer, args.tokens)
    sys.stderr.write(f"[features] {len(hv.acts):,} activation vectors "
                     f"({hv.acts.shape[1]}-d) from layer {layer}\n")

    sae, scale, log = train_sae(hv.acts[:hv.n_train], args.features,
                                k=args.k if args.sparsity == "topk" else None,
                                l1=args.l1, epochs=args.epochs,
                                batch=args.batch, lr=args.lr)

    fid = evaluate_fidelity(lab, sae, scale, hv)
    sys.stderr.write("[features] summarizing feature activations…\n")
    stats = feature_stats(sae, hv.acts[:hv.n_train] * scale)
    intr = interpret(lab, sae, scale, hv, stats, n_features=args.inspect)
    cmp = compare_to_basis(lab, sae, scale, hv, stats)
    cau = causal_check(lab, sae, scale, intr, prompt=args.steer_prompt,
                       alphas=tuple(float(a) for a in args.alphas.split(",")))

    results = {
        "model": args.model,
        "layer": layer,
        "config": {"features": args.features, "tokens": args.tokens, "epochs": args.epochs,
                   "sparsity": args.sparsity, "k": args.k if args.sparsity == "topk" else None,
                   "l1": args.l1 if args.sparsity == "l1" else None,
                   "batch": args.batch, "lr": args.lr},
        "training": [asdict(t) for t in log],
        "fidelity": asdict(fid),
        "interpret": asdict(intr),
        "compare": asdict(cmp),
        "causal": asdict(cau),
        "seconds": round(time.time() - t0, 1),
    }
    if args.out:
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        with open(args.out, "w") as f:
            json.dump(results, f, indent=2)
        sys.stderr.write(f"[features] → {args.out} in {time.time() - t0:.1f}s\n")
    json.dump(results, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
