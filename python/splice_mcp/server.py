import asyncio
import atexit
import httpx
import json
import subprocess
import time
from pathlib import Path
from typing import Any, Dict

from mcp.server import Server, NotificationOptions
from mcp.server.models import InitializationOptions
import mcp.server.stdio
import mcp.types as types

server = Server("splice-mcp-python")
BRIDGE_URL = "http://127.0.0.1:4000"
bridge_process = None

async def call_bridge(action: str, args: Dict[str, Any] = None) -> Any:
    if args is None:
        args = {}
    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(BRIDGE_URL, json={"action": action, "args": args}, timeout=30.0)
            response.raise_for_status()
            payload = response.json()
            if not payload.get("ok"):
                raise RuntimeError(payload.get("error", "unknown bridge error"))
            return payload.get("result")
        except Exception as e:
            raise RuntimeError(f"Bridge error on {action}: {str(e)}")

@server.list_tools()
async def handle_list_tools() -> list[types.Tool]:
    return [
        types.Tool(
            name="splice_navigate",
            description="Navigate to a URL using the Splice Browser.",
            inputSchema={
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "The URL to navigate to."}
                },
                "required": ["url"]
            }
        ),
        types.Tool(
            name="splice_get_semantic_tree",
            description="Extract a clean semantic tree of the current page.",
            inputSchema={
                "type": "object",
                "properties": {
                    "intent": {"type": "string", "description": "Optional search intent."},
                    "lens": {"type": "string", "enum": ["UX", "Security", "Behavior", "Performance", "Network", "Vision"], "description": "Extraction lens."},
                    "maxTokens": {"type": "number", "description": "Max tokens to return."}
                }
            }
        ),
        types.Tool(
            name="splice_interact",
            description="Interact with an element on the page.",
            inputSchema={
                "type": "object",
                "properties": {
                    "elementId": {"type": "string", "description": "The Splice ID of the element."},
                    "interaction": {"type": "string", "enum": ["click", "type", "focus", "select", "press"], "description": "The action."},
                    "value": {"type": "string", "description": "Value to type (if applicable)."}
                },
                "required": ["elementId", "interaction"]
            }
        ),
        types.Tool(
            name="splice_diagnose_agent_state",
            description="Classify whether the browser workflow is ready, obstructed, blocked by validation/auth/CAPTCHA, or failing due to network state.",
            inputSchema={
                "type": "object",
                "properties": {
                    "goal": {"type": "string", "description": "Optional current agent goal."},
                    "lastActions": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional recent action summaries."
                    }
                }
            }
        ),
        types.Tool(
            name="splice_compile_verified_action",
            description="Compile a browser intent into a verified action plan with preconditions, postconditions, alternatives, and optional execution.",
            inputSchema={
                "type": "object",
                "properties": {
                    "intent": {"type": "string", "description": "The browser intent to compile."},
                    "value": {"type": "string", "description": "Optional value for type/select/press actions."},
                    "execute": {"type": "boolean", "description": "Execute only if confidence and preconditions are sufficient."},
                    "constraints": {
                        "type": "object",
                        "properties": {
                            "noNavigationOutsideDomain": {"type": "boolean"},
                            "avoidDestructiveActions": {"type": "boolean"},
                            "requireExactText": {"type": "boolean"}
                        }
                    }
                },
                "required": ["intent"]
            }
        ),
        types.Tool(
            name="splice_get_runtime_health",
            description="Runtime Reliability: browser connectivity, branch states, crash/recovery counters, uptime, and run-journal statistics.",
            inputSchema={"type": "object", "properties": {}}
        ),
        types.Tool(
            name="splice_export_run_journal",
            description="Runtime Reliability: export the append-only reproducibility log of tool calls (redacted args, outcomes, durations, error codes).",
            inputSchema={
                "type": "object",
                "properties": {
                    "limit": {"type": "number", "description": "Max most-recent entries to return (default 50)."}
                }
            }
        ),
        types.Tool(
            name="splice_get_agent_analytics",
            description="Agent Tracking: live per-agent performance profiles (success rate, latency, failure streaks, error breakdown) with ranked in-action optimization directives.",
            inputSchema={
                "type": "object",
                "properties": {
                    "agentId": {"type": "string", "description": "Optional: profile a single agent instead of all tracked agents."}
                }
            }
        )
    ]

@server.call_tool()
async def handle_call_tool(
    name: str, arguments: dict | None
) -> list[types.TextContent | types.ImageContent | types.EmbeddedResource]:
    arguments = arguments or {}

    if name == "splice_navigate":
        url = arguments.get("url")
        result = await call_bridge("navigate", {"url": url})
        return [types.TextContent(type="text", text=json.dumps(result))]
        
    elif name == "splice_get_semantic_tree":
        result = await call_bridge("getSemanticTree", arguments)
        return [types.TextContent(type="text", text=json.dumps(result))]
        
    elif name == "splice_interact":
        result = await call_bridge("interact", arguments)
        return [types.TextContent(type="text", text=json.dumps(result))]

    elif name == "splice_diagnose_agent_state":
        result = await call_bridge("diagnoseAgentState", arguments)
        return [types.TextContent(type="text", text=json.dumps(result))]

    elif name == "splice_compile_verified_action":
        result = await call_bridge("compileVerifiedAction", arguments)
        return [types.TextContent(type="text", text=json.dumps(result))]

    elif name == "splice_get_runtime_health":
        result = await call_bridge("getRuntimeHealth", arguments)
        return [types.TextContent(type="text", text=json.dumps(result))]

    elif name == "splice_export_run_journal":
        result = await call_bridge("exportRunJournal", arguments)
        return [types.TextContent(type="text", text=json.dumps(result))]

    elif name == "splice_get_agent_analytics":
        result = await call_bridge("getAgentAnalytics", arguments)
        return [types.TextContent(type="text", text=json.dumps(result))]

    raise ValueError(f"Unknown tool: {name}")

def start_ts_bridge():
    global bridge_process
    
    project_root = Path(__file__).resolve().parents[2]
    dist_path = project_root / "dist" / "bridge_server.js"
    src_path = project_root / "src" / "bridge_server.ts"
    
    cmd = []
    if dist_path.exists():
        cmd = ["node", str(dist_path)]
    elif src_path.exists():
        cmd = ["npx", "tsx", str(src_path)]
    else:
        print("Warning: Could not find bridge_server source or dist.")
        return
        
    bridge_process = subprocess.Popen(cmd, cwd=project_root)
    atexit.register(lambda: bridge_process and bridge_process.terminate())
    time.sleep(2)
    
    try:
        import urllib.request
        req = urllib.request.Request(BRIDGE_URL, data=json.dumps({"action": "init"}).encode('utf-8'), headers={'Content-Type': 'application/json'})
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        pass

async def main():
    start_ts_bridge()
    async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            InitializationOptions(
                server_name="splice-mcp-python",
                server_version="2.1.0",
                capabilities=server.get_capabilities(
                    notification_options=NotificationOptions(),
                    experimental_capabilities={},
                ),
            ),
        )
        
    if bridge_process:
        bridge_process.terminate()

def cli():
    asyncio.run(main())

if __name__ == "__main__":
    cli()
