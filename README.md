<div align="center">

<img src="assets/logo.svg" alt="Splice — two strands spliced into one" width="440">

### Browser cognition infrastructure for autonomous coding agents

[![CI](https://github.com/Arnavnemade1/Splice/workflows/CI/badge.svg)](https://github.com/Arnavnemade1/Splice/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-6+-3178c6.svg)](https://www.typescriptlang.org/)
[![Python](https://img.shields.io/badge/Python-3.10+-3776ab.svg)](https://www.python.org/)
[![MCP](https://img.shields.io/badge/MCP-ready-41e6a2.svg)](https://modelcontextprotocol.io/)

Splice gives AI coding agents a browser they can understand, audit, and recover inside. It does not stop at screenshots, raw DOM, or accessibility snapshots. Splice diagnoses browser state, compiles intent into verified actions, redacts hostile page content, and records the evidence agents need to keep moving safely.

[Quick Start](#quick-start) · [Why Splice](#why-splice) · [Core Features](#core-features) · [Getting Started](#getting-started) · [Example Usage](#example-usage) · [Architecture](#architecture) · [Security](#security-model) · [Contributing](#contributing)

</div>

---

## Table of Contents

- [Why Splice](#why-splice)
- [Core Features](#core-features)
- [Getting Started](#getting-started)
- [Quick Start](#quick-start)
- [Example Usage](#example-usage)
- [Architecture](#architecture)
- [Security Model](#security-model)
- [Contribution Guide](#contribution-guide)
- [Need help?](#need-help)

---

---

## Why Splice

**Splice does not run agents for you — it makes the agent you already have far more reliable, debuggable, and secure.**

Modern autonomous web agents fail because browsers are stateful, noisy, and adversarial. Splice adds browser cognition and safety layers so agents can:

- understand why an action failed,
- verify that it actually worked,
- avoid prompt-injection and secret leakage,
- recover from browser crashes, and
- optimize future runs with domain memory.

> Splice is the cognitive browser layer for MCP-based agents: the safety and observability layer every agent stack should assume is present.

---

## Core Features

### 🧠 Browser Cognition

- `diagnose_agent_state` — identify overlays, hidden modals, auth failures, navigation traps, CAPTCHAs, and stale references.
- `compile_verified_action` — turn intent into a verifiable browser plan with expected outcomes, preconditions, and postconditions.
- `get_semantic_tree_optimized` — semantic page understanding with optional `deltaOnly` updates.
- `wait_for` — semantic waiting without repeated full page reads.

### 🔄 Runtime Reliability

- self-healing Chromium recovery
- typed error taxonomy (`BROWSER_CRASHED`, `TIMEOUT`, `TARGET_NOT_FOUND`, etc.)
- append-only JSONL Run Journal for replay and audit
- process-level guards and graceful shutdown

### 🔐 Security & Observability

- prompt injection redaction before content reaches agents
- secret egress firewall on outbound requests
- network and page event cognition
- local dashboard and evidence export

### 🧩 Agent Optimization

- live agent tracking with health metrics and corrective directives
- recovery memory that learns which fixes worked per domain
- token efficiency engine to reduce unnecessary observation cost

---

## Getting Started

### Prerequisites

- Node.js `>=20`
- npm
- Python `>=3.10` for the optional MCP server integration

### Install

```bash
npm install
```

### Build

```bash
npm run build
```

### Run locally

```bash
npm start
```

### Run tests

```bash
npm test
```

> Need full coverage? Use `npm run test:all`.

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Build Splice

```bash
npm run build
```

### 3. Start the CLI server

```bash
npm start
```

### 4. Connect your agent

Use the MCP SDK to call tools like `diagnose_agent_state`, `compile_verified_action`, `wait_for`, and `fill_form`.

<details>
<summary>TypeScript example</summary>

```ts
import { SpliceClient } from 'splice';

const splice = new SpliceClient({ url: 'http://localhost:9000' });

const diagnosis = await splice.call('diagnose_agent_state', {
  goal: 'checkout with the current cart',
  lastActions: ['added item', 'clicked view cart'],
});

console.log(diagnosis);
```

</details>

<details>
<summary>Python MCP server example</summary>

```bash
cd python
python -m pip install -r requirements.txt
python splice_mcp/server.py
```

</details>

---

## Example Usage

### CLI commands

| Command | Description |
| --- | --- |
| `npm start` | Start the Splice server |
| `npm run doctor` | Validate local environment and runtime dependencies |
| `npm test` | Build and run the test suite |
| `npm run test:regression` | Run regression-focused tests |
| `npm run clean` | Remove build artifacts |

### Tool call example

```json
{
  "name": "compile_verified_action",
  "arguments": {
    "intent": "click the pricing link",
    "execute": true,
    "constraints": {
      "noNavigationOutsideDomain": true,
      "avoidDestructiveActions": true
    }
  }
}
```

### `fill_form` example

```json
{
  "name": "fill_form",
  "arguments": {
    "fields": [
      { "field": "email", "value": "user@example.com" },
      { "field": "password", "value": "s3cureP@ss" }
    ],
    "submitIntent": true
  }
}
```

---

## Architecture

Splice is built as a modular browser cognition platform with these main layers:

- **Browser Manager** — launches browser instances, manages branches, and recovers crashed pages.
- **Semantic Extractor** — builds page understanding and provides delta-enabled updates.
- **Agent Coordinator** — tracks agent health, failure patterns, and optimization directives.
- **Security Auditor** — redacts prompt injection and enforces secret egress protections.
- **Run Journal** — logs every tool call, result, and recovery event for reproducibility.

### Workspace layout

```text
src/                # TypeScript source
dist/               # compiled runtime output
dist_test/          # compiled tests
dashboard/          # observability frontend and local UI assets
python/             # optional Python MCP server integration
assets/             # logo and static resources
README.md           # project documentation
```

---

## Security Model

Splice is designed for autonomous agents operating in real browser environments. Key security principles:

- **Input isolation**: agents receive only audited, redacted page content.
- **Output safety**: non-GET requests are inspected for secret patterns and blocked if unsafe.
- **Recovery transparency**: every recovery event is logged to the Run Journal.

> Splice is not a sandbox replacement. It is a browser cognition and safety layer that helps agents act with evidence and accountability.

---

## Contribution Guide

We welcome contributions from the community.

### How to contribute

- Fork the repository
- Create a feature branch
- Run `npm install`
- Build with `npm run build`
- Add or update tests
- Submit a pull request with a clear description

### Helpful resources

- `tsconfig.json` — TypeScript config
- `tsconfig.test.json` — test build config
- `package.json` — npm scripts and dependencies
- `dashboard/` — local UI and audit tooling
- `python/` — Python MCP server example

---

## Need help?

- GitHub Issues: https://github.com/Arnavnemade1/Splice/issues
- License: MIT
- Homepage: https://github.com/Arnavnemade1/Splice#readme

---

## Championing Better Agent Browsing

Splice is built to make browser automation less brittle, more explainable, and safer for agent workloads. If you want agents that do more than click, this repository is your starting point.
