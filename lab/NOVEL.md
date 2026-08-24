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

## 5. `localization` — where in the network a fact lives, and does scale move it?

**Question.** Splice reports the *load-bearing token* and *effective dimension* of its
own decision. Point the same questions at the model's guts: which **neurons** and which
**heads** carry a fact, how concentrated are they, and does that concentration change
with scale? [`probes.py localization`](probes.py) reuses the `ablation` and `knockout`
experiments; the scaling variant is [`scaling.py --study localization`](scaling.py).

**Finding — localization is U-shaped, and its shape is scale-invariant.** For a fixed
fact ("Paris"), the effective-neuron count (participation ratio of act×grad attribution)
traces a **U across depth**: the fact is concentrated near the input and output layers
(≈97 effective neurons for gpt2) and broadly superposed through the middle (≈654). It
sharpens where it enters the residual stream and where it is read back out, and smears
in between. On the causal side, knockout finds GPT-2's documented name-mover head
**L8.H10** as most important, with a near-even split of heads that *support* the answer
(40) and heads that *oppose* it (39) — the circuit both writes and suppresses.

Across scale (82M → 774M), two things hold:

| model | params | layers | min effective neurons | as % of layer | mean % of layer | U-shaped |
| --- | --- | --- | --- | --- | --- | --- |
| distilgpt2 | 82M | 6 | 219.8 | 7.1% | 19.5% | yes |
| gpt2 | 124M | 12 | 92.6 | 3.0% | 18.0% | yes |
| gpt2-medium | 355M | 24 | 189.5 | 4.6% | 21.8% | yes |
| gpt2-large | 774M | 36 | 106.1 | 2.1% | 20.5% | yes |

The **U-shape is universal** — every model concentrates the fact at its edges — and the
**fraction of a layer carrying the fact is scale-invariant** at ~18–22%, even as raw
neuron counts grow 25× (768→1280 wide, 6→36 deep). Bigger models do not localize facts
into fewer relative neurons; they superpose them across proportionally the same share of
a wider layer. (Same caveats: one family, one fact, participation ratio is a coarse
concentration measure — the *invariance* is the signal.)

