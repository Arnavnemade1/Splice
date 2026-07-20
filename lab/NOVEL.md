# Novel probes — experiments that haven't been run this way before

`probes.py` goes beyond replication. Honest framing first: these are **novel
measurements and syntheses**, not novel interpretability primitives. Every probe is
assembled from standard ingredients (gradients, leave-one-out ablation, contrastive
activation differences, KL divergence) that you can read in one file. The novelty is
in *what is asked*: Splice's decision-geometry instrument — built for its own action
scorer — pointed at a real transformer for the first time, plus two questions that
instrument makes natural to ask. All numbers below are from `gpt2` (124M), CPU,
reproducible via `python3 probes.py all`.

---

## 1. `geometry` — the Splice ↔ model bridge

**Question.** [`JSpace.ts`](../src/JSpace.ts) reports, for every Splice decision:
token-deletion robustness, flip-boundary distance, effective dimensionality, and the
load-bearing token. What do those exact quantities look like for a *transformer's*
next-token decision?

**Method.** For one prompt: (a) leave-one-out deletion over real forward passes
(does top-1 survive?), (b) per-token *flip distance* = margin / ‖∂margin/∂emb_i‖ —
the first-order embedding-space distance to the decision boundary along each token,
(c) effective dimension = participation ratio of the top-k-logit Jacobian's spectrum
(the same (Σλ)²/Σλ² formula `JSpace.ts` uses), (d) the deletion that collapses the
margin most.

**Finding (gpt2).** The "Eiffel Tower → Paris" decision that looks solid from the
outside is *geometrically fragile*: margin only **0.32** over " London", deleting
"E" (the first subword of *Eiffel*) flips the answer to **London**, and the decision
occupies an effectively **1.003-dimensional** slice of logit space — a single
Paris-vs-London axis, exactly the `rank_one` / `dimension_collapse` signature
Splice's detector flags in its own decisions.

## 2. `calibrate` — is the model calibrated to its own fragility?

**Question.** Splice's Cognition module measures whether an agent's *stated
confidence* tracks its *verified outcomes*. The model-side analog nobody usually
plots: does a transformer's softmax confidence track how **geometrically robust**
the decision is? Confidence and robustness could in principle be the same thing —
are they?

**Method.** Across 14 factual prompts, correlate softmax P(top-1) with (a) the
top-1-vs-top-2 logit margin and (b) the minimum per-token flip distance; flag
predictions that are high-confidence yet fragile (flip under single-token deletion,
or below-median margin).

**Finding (gpt2).** They are nearly unrelated: **r = 0.14** (confidence vs margin)
and **r = −0.05** (confidence vs flip distance). 4 of the most confident
predictions were geometrically fragile — including the single most confident answer
in the set (" oxygen", P = 0.46, margin 0.51, 3 deletion-flips). GPT-2's confidence
is essentially *blind to the geometry of its own decision* — the model-scale
version of the "confident but fragile" hazard Splice's calibration engine was built
to catch in agents. (Scope: one small model, 14 prompts — an observation and an
invitation, not a law.)

## 3. `transport` — does a concept keep its direction across depth?

**Question.** Concept vectors are usually built at one chosen layer. Build the
*same* concept ("the ocean", contrastive prompts) at **every** layer: is it one
shared direction, and does layer L's vector still *do* anything when injected at
layer L′?

**Method.** (a) Cross-layer cosine alignment matrix of the 12 per-layer vectors.
(b) Functional transport: inject the mid-layer (L6) vector at each layer during a
forward pass on a neutral prompt; measure KL(steered‖base) and the probability mass
moved onto the tokens the vector *itself* promotes through the readout (a
principled target set — for this vector: *roar, roaring, tsun-, tidal, surging* —
which independently validates that the contrastive vector encodes storm-ocean
semantics).

**Finding (gpt2).** The concept **rotates smoothly** up the stack: adjacent layers
align at mean cosine **0.79**, distant layers decay toward ~0.2, and the final
layer is decoupled from everything (≤ 0.4) — a clean band-diagonal structure. And
transport is **asymmetric**: L6's vector injected *upstream* lands hardest (peak at
L3–4, KL 0.20, next token bends to " cold"), because the intervening layers amplify
it; injected *downstream* it fades monotonically (KL 0.009 by L11). A concept
direction is not one reusable handle — it is a depth-indexed family, and it works
best *before* the machinery that consumes it.

