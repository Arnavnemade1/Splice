# How an AI thinks — the research behind the Model Mind Lab

Splice's J-space machinery models **Splice's own** pre-action decision workspace — an
honest structural analog, never a claim about the calling model's hidden state. This
document is the other half of that story: what is actually known about looking *inside*
a language model, which experiments Anthropic ran to do it, and which of those methods
this repo's `lab/mindlab.py` implements from scratch on a real open model.

---

## 1. The experiment families

### 1.1 Features and circuits — "what concepts, wired how"

Anthropic's interpretability program treats the model's residual stream as a space of
**directions**, where interpretable concepts ("features") are linear-ish directions and
computations are circuits of features feeding features.

- **Towards / Scaling Monosemanticity (2023–2024)** — dictionary learning (sparse
  autoencoders) decomposes activations into millions of interpretable features
  (including the famous Golden Gate Bridge feature, which, when amplified, made Claude
  identify as the bridge).
- **Circuit Tracing + On the Biology of a Large Language Model (March 2025)** —
  cross-layer transcoders replace MLPs with sparse interpretable "replacement neurons,"
  enabling **attribution graphs**: local causal maps from input tokens through
  intermediate features to the output. Findings from Claude 3.5 Haiku include:
  - **Planning in poetry**: the model picks candidate rhyme words *before* writing the
    line, then writes toward them — visible as target-word features active early.
  - **Multi-hop reasoning**: "capital of the state containing Dallas" activates
    *Texas* features between *Dallas* and *Austin* — a genuine intermediate step.
  - **A universal "language of thought"**: shared features across English/French/Chinese.
  - **Unfaithful chain-of-thought**: cases where the written reasoning does not match
    the mechanism the graph reveals (motivated reasoning working backward from hints).
- **Open-sourcing (May 2025)** — the `circuit-tracer` library generates attribution
  graphs for open-weights models (demonstrated on Gemma-2-2b and Llama-3.2-1b, using
  GemmaScope transcoders), explorable in a Neuronpedia frontend, with feature-level
  interventions ("modify feature values and observe how outputs change").

