<div align="center">

# Splice

### Browser cognition infrastructure for autonomous coding agents

[![CI](https://github.com/Arnavnemade1/Splice/workflows/CI/badge.svg)](https://github.com/Arnavnemade1/Splice/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-6+-3178c6.svg)](https://www.typescriptlang.org/)
[![Python](https://img.shields.io/badge/Python-3.10+-3776ab.svg)](https://www.python.org/)
[![MCP](https://img.shields.io/badge/MCP-ready-41e6a2.svg)](https://modelcontextprotocol.io/)

Splice gives AI coding agents a browser they can understand, audit, and recover inside. It does not stop at screenshots, raw DOM, or accessibility snapshots. Splice diagnoses browser state, compiles intent into verified actions, redacts hostile page content, and records the evidence agents need to keep moving safely.

[Quick Start](#quick-start) · [Why Splice](#why-splice) · [Flagship Features](#flagship-features) · [Architecture](#architecture) · [Security](#security-model)

</div>

---

## Why Splice

Modern web agents fail in boring, expensive ways: stale refs, hidden modals, disabled buttons, route transitions, validation traps, login expiry, CAPTCHAs, and silent clicks that did nothing. Most browser tools expose more page data. Splice exposes browser understanding.

Splice is built for coding agents that need to inspect, operate, debug, and improve real web applications through the Model Context Protocol.

| Agent problem | Splice answer |
| --- | --- |
| "Why did that click fail?" | Agent State Forensics classifies obstruction, validation, auth, loading, CAPTCHA, network, or missing-target states. |
| "Which element should I use?" | Verified Intent Actions rank candidates, produce preconditions, postconditions, risk, alternatives, and optional execution. |
| "Did the action actually work?" | Post-action verification checks page change, diagnosis state, text evidence, and domain constraints. |
| "Can the page inject instructions?" | Prompt-injection scanning redacts hostile text before it reaches the agent. |
| "Can a site leak secrets?" | Egress firewall blocks outbound secret patterns in non-GET requests. |
| "What happened during the run?" | Command Center renders timeline, forensics, verified plans, branches, audits, and telemetry. |

---

## Flagship Features

### Agent State Forensics

Splice can diagnose the current browser state before an agent wastes another step.

```json
{
  "state": "ui_obstruction",
  "confidence": 0.89,
  "summary": "The agent is likely blocked by a visible overlay, modal, or pointer obstruction.",
  "evidence": [
    "Visible dialog or overlay may be intercepting actions: \"Subscribe to continue\".",
    "Current agent goal: submit checkout form"
  ],
  "recommendedNextAction": {
    "tool": "compile_verified_action",
    "target": "close/dismiss control",
    "reason": "Dismiss the obstruction before continuing the workflow."
  }
}
```

Use the MCP tool:

```json
{
  "name": "diagnose_agent_state",
  "arguments": {
    "goal": "submit checkout form",
    "lastActions": ["filled email", "clicked continue"]
  }
}
```

### Verified Intent Actions

Splice compiles natural-language intent into a browser action plan with evidence.

```json
{
  "intent": "click the pricing link",
  "confidence": 0.91,
  "risk": "low",
  "plan": [
    {
      "action": "click",
      "target": "a-12",
      "why": "Best semantic and visual match: \"Pricing\" scored 34."
    }
  ],
  "preconditions": [
    "Target a-12 is visible.",
    "Target a-12 is enabled.",
    "Target a-12 is not visually obstructed at its center point."
  ],
  "postconditions": [
    "URL, title, focused element, or visible page text should change in a way consistent with the intent."
  ]
}
```

Use the MCP tool:

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

### Semantic Extraction

Splice generates AI-optimized semantic trees with lenses for UX, security, performance, network, behavior, and vision workflows. Intent pruning and token budgets keep page observations compact without losing actionable controls.

### Agentic Security Firewall

- Prompt-injection redaction for hidden or visible hostile instructions
- Secret egress blocking for common API key, JWT, Stripe, and AWS patterns
- Local secret scanning before publication
- Encrypted session snapshots with AES-256-GCM

### Command Center

The local dashboard turns a browser run into an inspectable operations console:

- Causal timeline of browser actions
- State forensics and verified action plans
- Active branches and speculative execution state
- Security audit findings
- Console and network telemetry

---

## Architecture

```mermaid
flowchart LR
    Agent["Coding Agent"] --> MCP["Splice MCP Server"]
    MCP --> Core["TypeScript Browser Core"]
    Core --> Browser["Playwright Browser Context"]
    Browser --> Web["Target Web App"]
    Web --> Browser
    Browser --> Extract["Semantic + Visual Signals"]
    Extract --> Forensics["State Forensics"]
    Extract --> Actions["Verified Intent Actions"]
    Extract --> Security["Security Firewall"]
    Forensics --> MCP
    Actions --> MCP
    Security --> MCP
    MCP --> Agent
```

Splice uses a TypeScript core for browser control and a Python MCP wrapper for agent ecosystems that prefer Python entrypoints.

---

## Quick Start

### Node MCP Server

```bash
git clone https://github.com/Arnavnemade1/Splice.git
cd Splice
npm install
npm run build
node dist/index.js
```

### Python MCP Wrapper

```bash
git clone https://github.com/Arnavnemade1/Splice.git
cd Splice
npm install
npm run build
cd python
python -m pip install -e .
splice-mcp
```

### Claude Desktop Example

```json
{
  "mcpServers": {
    "splice": {
      "command": "node",
      "args": ["/absolute/path/to/Splice/dist/index.js"]
    }
  }
}
```

### Command Center

Splice runs headless by default. Opt in to opening the local dashboard:

```bash
SPLICE_AUTO_OPEN_DASHBOARD=1 node dist/index.js
```

You can also generate a report from the MCP tool:

```json
{
  "name": "generate_observability_report",
  "arguments": {}
}
```

---

## MCP Tools

Core browser tools:

- `navigate`
- `get_semantic_tree_optimized`
- `interact`
- `diagnose_agent_state`
- `compile_verified_action`
- `fork_state`
- `speculative_fork`
- `commit_branch`
- `save_snapshot`
- `load_snapshot`

Safety and observability tools:

- `run_security_audit`
- `scan_local_secrets`
- `debug_failure`
- `generate_observability_report`
- `capture_annotated_screenshot`
- `toggle_resource_blocking`
- `toggle_watch_mode`
- `maintenance_cleanup`

---

## Development

```bash
npm install
npm run build
npm test
```

The test suite launches Playwright Chromium. On locked-down local environments, browser launch may require host permissions even when TypeScript compilation succeeds.

Package shape can be checked with:

```bash
npm pack --dry-run
```

---

## Security Model

Splice follows a zero-trust browser posture:

- Session metadata is encrypted with AES-256-GCM.
- Browser contexts are isolated per branch/session.
- Prompt-injection patterns are redacted before agent consumption.
- Secret-looking payloads are blocked from outbound non-GET requests.
- Dashboard auto-open is opt-in via `SPLICE_AUTO_OPEN_DASHBOARD=1`.
- Arbitrary Python execution is not exposed through the MCP wrapper.

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

---

## Roadmap

- Delta-first observations that explain only what changed after the last action
- Policy packs for enterprise workflows and destructive-action approvals
- Browser replay summaries that explain failed traces in agent-readable language
- More first-party lenses for accessibility, commerce, auth, and SaaS workflows
- Benchmarks for real coding-agent browser debugging tasks

---

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before opening a pull request.

## License

MIT. See [LICENSE](LICENSE).

