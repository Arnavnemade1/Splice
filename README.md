<div align="center">

<img src="assets/logo.svg" alt="Splice — two strands spliced into one" width="440">

### Browser cognition infrastructure for autonomous coding agents

[![CI](https://github.com/Arnavnemade1/Splice/workflows/CI/badge.svg)](https://github.com/Arnavnemade1/Splice/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-6+-3178c6.svg)](https://www.typescriptlang.org/)
[![Python](https://img.shields.io/badge/Python-3.10+-3776ab.svg)](https://www.python.org/)
[![MCP](https://img.shields.io/badge/MCP-ready-41e6a2.svg)](https://modelcontextprotocol.io/)

Splice is an **MCP server** that gives AI coding agents a browser they can actually reason about. It doesn't stop at screenshots or raw DOM — it diagnoses browser state, compiles natural-language intent into verified actions, redacts hostile page content, isolates multi-account sessions, coordinates multiple agents on shared browser state, and records the evidence agents need to recover and improve.

[Install](#install) · [Why Splice](#why-splice) · [Tool Reference](#tool-reference) · [Quick Start](#quick-start) · [Architecture](#architecture) · [Security Model](#security-model) · [Contributing](#contributing)

</div>

---

## Why Splice

**Splice does not run agents for you — it makes the agent you already have far more reliable, debuggable, and secure.**

Modern autonomous web agents fail because browsers are stateful, noisy, and adversarial. Splice adds a cognition and safety layer so agents can:

- understand *why* an action failed instead of retrying blindly,
- verify an action actually worked against declared postconditions,
- avoid prompt-injection and secret leakage from page content,
- recover from browser crashes and stale element references,
- run multiple isolated account sessions in parallel,
- coordinate several agents against one shared browser without stepping on each other, and
- introspect and improve their own behavior across a run.

> Splice is the cognitive browser layer for MCP-based agents — the safety and observability layer every agent stack should assume is present.

---

## Install

```bash
npm install splice
npx splice init      # scaffolds splice.config.json + prints MCP client snippets
npx splice doctor    # verifies Chromium, build output, and runtime deps
```

For Claude Code specifically, registration is one command:

```bash
claude mcp add splice -- npx -y splice start
```

See [AGENT_INSTALL.md](AGENT_INSTALL.md) for the deterministic, machine-checkable install path (written for agents installing themselves) and [INTEGRATION.md](INTEGRATION.md) for wiring Splice into a custom agent via the raw MCP SDK.

---

## Tool Reference

Splice exposes **62 MCP tools** over stdio, grouped below by what they're for. Full JSON schemas live in [src/index.ts](src/index.ts); this table is the map.

### Navigate & Observe
| Tool | What it does |
| --- | --- |
| `navigate` | Go to a URL — auto-retries transient failures, dismisses cookie banners, waits for stability. |
| `get_semantic_tree_optimized` | AI-optimized page tree pruned by intent, viewed through a lens (UX/Security/Performance/Network/Behavior/Vision), with `deltaOnly` mode for cheap incremental reads. |
| `wait_for` | Semantic waiting on text/element/URL/network conditions — replaces polling loops. |
| `get_network_activity` | Lifecycle-tracked requests with aggregates and a plain-English "what went wrong" summary. |
| `get_page_events` | Dialogs, popups, and downloads a DOM-only observer never sees. |
| `inspect_viewport` | Numbered-highlight screenshot plus structured data on video/canvas/iframe/slider/carousel widgets the tree under-reports. |
| `capture_annotated_screenshot` / `capture_node_screenshot` | Screenshots with bounding boxes, or of a single element, for vision-model use. |

### Act & Verify
| Tool | What it does |
| --- | --- |
| `diagnose_agent_state` | Classifies the page (ready, ui_obstruction, auth_required, captcha, navigation_pending, etc.) with a recommended next tool and a stuck-loop forecast. |
| `compile_verified_action` | The main way to act — compiles a structured intent into a ranked target with preconditions/postconditions, executes, and verifies against your declared `expect`. |
| `interact` | Low-level click/type/focus/select/press by element ID, with self-healing on stale references. |
| `fill_form` | Fills an entire form by human labels in one call, with honest per-field status and optional verified submit. |
| `extract_structured` | Schema-driven scraping — name fields, get back rows from tables/cards/label-value pairs with confidence scores. |
| `assert_page_state` | Cheap postcondition checks (URL/title/text/element) without a full tree read. |
| `run_accessibility_audit` | Deterministic WCAG audit scored 0–100, with fixes and how each failure degrades agent operation. |

### Sessions, Snapshots & Stealth
| Tool | What it does |
| --- | --- |
| `create_session` / `switch_session` / `list_sessions` / `save_session` / `destroy_session` | Isolated, named browser identities — separate cookies, storage, and fingerprint per account, saved logins restored automatically. |
| `get_stealth_profile` | Returns the active fingerprint plus a Web Bot Auth (Ed25519) directory so cooperative sites can verify signed requests. |
| `save_snapshot` / `load_snapshot` | Serialize or restore full session state (cookies, auth) instantly. |
| `fork_state` / `speculative_fork` / `commit_branch` | Clone browser state into background branches for shadow-testing risky actions or pre-loading URLs. |

### Recovery & Debugging
| Tool | What it does |
| --- | --- |
| `request_human_intervention` | Halts the agent and opens a visible Chromium window for a human to clear a CAPTCHA or blocker. |
| `debug_failure` | Saves a time-travel Playwright trace of the session. |
| `execute_script` | Arbitrary JS in the browser context. |
| `toggle_watch_mode` | Switch between headless and headful so a human can watch. |
| `get_runtime_health` | Browser connectivity, branch states, crash/recovery counters, uptime. |
| `export_run_journal` | Export the append-only log of every tool call, outcome, and error for post-mortem analysis. |
| `run_diagnostics` | Health-checks Playwright, Chromium, vault, and network connectivity. |
| `maintenance_cleanup` | Deletes old snapshots, traces, and reports. |

### Introspection & Self-Improvement
| Tool | What it does |
| --- | --- |
| `get_session_trace` | Live, ephemeral chain-of-thought — every intent, diagnosis, wait, and outcome from this session, nothing persisted. |
| `run_jacobian_lens` | Sensitivity analysis of target selection: which intent words are load-bearing, whether the choice flips without them; with `deep: true`, the exact analytic Jacobian, token geometry, flip boundaries, **and the decision workspace** — Splice's low-dimensional J-space analog (named concept axes, effective dimensionality, concept-direction SVD, softmax decision Jacobian). Its own pre-action workspace, not the model's hidden state. |
| `generate_behavior_report` | Scored, persisted digest of a run's chain of thought with prioritized self-improvement recommendations (written to `.splice/behavior/`). |
| `optimize_prompt` | Offline rewrite of a verbose/conversational prompt into the structured intent Splice ranks best, or a better-fit primitive call. |
| `generate_observability_report` | High-aesthetic, auto-refreshing HTML dashboard of session activity. |
| `get_product_intelligence` | Analyzes behavior logs (clicks, rage-clicks, friction) into feature recommendations. |

### Security
| Tool | What it does |
| --- | --- |
| `run_security_audit` | Crawls a URL checking headers, XSS surfaces, CSRF tokens, sensitive data exposure, and third-party deps; returns a structured, AI-actionable report. |
| `scan_local_secrets` | Scans the local workspace for hardcoded API keys/secrets before they leak. |
| `toggle_resource_blocking` | Blocks ads, trackers, and heavy media — on by default for agents. |

### Multi-Agent Coordination
| Tool | What it does |
| --- | --- |
| `register_agent` | Declares an agent's role (explorer, verifier, executor, auditor) for constraint and ownership tracking. |
| `get_canonical_context` | Pulls the Canonical Context Snapshot — the single shared source of truth replacing agent-to-agent messaging. |
| `acquire_branch_ownership` / `handoff_branch` | Claim or atomically transfer exclusive write access to a browser branch. |
| `promote_finding` / `resolve_conflict` | Push a finding to the Immutable Evidence Ledger; resolve quorum conflicts by confidence. |
| `get_coordination_health` | Live overhead metrics — conflicts, blocked actions, ownership violations. |
| `get_summons` / `acknowledge_summon` | List and accept pending human help requests. |
| `get_agent_analytics` | Per-agent success rate, latency, failure streaks, and ranked optimization directives. |

### Integrations
| Tool | What it does |
| --- | --- |
| `toggle_openclaw_gateway` | Enable/disable the local OpenClaw gateway (port 18789) for external agent connections. |
| `configure_discord_webhook` / `send_discord_update` | Wire up and send automated significant-event notifications to Discord. |

### MCP Resources
Beyond tools, Splice exposes resources: the raw semantic tree, telemetry data, a health/performance dashboard, a live heartbeat feed, the recommended agent playbook (`splice://guide/agent-playbook`), and the animated Splice logo.

---

## Quick Start

### Prerequisites
- Node.js `>=20`
- Python `>=3.10` (only if using the optional Python MCP server)

### From source
```bash
npm install
npm run build
npm start           # starts the MCP server (stdio)
npm test            # 49-step local validation against a synthetic web app
npm run test:regression   # known failure patterns: menus, validation, overlays, a11y
```

### CLI commands
| Command | Description |
| --- | --- |
| `splice start` | Start the MCP server (stdio) |
| `splice init` | Scaffold `splice.config.json` and print client registration snippets |
| `splice doctor` | Verify Playwright/Chromium/build/network before first launch |
| `splice config` | Inspect or edit local configuration |
| `splice session` | Manage saved session identities from the CLI |
| `splice report` | Generate a behavior or observability report |

### Recommended cognition loop
```
navigate → diagnose_agent_state → compile_verified_action (with expect) → verify via deltas
```
This loop, plus prompt hygiene and the self-improvement cycle, is documented in the `splice://guide/agent-playbook` MCP resource — read it first after connecting.

### Example: compiled verified action
```json
{
  "name": "compile_verified_action",
  "arguments": {
    "intent": "click the pricing link",
    "execute": true,
    "expect": [{ "kind": "url_contains", "value": "/pricing" }],
    "constraints": {
      "noNavigationOutsideDomain": true,
      "avoidDestructiveActions": true
    }
  }
}
```

### Example: batch form fill
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

```text
src/                    # TypeScript source — MCP server, tool implementations
  index.ts              # tool + resource registration (the 62 tools above)
  BrowserManager.ts      # launches browser instances, manages branches, recovers crashed pages
  SemanticExtractor.ts   # page understanding, delta-enabled observation
  AgentCoordinator.ts    # multi-agent branch ownership, evidence ledger, quorum
  AgentTracker.ts        # per-agent health metrics and optimization directives
  SecurityAuditor.ts     # prompt-injection redaction, secret egress protection, security audits
  RecoveryMemory.ts      # domain-scoped memory of which recovery fixes worked
  RunJournal.ts          # append-only JSONL log of every tool call and outcome
  SessionStore.ts        # named, isolated account sessions (cookies, storage, fingerprint)
  StealthProfile.ts      # coherent per-session fingerprints + Web Bot Auth directory
  JacobianLens.ts / JSpace.ts   # sensitivity analysis of target selection
  BehaviorReport.ts      # scored chain-of-thought digests and self-improvement recommendations
  PromptOptimizer.ts     # deterministic, offline intent rewriting
  AccessibilityAuditor.ts # WCAG audit engine
  Resilience.ts          # crash recovery, retries, graceful shutdown
  OpenClawGateway.ts / DiscordWebhook.ts / WebBotAuth.ts / CryptoManager.ts  # integrations & crypto
  cli.ts                 # splice start / init / doctor / config / session / report
dist/                   # compiled runtime output
dist_test/              # compiled tests
dashboard/              # local observability UI
python/                 # optional Python MCP server integration
assets/                 # logo and static resources
```

---

## Security Model

Splice is designed for autonomous agents operating in real browser environments:

- **Input isolation** — agents receive only audited, redacted page content; prompt injection is stripped before it reaches the model.
- **Output safety** — non-GET requests are inspected for secret patterns and blocked if unsafe; `scan_local_secrets` checks the local workspace too.
- **Session isolation** — each named session gets its own cookies, storage, and stable fingerprint, never shared across accounts.
- **Recovery transparency** — every crash, recovery, and coordination conflict is logged to the Run Journal and exportable for audit.

> Splice is not a sandbox replacement. It is a browser cognition and safety layer that helps agents act with evidence and accountability.

---

## Contributing

We welcome contributions. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations.

```bash
git clone https://github.com/Arnavnemade1/Splice.git
cd Splice
npm install
npm run build
npm test
```

---

## Need help?

- GitHub Issues: https://github.com/Arnavnemade1/Splice/issues
- License: MIT
- Homepage: https://github.com/Arnavnemade1/Splice#readme
