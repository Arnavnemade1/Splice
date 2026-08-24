# Model Mind Lab

See a real model think. This lab runs the interpretability experiments from
Anthropic's research program — described with sources in [RESEARCH.md](RESEARCH.md) —
on a real open-weights model, from scratch, on your CPU. One file, no API keys,
no cloud: [mindlab.py](mindlab.py).

| Experiment | What you see | Method family |
| --- | --- | --- |
| `jacobian` | which input words carry the prediction, and the dominant sensitivity mode (SVD) | Jacobian scopes / saliency — the model-side sibling of Splice's `JSpace.ts` |
| `lens` | the answer crystallizing layer by layer through the model's own readout | logit lens |
| `patch` | a layer × position heatmap of *where* the computation lives (IOI task) | activation patching / causal tracing |
| `steer` | a concept vector injected at increasing strength — sweet spot → incoherence | concept injection (the introspection-experiment protocol) |
| `attention` | the induction heads that implement in-context learning | induction-head scan |
| `ablation` | how localized a fact is — top MLP neurons by attribution, verified by real ablation, plus the *effective neuron count* (superposition measure) | neuron ablation / attribution patching |
| `knockout` | a 12×12 causal map of which attention heads *cause* the answer (heads that support vs. oppose it) | attention-head knockout |
| `reasoning` | a two-hop trace — does the intermediate *bridge* concept surface in the middle layers before the answer? Watch multi-step reasoning form (and see it strengthen with scale) | multi-hop / bridge tracing via the logit lens |
| `deliberation` | Shannon entropy $H(l)$ and top margin across depth — classifies cognitive modes (Immediate Retrieval vs Deliberative Phase-Transition vs Unresolved) | entropy trajectories / information bottleneck |
| `truth` | projection of residual vectors onto the contrastive truth direction — probing latent belief vs surface generation | linear representations of truth (Geometry of Truth) |
| `report` | all ten in one HTML page — add `--interactive` for an explorable version | — |

[`features.py`](features.py) runs the one part of the research program the lab was missing:
**sparse dictionary learning** (RESEARCH.md §5). It trains an overcomplete sparse autoencoder
from scratch on real web text and pulls monosemantic features back out of superposition —
then checks them the hard way, by injecting a feature's own direction and watching the model
say what the feature's weights predicted it would.

Beyond replication, [`probes.py`](probes.py) runs measurements that haven't been done
this way before — Splice's decision-geometry battery pointed at a real transformer,
confidence-vs-fragility calibration, cross-layer concept transport, fact
**localization** (how many neurons and which heads carry a prediction), layerwise
**deliberation dynamics**, and **latent truth subspaces** — with the
findings and honest novelty framing written up in [NOVEL.md](NOVEL.md). Run
`python3 probes.py all --interactive` for an explorable HTML report of all six. Two
scaling studies (§4–5) are recorded too: the calibration one as a self-contained
interactive page ([results/scaling-report.html](results/scaling-report.html)).

## Run it

```bash
cd lab
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt        # torch (CPU), transformers, numpy
python3 mindlab.py report              # gpt2 (124M) downloads on first run
python3 mindlab.py report --interactive   # explorable page: scrub, toggle, hover
open mindlab-report.html
```

`--interactive` folds the hand-built artifact quality back into the tool: any
model and prompt produces its own explorable page — a scrubbable logit lens,
toggleable saliency, hoverable patching and knockout heatmaps, a concept-injection
stepper, neuron/head importance bars, entropy deliberation curves, and truth projections.
Built by [interactive.py](interactive.py), self-contained and theme-aware.

Single experiments print JSON:

```bash
python3 mindlab.py jacobian --prompt "The capital of France is"
python3 mindlab.py steer --concept "shouting" --layer 6 --alphas 0,6,12,20
python3 mindlab.py patch   # classic John/Mary indirect-object task
python3 mindlab.py deliberation --prompt "The capital of France is"
python3 mindlab.py truth --statement "The earth revolves around the sun."
```

Dictionary learning has its own entry point — it trains, so it takes a couple of
minutes rather than seconds:

```bash
python3 features.py                      # gpt2 layer 6: harvest, train, interpret, verify (~110s)
python3 features.py --layer 10 -k 16     # a different depth, a sparser code
python3 features.py --sparsity l1        # the classic L1 objective instead of TopK
```

It fetches ~8 MB of real web text (Pile OpenWebText2 — GPT-2's own training
distribution) over range requests, caches it in `lab/.cache/`, and writes
`results/features.json`. Findings in [NOVEL.md §9](NOVEL.md).

`--model` accepts any **GPT-2** checkpoint (`gpt2`, `distilgpt2`, `gpt2-medium`, `gpt2-large`)
or any **GPTNeoX / Pythia** checkpoint (`EleutherAI/pythia-70m` … `pythia-1.4b`) — the `Lab`
class detects the architecture and routes every hook accordingly. Pythia is a deliberate
single-architecture scale ladder, used in [NOVEL.md §6](NOVEL.md) to confirm the scaling
findings hold beyond the GPT-2 family.

## Honest scope

The lab operates on weights you hold locally. It makes no claim about any hosted
model's internals — the same honest-scope line drawn across the Splice codebase.
Splice's J-space models *Splice's own* decision workspace; the lab asks the same
questions (sensitivity, geometry, localization, steering, deliberation, truth) *for real*
of a model you can open. For frontier-grade circuit analysis on open models, use Anthropic's
[`circuit-tracer`](https://github.com/safety-research/circuit-tracer) with the
Neuronpedia frontend — this lab is the from-scratch, read-every-line version.