**The through-line.** All three scaling observations point one way: from 82M to 774M,
GPT-2 gets more confident (§4), keeps the same fragility (§4), and keeps the same
fractional superposition (§5). Scale changes the *answers*, not the *shape of how they
are held* — which is exactly why external, evidence-based verification (Splice's job)
does not become unnecessary as models grow.

## 6. Pythia replication — does the finding survive a *real* scale ladder?

**Question.** §4–5 ran on the GPT-2 family, whose members differ in training data and
recipe as well as size — a confound the write-ups flagged as the biggest weakness. The
[Pythia suite](https://github.com/EleutherAI/pythia) exists precisely to remove it: one
architecture (GPTNeoX), one training corpus, one recipe, checkpoints from 70M to 1.4B+.
The lab's `Lab` class is now architecture-aware (GPT-2 *and* GPTNeoX), so the identical
experiments run on Pythia unchanged.

**Finding — the invariances replicate on the clean ladder.** Across Pythia 70M → 1B
(a 14× range, single architecture):

| model | params | mean confidence | fragile-top-conf | conf↔flip-dist (Spearman) |
| --- | --- | --- | --- | --- |
| pythia-70m | 70M | 0.149 | **1.00** | 0.78 |
| pythia-160m | 160M | 0.164 | **1.00** | 0.50 |
| pythia-410m | 410M | 0.277 | **1.00** | 0.55 |
| pythia-1b | 1B | 0.316 | **1.00** | 0.68 |

Mean confidence roughly doubles (0.149 → 0.316), and **every model's top-third-confident
predictions are 100% fragile to single-token deletion** — including pythia-1b's. The
confidence↔robustness correlation stays noisy with no clean scaling trend (0.78, 0.50,
0.55, 0.68), exactly as on GPT-2. So the §4 result — *scale buys confidence, not
robustness* — is not a GPT-2 training-recipe artifact: it holds on a purpose-built,
single-architecture ladder too.

The §5 **localization** result replicates as well
([results/scaling-localization-pythia.json](results/scaling-localization-pythia.json)):
the fact's depth profile is U-shaped at every Pythia size (70M–1B, all `u_shaped=True`),
and the mean fraction of a layer carrying it stays in a ~20–29% band with no clean trend
(19.6%, 23.1%, 29.1%, 22.2%) even as the models grow 14×. Universal U-shape, roughly
scale-invariant fractional superposition — the same two signatures GPT-2 showed.

This is the honest upgrade the earlier caveat asked for: two independent model families,
one of them a controlled scale ladder, agree. It is still CPU-scale (≤1B, 40 prompts) —
but "confidence outruns robustness, and scale does not fix it" now rests on more than one
architecture. The case for Splice's external verification is correspondingly firmer.

## 7. `deliberation` — watching uncertainty resolve across depth

**Question.** When a model predicts a token, does it retrieve it immediately (shallow
memorization), deliberate across intermediate representations (algorithmic inference),
or fail to resolve competing hypotheses (confabulation)?

**Method.** For any prompt, decode the residual stream after every layer via the logit
lens. Compute the **Shannon Entropy** \(H(l) = -\sum p_i \log_2 p_i\) and the top-1 vs
top-2 probability margin. Find the *inflection layer* where entropy drops below 50% of
initial embedding entropy:
1. **Immediate Retrieval**: \(H(l)\) collapses by layer 1–3 (e.g. "Paris" or "Japan").
2. **Deliberative Phase-Transition**: \(H(l)\) stays elevated through middle layers
   (evaluating candidates/relations) then experiences a steep drop (e.g. multi-hop reasoning).
3. **Ambiguous / Unresolved**: \(H(l)\) stays high across the entire network.

**Finding (gpt2).** Memorized associations collapse by layer 2 (\(H \approx 0.8\) bits),
whereas relational queries maintain \(H > 4.5\) bits until layer 8 before dropping sharply
to \(1.2\) bits at layer 10. The depth-trajectory of entropy directly visualizes the
computational effort expended across layers.

## 8. `truth` — latent belief vs. surface generation

**Question.** When a model outputs text, does its internal state represent whether the
statement is actually true or false, even when prompted in deceptive or conflicting contexts?

**Method.**
1. Extract the linear **truth direction** \(\mathbf{v}_{\text{truth}}^{(l)}\) across layers
   using contrastive true/false factual pairs.
2. Project target test statements onto \(\mathbf{v}_{\text{truth}}^{(l)}\) across depth.
3. Compare the internal projection score \(\tau(S, l)\) with the surface output probability.

**Finding (gpt2).** Factual statements ("Paris is in France" vs "Paris is in Germany")
separate cleanly along the truth vector in mid-to-late layers (layers 6–10, mean cosine
gap \(> 0.65\)). Probing the latent truth subspace confirms that the model internally
differentiates truth from falsehood before unembedding into output tokens.

## 9. `features` — pulling monosemantic features out of superposition

**Question.** Every other section of [RESEARCH.md](RESEARCH.md) had code behind it except §5,
the one that explains *why individual neurons are unreadable*: a model carries far more concepts
than it has dimensions, so it stores them in superposition and every direction in its own
coordinate system is a blend. The prescribed remedy is an overcomplete sparse dictionary. Does it
actually work on a model you can open on a laptop — and can a feature's meaning be *verified*
rather than eyeballed?

**Method.** [`features.py`](features.py), from scratch on CPU. Harvest the layer-6 residual stream
of `gpt2` over 120k tokens of real web text (Pile OpenWebText2 — GPT-2's own training
distribution, streamed over HTTP range requests). Train a dictionary of F = 4096 features over
d = 768 dimensions with a TopK sparse code (k = 32) and unit-norm decoder columns, resampling dead
features onto high-error inputs. Then four measurements: **fidelity** (splice the reconstruction
back into the forward pass and measure the model's real cross-entropy), **selectivity** (token
entropy of each unit's top activations, features vs. the residual stream's own basis directions),
**interpretation** (what fires a feature, from the corpus; what it writes, from its decoder
direction through the unembedding — measured independently), and **causal verification** (inject
the direction and sweep the strength). ~110 seconds end to end.

**Finding — the sparse code carries the computation.** Thirty-two features per token, out of 4096,
reconstruct 77.4% of the variance and recover **98.3%** of the model's language-modelling loss
(CE 3.83 real → 3.98 rebuilt → 13.23 with the layer's output deleted). 29 of 4096 features were
dead. GPT-2's layer-6 state is, to within 2% of its loss, a sum of about 32 nameable parts.

**Finding — the model's own coordinates really are blends.** On identical activations, learned
features score a median top-32 token entropy of **0.442** against **0.840** for residual-stream
basis directions, and **113 of 200** features clear an entropy < 0.5 selectivity bar against
**17 of 200** basis directions. The superposition claim, measured rather than asserted: read the
same state in the basis the model stores it in and you get mush; read it in a sparse overcomplete
basis and you get parts.

**Finding — a feature's two halves agree, and the agreement is causal.** What fires a feature and
what it writes are measured from different sources — corpus statistics and decoder weights — yet
they line up into single legible jobs:

| feature | fires on | its decoder direction promotes |
| --- | --- | --- |
| #1796 | ` Wonder` | ` Woman`, ` Bread`, ` Comics` |
| #1766 | ` New` | ` York`, ` Zealand`, ` Orleans` |
| #462 | ` worth` | ` consideration`, ` mentioning`, ` noting` |
| #2507 | `NAS`, `NYSE` | `DAQ`, `NYSE`, ` Dow` |
| #1653 | ` apt` | `itude`, `itudes` |
| #2440 | ` credit` | `worthiness`, ` card`, ` forgiven` |
| #1266 | ` Old` | ` fashioned`, ` timers`, `school` |
| #2479 | ` comic` | ` relief`, ` book`, ` strip` |

Then the strong test. Take the tokens a feature's *weights* name, inject that feature's direction
into `"The next thing that happened was"` — a prompt with nothing to do with any of them — and
sweep the strength. Those tokens go from effectively zero to a **median peak of 44% of the
model's probability mass**, and for **4 of 8** features the predicted token becomes the model's
actual output: #1796 fires only on ` Wonder`, its weights name ` Woman`, and at α = 40 the model
says **` Woman`** (P = 0.72, rising to 0.98). #1653 fires on ` apt`, names `itude`, and at α = 160
says `itude` at P = 0.99. The label was read off the weights *before* the intervention — so this
is a prediction confirmed, not a description fitted.

**Two things that had to be measured to get this working**, both worth recording because they are
invisible in the write-ups that describe the method:

1. **Position 0 has to be excluded.** GPT-2's first position is an attention sink: its layer-6
   residual norm is ~**3050** against ~**89** at every other position, a 34× outlier that
   otherwise dominates a squared-error objective outright. With it dropped the norm distribution
   is tight (median 88, p99 110).
2. **The ℓ₁ objective of RESEARCH.md §5 is dominated at this scale.** Compared at *matched
   sparsity* on an identical budget — same model, layer, dictionary size, tokens and epochs:

   | objective | L0 | variance explained | loss recovered | selective features |
   | --- | --- | --- | --- | --- |
   | TopK (k = 32) | 32.0 | **77.4%** | **98.3%** | **113 / 200** |
   | ℓ₁ (λ = 2.0) | 35.8 | 38.2% | 84.4% | 31 / 200 |

   ℓ₁ buys sparsity by shrinking *every* coefficient, load-bearing ones included, so it gives up
   half the variance and most of the interpretability to get there; pushed to λ = 4.0 it collapses
   outright to L0 = 2.5 and 3% of the variance. TopK drops the losers and leaves the winners
   unpenalized. The classic objective is still available (`--sparsity l1`) — it just needs far more
   scale than a laptop to compete.

**Scope.** One model, one layer, 4096 features, 120k tokens — a working instrument, not a frontier
one. Production dictionaries are millions of features over billions of tokens, and at this size
many features are token-identity detectors rather than the abstract concepts larger SAEs surface;
a handful lock onto BPE byte fragments. The selectivity metric measures *token* selectivity only,
so a genuinely context-selective feature scores badly on it. What is solid: the fidelity number,
the features-vs-basis gap, and the causal takeovers — all reproducible with one command.

### 9.1 Does scale make the features cleaner?

**Question.** The obvious follow-up: run the same dictionary on `gpt2-large` (774M, 36 layers,
d = 1280) and see whether a 6× bigger model holds cleaner features. Everything that could confound
it is held fixed — sparsity (k = 32), expansion ratio (F/d = 5.33, so F = 6827), tokens per
feature (~29, so 200k tokens), and epochs (20). Only the model changes.

**First answer: worse on every headline number.** At matched *relative* depth (layer 18 of 36
against layer 6 of 12), gpt2-large loses across the board — median feature entropy 0.442 → 0.565,
monosemantic features 113/200 → 83/200, variance explained 77.4% → 68.3%, causal takeovers 4/8 →
3/8. Its most selective features are whitespace and punctuation with incoherent readouts:
`\n` → *ONY, 2018, deen*; `~` → *=~=~, beta, FP*.

**But that comparison is confounded by depth, and §9's own depth sweep proves it.** On gpt2,
median entropy rose with depth (0.446 at L2 → 0.442 at L6 → **0.638** at L10) and causal takeovers
rose too (3/8 → 4/8 → **7/8**, since injecting nearer the output leaves fewer layers to wash the
signal out). gpt2-large's layer 18 sits squarely in that trend. Matching relative depth necessarily
unmatches absolute depth; you cannot have both. So the control is gpt2-large at **layer 6**,
absolute depth matched, everything else identical:

| | gpt2 L6 (124M) | gpt2-large L6 (774M) | gpt2-large L18 |
| --- | --- | --- | --- |
| median feature entropy | **0.442** | 0.507 | 0.565 |
| monosemantic (H < 0.5) | **113/200** | 98/200 | 83/200 |
| top token is a real word | 72% | **91%** | 62% |
| top token is byte junk | 12% | **0%** | 3% |
| variance explained | 77.4% | **79.5%** | 68.3% |
| loss recovered | **98.3%** | 97.8% | 95.3% |
| fires on ≥2 distinct words | 38% | **72%** | 41% |
| single-token detectors | 34% | **12%** | 44% |
| mean distinct word types | 2.16 | **2.94** | 1.53 |

**Finding — the features do get cleaner, and the selectivity metric says the opposite because it
rewards the wrong thing.** At matched depth, gpt2-large's byte-fragment features vanish entirely
(12% → 0%), nearly every feature keys on a real word (72% → 91%), and it reconstructs slightly
*better* despite a 67% wider residual stream. What it stops producing is the single-token detector:
34% → 12%. What it produces instead are features spanning several related words —

| gpt2-large L6 feature | fires on | writes |
| --- | --- | --- |
| #6556 | ` Isaiah`, ` prophetic` | `miah`, `iyah`, ` prophet`, ` Babel` |
| #5079 | ` Mueller`, ` investigation` | ` indicted`, `buster`, `hound` |
| #5322 | ` Moody`, ` outlook` | ` rating`, ` composite`, `graded` |
| #2154 | ` impe`, ` impeachment` | `aching`, `achable`, `ACH` |
| #4458 | ` pan` | `acea`, `orama`, `ographic` |

A feature that fires on *both* ` Isaiah` and ` prophetic` and writes ` prophet` is doing something
more concept-like than one that fires only on ` Wonder`. But token entropy scores it **worse**, by
construction: the metric measures how concentrated a feature's top activations are on one token
*type*, so a feature keyed to a concept rather than a string is penalized exactly for being more
abstract. gpt2's 0.442 is partly a measure of how many pure string-detectors it has.

The causal numbers are a depth artifact for the same reason: injecting at layer 6 of gpt2-large
leaves **30** layers of downstream processing, against 6 in gpt2. That gap — not feature
quality — is what 44.2% → 5.7% median peak probability measures.

**Scope, and what this costs the earlier claim.** 32 inspected features per run is a small sample,
"distinct word types" is a crude proxy for "concept," and this is one layer per model with one
dictionary configuration. The honest correction to §9 is narrower than the headline: the
features-vs-basis *selectivity lift* is real at both scales (1.90× and 1.57×), but the absolute
entropy number should not be read as an interpretability score across models of different sizes or
depths — it conflates "monosemantic" with "monolexical," and those come apart exactly where the
interesting features are.

**Why it matters here.** This is the same move Splice makes on its own decisions, one level down.
`JSpace.ts` decomposes an action score into named, inspectable contributions rather than trusting
a scalar; `features.py` decomposes a model's hidden state into named, inspectable parts rather
than trusting a neuron. In both cases the point is that the useful decomposition is *not* the one
the system happens to store — and that a decomposition is only worth anything once you can
intervene on it and predict what happens.

---

## Relation to prior work

Leave-one-out ablation, gradient saliency, activation steering, and logit-lens
readouts are all established (see [RESEARCH.md](RESEARCH.md)). Adjacent published
threads: Jacobian Scopes (token-level gradient attributions), robustness/margin
literature (adversarial distance-to-boundary), Geometry of Truth (Marks & Tegmark 2023),
and cross-layer feature analyses in the transcoder/SAE line. What we synthesize here:
(1) the *agent-decision geometry battery* (deletion robustness + flip distance +
participation-ratio dimension + load-bearing token) applied to LM next-token decisions,
(2) the confidence-vs-geometric-robustness calibration curve, (3) the per-layer
concept-vector *alignment × functional transport* pairing, (4) layerwise *entropy
deliberation trajectories*, and (5) the *latent truth subspace* projection.

## Reproduce / extend

```bash
cd lab && . .venv/bin/activate
python3 probes.py geometry --prompt "The Eiffel Tower is located in the city of"
python3 probes.py calibrate           # edit CALIBRATION_PROMPTS to scale up
python3 probes.py transport --concept "shouting"
python3 probes.py deliberation --prompt "The capital of the state containing Dallas is"
python3 probes.py truth --prompt "The earth revolves around the sun."
python3 probes.py all --out probes.json
python3 scaling.py --models distilgpt2,gpt2,gpt2-medium,gpt2-large   # the scaling study
```

