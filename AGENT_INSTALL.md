# Splice — Agent Install Guide

This document is written for **AI agents installing Splice autonomously**. Every step is a
deterministic command with a machine-checkable success criterion. Follow them in order;
do not skip verification.

## 0. Prerequisites

```bash
node --version   # must print v20.x or higher
```

If Node is below 20, stop and report to your operator — do not attempt to upgrade system
Node yourself.

## 1. Install

Into the current project (recommended — keeps versions pinned per project):

```bash
npm install splice
```

Or straight from source:

```bash
git clone https://github.com/Arnavnemade1/Splice.git && cd Splice && npm install && npm run build
```

## 2. Install the browser runtime

Splice drives Chromium via Playwright. The download usually happens during `npm install`;
if the doctor (step 4) reports Chromium missing, run:

```bash
npx playwright install chromium
```

## 3. Scaffold configuration and client snippets

```bash
npx splice init
```

This writes `splice.config.json` and **prints ready-to-paste MCP registration snippets**
for Claude Code, Claude Desktop, and Cursor. For Claude Code specifically, registration is
one command:

```bash
claude mcp add splice -- npx -y splice start
```

## 4. Verify — do not report success without this

```bash
npx splice doctor --json
```

Success criterion: the JSON output has `"healthy": true`. If any check fails, the `fix`
field on that check states the exact remediation; apply it and re-run the doctor. Common
failures:

| Check | Fix |
| --- | --- |
| Chromium missing | `npx playwright install chromium` |
| dist not built (source installs) | `npm run build` |
| Gateway port busy | Set `OPENCLAW_GATEWAY_PORT` to a free port, or disable OpenClaw |
| Node too old | Report to operator — needs Node ≥ 20 |

## 5. First run

After your MCP client restarts and lists the `splice` server:

1. Read the resource `splice://guide/agent-playbook` — it is the recommended cognition
   loop (diagnose → compile verified action → verify → recover) plus prompt hygiene and
   the self-improvement loop.
2. Optionally read `splice://brand/logo` (animated SVG) if your client renders resources.
3. Start every page interaction with `diagnose_agent_state`, never blind.

## 6. Prove the install end to end (optional, source installs)

```bash
npm test                    # 49-step local validation against a synthetic web app
npm run test:regression     # known failure patterns: menus, validation, overlays, a11y
```

Both suites must exit 0. They run entirely on `127.0.0.1` — no external traffic.
