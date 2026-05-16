# Integrating Splice Enterprise

Splice Enterprise is not a standard NPM library that you import directly into your UI. It is a **Model Context Protocol (MCP) Server**. This means it runs as a standalone sidecar process and securely exposes its web-browsing capabilities to your AI Agents over standard I/O.

The server runs headless by default. Set `SPLICE_AUTO_OPEN_DASHBOARD=1` only when you want Splice to open the local observability dashboard during startup.

Here is how you add Splice to your agent projects, whether it's a generic swarm or your specific `Ace Trading Daemon`.

---

## Method 1: The Generic MCP Client Setup (Node.js)

If you are building your own agent from scratch using the official MCP SDK, you connect to Splice by spawning it as a child process.

### 1. Install Dependencies in your Agent Project
```bash
npm install @modelcontextprotocol/sdk
```

### 2. Connect to Splice
In your agent's initialization code, set up the `Client` and connect it via the `StdioClientTransport`.

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function setupSplice() {
  const client = new Client(
    { name: "my-custom-agent", version: "1.0.0" },
    { capabilities: {} }
  );

  // Spawn the Splice Enterprise server
  const transport = new StdioClientTransport({
    command: "node",
    args: ["/absolute/path/to/Splice/dist/index.js"], // <-- Point this to your compiled Splice server
  });

  await client.connect(transport);
  console.log("Connected to Splice Enterprise!");
  
  return client;
}
```

### 3. Let Your LLM Use It
Now, you simply list the available tools and give them to your LLM (like OpenAI or Anthropic).

```typescript
// Fetch the tools from Splice
const response = await client.listTools();
const spliceTools = response.tools;

// Feed these to your LLM as function calls
// ... (LLM decides to call `get_semantic_tree_optimized`)

// Execute the LLM's request on Splice
const result = await client.callTool({
  name: "get_semantic_tree_optimized",
  arguments: { intent: "Find login button", lens: "UX", maxTokens: 4000 }
});

console.log(result.content[0].text); // The optimized, token-budgeted JSON tree!
```

---

## Method 2: Integrating with Ace Trading Daemon (SwarmOrchestrator)

Since you are building the `Ace Trading Daemon` with a `SwarmOrchestrator`, you can give Splice exclusively to specific personas (like an `ExecutionAgent` or `ReconAgent`) while keeping the others lightweight.

### 1. Add Splice Transport to your Swarm

In your `trading-daemon/src/agents/SwarmOrchestrator.ts`, initialize the transport and attach it to your context.

```typescript
// trading-daemon/src/agents/SwarmOrchestrator.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export class SwarmOrchestrator {
  private spliceClient: Client;

  async initSplice() {
    this.spliceClient = new Client({ name: "ace-swarm", version: "1.0.0" }, { capabilities: {} });
    
    // Assumes Splice is checked out next to Ace
    const transport = new StdioClientTransport({
      command: "node",
      args: ["../Splice/dist/index.js"], 
    });

    await this.spliceClient.connect(transport);
  }

  // ...
}
```

### 2. Equip Specific Personas

When dispatching tasks, dynamically provide the Splice tools only to agents that need to browse external sites (like SEC Edgar filings or obscure data sources).

```typescript
// Inside your prompt building logic:
if (persona === 'ReconAgent') {
  const tools = await this.spliceClient.listTools();
  // Pass `tools` to the ReconAgent's LLM context so it can browse!
}
```

---

## Method 3: Desktop Apps (Claude Desktop)

If you just want to use Claude's desktop app with Splice, add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "splice-enterprise": {
      "command": "node",
      "args": [
        "/Users/arnavnemade/Splice/dist/index.js"
      ]
    }
  }
}
```

## Leveraging the Token Budget Engine

When your agent calls `get_semantic_tree_optimized`, it can now pass a `maxTokens` budget. 

If your LLM context window is tight (e.g., you are using a cheaper model like `gpt-4o-mini` with a small remaining context window), your agent can request `maxTokens: 2000`. Splice will iteratively truncate massive text blocks and infinitely scrolling lists until the DOM fits perfectly within your budget. No more `context_length_exceeded` errors in production!
