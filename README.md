<div align="center">
  <img src="assets/logo.png" alt="Splice Logo" width="300" />
  
  # Splice
  **The Vercel for Agentic Browsing**
  
  [![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
  [![Playwright](https://img.shields.io/badge/Playwright-2EAD33?style=for-the-badge&logo=playwright&logoColor=white)](https://playwright.dev/)
  [![MCP](https://img.shields.io/badge/Model_Context_Protocol-4A4A4A?style=for-the-badge)](https://modelcontextprotocol.io/)
</div>

<br />

> **Stop paying the "Human Tax".** Standard browsers are built for eyeballs. Splice is built for AI. It translates the visual web into high-density, semantic data streams, saving developers thousands of dollars in LLM context costs while providing deterministic control over complex agentic workflows.

## The Enterprise Edge

Why use Splice instead of raw Playwright or standard headless Chrome?

- **Token-Efficiency Engine**: A dynamic `ImportanceScorer` prunes up to 95% of irrelevant DOM noise (footers, ads, tracking pixels) based on your agent's current intent.
- **Shadow-Testing & Branching**: Let your agents `fork_state()` to test risky forms in parallel background tabs without polluting the primary session.
- **Deterministic Snapshot Resumption**: Save encrypted auth cookies and local storage to disk. Instantly `load_snapshot()` to teleport agents past repetitive login walls.
- **Multi-Agent Conflict Resolution**: Prevents agents from colliding. If Agent A hides a modal, Agent B gets a clean `Conflict Prevented` error instead of silently failing.
- **Human-in-the-Loop CAPTCHA**: Hits a Cloudflare block? Splice pauses the agent and pops open a focused Chromium window on your host machine. Solve it, close it, and the agent resumes. No webhooks needed.

---

## Getting Started

### Prerequisites
- Node.js >= 18
- An MCP Client (like Claude Desktop or a custom swarm)

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/Arnavnemade1/Splice.git
cd Splice

# 2. Install dependencies
npm install

# 3. Install Playwright browsers
npx playwright install chromium

# 4. Compile the TypeScript code
npx tsc
```

---

## Connecting to an Agent (MCP)

To hook Splice into your agent's workflow, add it to your MCP client configuration (e.g., `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "splice-enterprise": {
      "command": "node",
      "args": [
        "/absolute/path/to/Splice/dist/index.js"
      ]
    }
  }
}
```
*(Make sure to replace `/absolute/path/to/Splice` with your actual system path!)*

---

## The Toolset

Once connected, your agent gains access to the following superpowers:

### Tools
- `navigate(url)`: Drive to any web page.
- `get_semantic_tree_optimized(intent)`: Returns a highly compressed JSON tree pruned specifically for the current goal (e.g. "checkout").
- `interact(elementId, action)`: Click, type, or focus deterministically using stable semantic IDs (no guessing CSS selectors).
- `fork_state()` & `commit_branch(branchId)`: Clone the active tab, trial an action, and merge it back.
- `save_snapshot(name)` & `load_snapshot(name)`: Instantly serialize and resume authenticated states.
- `request_human_intervention(reason)`: Pause execution and open a host window for manual CAPTCHA solving.

### Resources
- `splice://current-page/semantic-tree`: The raw, unoptimized semantic DOM.
- `splice://current-page/telemetry`: The live ledger of all intercepted XHR/Fetch network requests and console logs.
- `splice://session/health-dashboard`: Real-time metrics showing how many tokens and errors Splice has saved you this session.

---

## ROI Tracking

Splice isn't just a tool; it's an infrastructure layer that proves its value. Monitor the `health-dashboard` resource to see real-time metrics on:
- **Tokens Saved**: The exact delta between the raw DOM and the intent-optimized tree.
- **Errors Prevented**: How many destructive agent collisions were avoided.
- **CAPTCHAs Bypassed**: Successful human-in-the-loop rescues.

<br />

<div align="center">
  <i>Built for the Autonomous Web.</i>
</div>