## 4. `scaling` — does scale fix the confidence–fragility gap?

**Question.** Probe 2 found gpt2's confidence weakly related to its decision
geometry. The obvious follow-up: does confidence become *calibrated to robustness*
as models grow? Run the whole geometry battery across the GPT-2 family
(distilgpt2 82M → gpt2 124M → gpt2-medium 355M → gpt2-large 774M) on a fixed
40-prompt set. [`scaling.py`](scaling.py); data in
[`results/scaling-calibration.json`](results/scaling-calibration.json).

**Finding — scale buys confidence, not robustness.** Two things climb with scale and
one does not:

| model | params | mean confidence | mean margin | fully-robust prompts | mean deletion-flips |
| --- | --- | --- | --- | --- | --- |
| distilgpt2 | 82M | 0.165 | 0.65 | **0 / 40** | 3.6 |
| gpt2 | 124M | 0.182 | 0.69 | **0 / 40** | 3.8 |
| gpt2-medium | 355M | 0.296 | 1.21 | **0 / 40** | 4.3 |
| gpt2-large | 774M | 0.333 | 1.28 | **0 / 40** | 3.6 |

Mean confidence and top-1-vs-top-2 margin roughly **double** from 82M to 774M, yet
**not one prediction at any size survives every single-token deletion**, and the
average number of deletions that flip the answer stays flat (~3.6–4.3). Bigger
models are more confident and separate their top candidate more decisively — and are
exactly as fragile to dropping a word. Meanwhile predictions *do* change with scale
(agreement with gpt2-large rises 32% → 42% → 70%), so scale is improving the answers;
it just isn't improving their geometric robustness.

The confidence↔flip-distance correlation shows **no clean scaling trend** either
(Pearson 0.57, 0.07, 0.64, 0.59 across the four sizes — gpt2 an outlier, n=4 far too
few for a law). The confidence↔margin correlation is high (~0.7–0.9) but that is
**near-tautological** — both quantities are read off the same top-1/top-2 logit gap —
so it is reported for completeness, not as a result.

**Why it matters here.** This is the empirical case for Splice's whole premise: a
model's confidence is not a proxy for how robust its decision is, and — in this range —
scale does not close that gap. External verification of an action against real
postconditions (what `compile_verified_action` does) is not a crutch that a bigger
model removes. Same honest caveats, louder: one architecture family, 40 short prompts
where single-token deletion is a large perturbation; the *invariance across scale* is
the signal, not the absolute fragility rate.

---

## Relation to prior work

Leave-one-out ablation, gradient saliency, activation steering, and logit-lens
readouts are all established (see [RESEARCH.md](RESEARCH.md)). Adjacent published
threads: Jacobian Scopes (token-level gradient attributions), robustness/margin
literature (adversarial distance-to-boundary), and cross-layer feature analyses in
the transcoder/SAE line. What we have not seen elsewhere: (1) the *agent-decision
geometry battery* (deletion robustness + flip distance + participation-ratio
dimension + load-bearing token, as one report) applied to LM next-token decisions,
(2) the confidence-vs-geometric-robustness correlation stated and measured as a
calibration question, and (3) the per-layer concept-vector *alignment × functional
transport* pairing. If someone has — good; the point of one readable file is that
these runs are trivially checkable and extendable.

## Reproduce / extend

```bash
cd lab && . .venv/bin/activate
python3 probes.py geometry --prompt "your prompt here"
python3 probes.py calibrate           # edit CALIBRATION_PROMPTS to scale up
python3 probes.py transport --concept "shouting"
python3 probes.py all --out probes.json
python3 scaling.py --models distilgpt2,gpt2,gpt2-medium,gpt2-large   # the scaling study
```

Obvious extensions: more prompts and a bigger model for `calibrate` (does the
correlation grow with scale?); `transport` for many concepts (is upstream
amplification universal?); porting `geometry` into Splice's detector thresholds so
the same hazard taxonomy screens both agent and model decisions.
