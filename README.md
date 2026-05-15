# Splice Enterprise 🧬

> **Built for Agents. Hardened for the Web.**

Splice is an advanced, high-performance browser infrastructure and observability platform explicitly designed for Autonomous Coding Agents (like Claude Code, Cursor, and AutoGPT). Splice transforms chaotic, dynamic web interfaces into structured, safe, and highly-optimized data streams, ensuring agents can safely interact with the web without hallucinating or triggering security breaches.

## Features

- **Agentic Security Firewall (V5)**: Proactively redacts prompt injection attempts hidden in the DOM, blocks exfiltration of local secrets, and prevents Arbitrary Code Execution (ACE) before it reaches the agent's LLM context.
- **Deep Behavioral Telemetry (V4)**: The "Sentinel" tracking engine intercepts scrolling, element visibility, and form abandonment to feed actionable, data-driven product intelligence straight back to the agent.
- **Semantic Extraction Engine**: Translates complex DOM structures (including Shadow DOM and modern SPAs) into an optimized JSON "Semantic Tree," dropping noisy tags and drastically saving context window tokens.
- **Self-Healing Interactions**: Dynamic DOM elements changing their attributes? Splice uses heuristics to find and click the element the agent *intended* to click, drastically reducing interaction errors on modern web apps.
- **Cinematic Command Center**: A globally unified observability dashboard that tracks Live Heartbeats, Threat Mitigation, and Behavioral Friction in real-time.

## Installation

```bash
git clone https://github.com/Arnavnemade1/Splice.git
cd Splice
npm install
npm run build
```

## Running the Platform

To launch the Splice MCP server:
```bash
node dist/index.js
```

Or you can start the interactive demo to view the observability engine in action:
```bash
npm run build
npx tsx demo.ts
```
*(The Splice Command Center will automatically open in your browser).*

## Architecture
Splice is built on top of **Playwright**, operating entirely in a highly speculative browser environment. It uses an embedded **Model Context Protocol (MCP)** server to easily hook into any MCP-compatible agent system. Data persistence is managed securely using `AES-256-GCM` encryption via an onboard CryptoManager.

## License
MIT License. See [LICENSE](LICENSE) for details.
