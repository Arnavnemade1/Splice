import asyncio
import httpx
import json
import os
import subprocess
import time
from typing import Optional, Any, Dict

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
            return response.json()
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
                    "lens": {"type": "string", "enum": ["UX", "Security", "Behavior", "Performance"], "description": "Extraction lens."},
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
                    "interaction": {"type": "string", "enum": ["click", "type", "hover"], "description": "The action."},
                    "value": {"type": "string", "description": "Value to type (if applicable)."}
                },
                "required": ["elementId", "interaction"]
            }
        ),
        types.Tool(
            name="python_executor",
            description="Run an arbitrary python script to process data. Used for data science analysis.",
            inputSchema={
                "type": "object",
                "properties": {
                    "code": {"type": "string", "description": "Python code to run. Must print the final result to stdout."}
                },
                "required": ["code"]
            }
        )
    ]

@server.call_tool()
async def handle_call_tool(
    name: str, arguments: dict | None
) -> list[types.TextContent | types.ImageContent | types.EmbeddedResource]:
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

    elif name == "python_executor":
        code = arguments.get("code")
        try:
            # Execute python code
            result = subprocess.run(["python3", "-c", code], capture_output=True, text=True, timeout=10)
            output = result.stdout
            if result.stderr:
                output += f"\nErrors:\n{result.stderr}"
            return [types.TextContent(type="text", text=output)]
        except Exception as e:
            return [types.TextContent(type="text", text=f"Python Execution Failed: {str(e)}")]
            
    raise ValueError(f"Unknown tool: {name}")

def start_ts_bridge():
    global bridge_process
    
    # Check if compiled dist exists
    dist_path = os.path.join("..", "dist", "bridge_server.js")
    src_path = os.path.join("..", "src", "bridge_server.ts")
    
    cmd = []
    if os.path.exists(dist_path):
        cmd = ["node", dist_path]
    elif os.path.exists(src_path):
        cmd = ["npx", "tsx", src_path]
    else:
        print("Warning: Could not find bridge_server source or dist.")
        return
        
    bridge_process = subprocess.Popen(cmd)
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
                server_version="1.0.0",
                capabilities=server.get_capabilities(
                    notification_options=NotificationOptions(),
                    experimental_capabilities={},
                ),
            ),
        )
        
    if bridge_process:
        bridge_process.terminate()

if __name__ == "__main__":
    asyncio.run(main())