**Lab status**: attribution graphs need pre-trained transcoders per model — out of scope
for a from-scratch lab. For that tier, use
[`circuit-tracer`](https://github.com/safety-research/circuit-tracer) + Neuronpedia.
Everything below is implemented here directly.

### 1.2 Steering and injection — "thoughts as directions you can push"

- **Activation steering / Golden Gate Claude**: add a feature direction into the
  residual stream and the model's "thoughts" visibly bend around it.
- **Persona Vectors (July 2025)**: an automated pipeline extracts directions for
  character traits (evil, sycophancy, hallucination-propensity) from *contrastive
  prompt pairs*; movement along these directions predicts and controls personality
  shifts.
- **The Assistant Axis (Jan 2026)**: across Gemma-2-27B, Qwen-3-32B, Llama-3.3-70B, the
  leading component of 275 persona directions is a single axis measuring "how
  Assistant-like" the model currently is; capping activations along it resists
  persona jailbreaks.
- **Emergent Introspective Awareness (Oct 2025)** — the methodological gem. Protocol:
  1. Compute a concept vector: activations in a concept context minus a control context.
  2. **Inject** it into unrelated activations at a chosen layer and strength.
  3. Ask the model whether it notices an injected thought — comparing self-report
     against *ground truth you control* separates real introspection from confabulation.
  Claude Opus 4.1 noticed injections ~20% of the time (near-zero false positives),
  detecting them *before* the concept surfaced in output — and only inside a strength
  "sweet spot": too weak is unnoticed, too strong causes incoherence. Follow-ups
  (prefill-intent and think/don't-think experiments) showed models consult internal
  state, and can modulate concept representations on instruction or incentive.

**Lab status**: implemented as `steer` — contrastive concept vectors, layer injection,
strength sweep (the sweet spot is directly observable as coherence collapse at high α).

### 1.3 Causal localization — "where does the computation live"

**Activation patching / causal tracing** (Meng et al. 2022's ROME popularized it; it is
the workhorse behind circuit analysis): run a *clean* prompt and a *corrupted* one,
swap the clean activation into the corrupted run at one (layer, position), and measure
how much of the correct answer returns. High-recovery cells localize the computation.

**Neuron ablation & superposition.** Dictionary-learning (Towards/Scaling
Monosemanticity) established that a single MLP neuron is usually *polysemantic* —
features are in superposition, spread across many neurons rather than one-to-one.
Zeroing individual neurons and measuring the effect on a specific prediction tests
how localized a fact is; gradient×activation attribution estimates every neuron's
contribution in one backward pass, which the exact ablation then confirms.

**Attention-head knockout.** The causal complement to correlational head analysis
(and to the IOI circuit of Wang et al. 2022): zero one attention head at a time and
measure the change in the answer's logit — heads whose removal *hurts* the answer are
the ones doing the work (name-mover heads), and some heads measurably *oppose* it
(negative/backup heads).

**Lab status**: implemented as `patch` (full layer × position residual-stream
recovery heatmap), `ablation` (top MLP neurons by attribution, verified by real
ablation, plus the participation-ratio *effective neuron count* — a superposition
measure), and `knockout` (the 12×12 causal head-importance map on the IOI task,
recovering GPT-2's documented name-mover heads and its negative heads).

### 1.4 The Jacobian space — "first-order sensitivity, exactly"

The gradient lineage (saliency → input×gradient → integrated gradients →
**Jacobian Scopes**, Jan 2026) computes token-level causal attributions as derivatives
of outputs with respect to input embeddings — the local linear map (the Jacobian) of
the model around one input. Jacobian Scopes generalizes this to attributions onto
specific logits, the full predictive distribution, and model uncertainty.

This is the direct big sibling of Splice's own J-space: Splice reads the exact
Jacobian of its *linear intent scorer*; a model lab differentiates a *nonlinear
transformer* to get the same object locally. Same geometry, same questions — which
inputs carry the decision, how concentrated is the sensitivity, where are the flip
boundaries.

**Lab status**: implemented as `jacobian` — per-token saliency (gradient norm and
input×gradient) for the predicted token, plus an SVD of the token×logit Jacobian
(dominant input-mix → output-mix sensitivity mode, mirroring `JSpace.ts`'s spectrum).

### 1.5 Watching the thought form — logit lens & induction heads

- **Logit lens** (nostalgebraist, 2020; echoed in Anthropic's features-across-layers
  analyses): decode the residual stream after *every* layer through the final
  layer-norm + unembedding. Early layers are noise; somewhere the answer crystallizes;
  the depth at which it does is a real signature of "when the model has decided."
- **Induction heads** (Olsson et al., 2022, transformer-circuits): attention heads
  implementing `[A][B] … [A] → [B]` — the mechanism behind in-context learning,
  identifiable by their prefix-matching attention pattern on repeated sequences.

**Lab status**: implemented as `lens` (per-layer top tokens + answer-probability
trajectory) and `attention` (induction-head scan on repeated random sequences +
attention grids).

---

## 2. What the lab is, and is not

`mindlab.py` runs **real experiments on real weights** — GPT-2-class open models on
CPU, PyTorch hooks, no API keys, no cloud. It is deliberately from-scratch: every
number is computed by code you can read in one file, so it doubles as an executable
explanation of the methods above.

It is **not** a claim about any hosted frontier model's internals. Splice-the-MCP-server
still cannot see the calling model's activations — that honest-scope line is unchanged.
The lab exists so the same questions Splice asks of its own decision workspace
(sensitivity, geometry, hazards, "why this choice") can be asked *for real* of a model
whose weights you hold.

| Question | Splice J-space (scorer) | Mind Lab (real model) |
| --- | --- | --- |
| Which inputs carry the decision? | exact scorer Jacobian | input-embedding Jacobian (saliency) |
| How concentrated is sensitivity? | power-iteration SVD of J | SVD of token×logit Jacobian |
| Where does the decision live? | concept-feature workspace | activation patching (layer × position) |
| When is the decision made? | pre-action (single step) | logit lens (layer where answer crystallizes) |
| Can we push the thought? | intent reweighting / flip boundaries | concept-vector injection (steering) |
| Ground-truth introspection? | calibration vs verified outcomes | injected-concept protocol (strength sweep) |

---

## 3. Sources

- [Tracing the thoughts of a large language model](https://www.anthropic.com/research/tracing-thoughts-language-model) — Anthropic, March 2025
- [On the Biology of a Large Language Model](https://transformer-circuits.pub/2025/attribution-graphs/biology.html) — Transformer Circuits, March 2025
- [Open-sourcing circuit tracing tools](https://www.anthropic.com/research/open-source-circuit-tracing) — Anthropic, May 2025 · [`circuit-tracer`](https://github.com/safety-research/circuit-tracer)
- [Emergent introspective awareness in large language models](https://www.anthropic.com/research/introspection) — Anthropic, October 2025
- [Persona Vectors: Monitoring and Controlling Character Traits in Language Models](https://arxiv.org/abs/2507.21509) — July 2025
- [The Assistant Axis](https://www.anthropic.com/research/assistant-axis) — Anthropic, January 2026 · [`assistant-axis`](https://github.com/safety-research/assistant-axis)
- [Jacobian Scopes: token-level causal attributions in LLMs](https://arxiv.org/abs/2601.16407) — January 2026
- [Locating and Editing Factual Associations in GPT](https://arxiv.org/abs/2202.05262) (ROME / causal tracing) — Meng et al., 2022
- [In-context Learning and Induction Heads](https://transformer-circuits.pub/2022/in-context-learning-and-induction-heads/index.html) — Olsson et al., 2022
- [Interpreting GPT: the logit lens](https://www.lesswrong.com/posts/AcKRB8wDpdaN6v6ru/interpreting-gpt-the-logit-lens) — nostalgebraist, 2020
