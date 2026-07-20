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
| `report` | all seven in one HTML page — add `--interactive` for an explorable version | — |

Beyond replication, [`probes.py`](probes.py) runs measurements that haven't been done
this way before — Splice's decision-geometry battery pointed at a real transformer,
confidence-vs-fragility calibration, cross-layer concept transport, and fact
**localization** (how many neurons and which heads carry a prediction) — with the
findings and honest novelty framing written up in [NOVEL.md](NOVEL.md). Run
`python3 probes.py all --interactive` for an explorable HTML report of all four. Two
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
stepper, and neuron/head importance bars. Built by [interactive.py](interactive.py),
self-contained and theme-aware.

Single experiments print JSON:

```bash
python3 mindlab.py jacobian --prompt "The capital of France is"
python3 mindlab.py steer --concept "shouting" --layer 6 --alphas 0,6,12,20
python3 mindlab.py patch   # classic John/Mary indirect-object task
```

`--model` accepts any GPT-2-family checkpoint (`gpt2`, `distilgpt2`, `gpt2-medium`).

## Honest scope

The lab operates on weights you hold locally. It makes no claim about any hosted
model's internals — the same honest-scope line drawn across the Splice codebase.
Splice's J-space models *Splice's own* decision workspace; the lab asks the same
questions (sensitivity, geometry, localization, steering) *for real* of a model
you can open. For frontier-grade circuit analysis on open models, use Anthropic's
[`circuit-tracer`](https://github.com/safety-research/circuit-tracer) with the
Neuronpedia frontend — this lab is the from-scratch, read-every-line version.
