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
            name="splice_get_semantic_delta",
            description="Return only what changed on the page since the previous semantic observation (added/removed elements, text/value mutations, URL/title transitions). Falls back to the full tree when no baseline exists or lastSnapshotHash is stale.",
            inputSchema={
                "type": "object",
                "properties": {
                    "intent": {"type": "string", "description": "Search intent — keep identical to your previous observation so the diff reflects real page changes."},
                    "lens": {"type": "string", "enum": ["UX", "Security", "Behavior", "Performance", "Network", "Vision"], "description": "Extraction lens."},
                    "lastSnapshotHash": {"type": "string", "description": "Optional snapshotHash from your last observation for staleness detection."},
                    "structuralOnly": {"type": "boolean", "description": "Suppress text-only churn (tickers, timestamps); report only added/removed elements and value changes."},
                    "sinceLastActionId": {"type": "string", "description": "Diff against the snapshot captured right after a specific action (act-N ids returned by navigate/interact/fill_form). Anchored diffs are unpruned; re-rendered elements are reported as rewrittenIds, not added/removed."}
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
            description="Compile a STRUCTURED browser intent (action + target, e.g. 'click submit on the checkout form' — never a bare goal like 'finish') into a verified action plan with preconditions, postconditions, alternatives, and optional execution. Vague goals return needsClarification: true with structured intents suggested from the page — restate and retry. Declare expected postconditions via expect and they are verified after execution, gating verification.passed.",
            inputSchema={
                "type": "object",
                "properties": {
                    "intent": {"type": "string", "description": "Structured intent: action + target, e.g. 'click the pricing link'. Bare goals ('finish', 'continue') are rejected with suggested restatements."},
                    "value": {"type": "string", "description": "Optional value for type/select/press actions."},
                    "execute": {"type": "boolean", "description": "Execute only if confidence and preconditions are sufficient."},
                    "includeVision": {"type": "boolean", "description": "Include targetPreview (base64 PNG crop of the chosen target). Defaults ON while the session vision budget lasts; true forces beyond the budget, false opts out."},
                    "expect": {
                        "type": "array",
                        "description": "Optional declared postconditions verified after execution (polled up to 5s), e.g. [{\"kind\": \"url_contains\", \"value\": \"/thanks\"}]. Results appear in verification.expectations.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "kind": {"type": "string", "enum": ["url_contains", "title_contains", "text_present", "text_absent", "element_visible", "element_hidden"]},
                                "value": {"type": "string"}
                            },
                            "required": ["kind", "value"]
                        }
                    },
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
            name="splice_wait_for",
            description="Block until the first of the given conditions is satisfied (text_present, text_gone, element_visible, element_hidden, url_matches, title_matches, network_idle). Never errors on timeout — returns timedOut: true with a hint. One call replaces N polling observations.",
            inputSchema={
                "type": "object",
                "properties": {
                    "conditions": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "kind": {"type": "string", "enum": ["text_present", "text_gone", "element_visible", "element_hidden", "url_matches", "title_matches", "network_idle"]},
                                "value": {"type": "string", "description": "Text/label/url fragment (omit for network_idle)."}
                            },
                            "required": ["kind"]
                        }
                    },
                    "timeoutMs": {"type": "number", "description": "Total wait budget in ms (default 10000)."},
                    "pollIntervalMs": {"type": "number", "description": "Poll cadence in ms (default 250)."}
                },
                "required": ["conditions"]
            }
        ),
        types.Tool(
            name="splice_fill_form",
            description="Batch verified form fill: resolve fields by human label, fill them all, verify by readback, and report validation state plus submit readiness. Optionally submit via submitIntent once the form is ready.",
            inputSchema={
                "type": "object",
                "properties": {
                    "fields": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "field": {"type": "string", "description": "Human label, e.g. 'work email'."},
                                "value": {"type": "string", "description": "Value to enter (true/false for checkboxes)."}
                            },
                            "required": ["field", "value"]
                        }
                    },
                    "submitIntent": {"type": "string", "description": "Optional: submit once the form is valid, e.g. 'submit checkout'."}
                },
                "required": ["fields"]
            }
        ),
        types.Tool(
            name="splice_extract_structured",
            description="Schema-driven extraction: name the fields you want and Splice pulls clean rows from the best matching table, repeated cards, or label/value pairs — no selectors.",
            inputSchema={
                "type": "object",
                "properties": {
                    "fields": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "hint": {"type": "string", "description": "Optional extra words matched against headers/labels/classes."}
                            },
                            "required": ["name"]
                        }
                    },
                    "maxRows": {"type": "number", "description": "Maximum rows to return (default 50)."}
                },
                "required": ["fields"]
            }
        ),
        types.Tool(
            name="splice_assert_page_state",
            description="Cheap verification: evaluate expectations (url_contains, title_contains, text_present, text_absent, element_visible, element_hidden) in one pass with per-expectation evidence.",
            inputSchema={
                "type": "object",
                "properties": {
                    "expectations": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "kind": {"type": "string", "enum": ["url_contains", "title_contains", "text_present", "text_absent", "element_visible", "element_hidden"]},
                                "value": {"type": "string"}
                            },
                            "required": ["kind", "value"]
                        }
                    }
                },
                "required": ["expectations"]
            }
        ),
        types.Tool(
            name="splice_get_network_activity",
            description="Network cognition: lifecycle-tracked requests (status, duration, failures) with aggregates and an insight sentence. Answers 'did my submit fire a request and did it succeed?'.",
            inputSchema={
                "type": "object",
                "properties": {
                    "urlContains": {"type": "string", "description": "Only requests whose URL contains this fragment."},
                    "failedOnly": {"type": "boolean", "description": "Only failed requests (network error or status >= 400)."},
                    "sinceMs": {"type": "number", "description": "Lookback window in milliseconds."},
                    "limit": {"type": "number", "description": "Max records (default 50)."}
                }
            }
        ),
        types.Tool(
            name="splice_get_page_events",
            description="Out-of-band page events: auto-handled native dialogs, popups (recorded with URL), and downloads (saved to .splice/downloads). Check when a click 'did nothing'.",
            inputSchema={
                "type": "object",
                "properties": {
                    "sinceMs": {"type": "number", "description": "Lookback window in milliseconds."},
                    "type": {"type": "string", "enum": ["dialog", "popup", "download"]},
                    "limit": {"type": "number", "description": "Max events (default 25)."}
                }
            }
        ),
        types.Tool(
            name="splice_inspect_viewport",
            description="Multi-modal 'what's visible?': viewport screenshot with numbered highlights over interactive elements (numbers map to spliceIds in the JSON), plus a structured map of complex widgets the semantic tree under-reports — video (live playback state), canvas, iframes, sliders, drag targets, dropzones, carousels, dense grids — each with interaction advice, and a count of animating elements. Use on visually complex UIs where DOM-only observation misleads.",
            inputSchema={
                "type": "object",
                "properties": {
                    "maxHighlights": {"type": "number", "description": "Max interactive elements to number on the overlay (default 40)."},
                    "includeScreenshot": {"type": "boolean", "description": "Set false to skip the image and return only the structured widget map (cheaper)."}
                }
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
    elif name == "splice_get_semantic_delta":
        result = await call_bridge("getSemanticDelta", arguments)
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

    elif name == "splice_wait_for":
        result = await call_bridge("waitFor", arguments)
        return [types.TextContent(type="text", text=json.dumps(result))]

    elif name == "splice_fill_form":
        result = await call_bridge("fillForm", arguments)
        return [types.TextContent(type="text", text=json.dumps(result))]

    elif name == "splice_extract_structured":
        result = await call_bridge("extractStructured", arguments)
        return [types.TextContent(type="text", text=json.dumps(result))]

    elif name == "splice_assert_page_state":
        result = await call_bridge("assertPageState", arguments)
        return [types.TextContent(type="text", text=json.dumps(result))]

    elif name == "splice_get_network_activity":
        result = await call_bridge("getNetworkActivity", arguments)
        return [types.TextContent(type="text", text=json.dumps(result))]

    elif name == "splice_get_page_events":
        result = await call_bridge("getPageEvents", arguments)
        return [types.TextContent(type="text", text=json.dumps(result))]

    elif name == "splice_inspect_viewport":
        result = await call_bridge("inspectViewport", arguments)
        screenshot = result.pop("screenshot", "") if isinstance(result, dict) else ""
        content: list[types.TextContent | types.ImageContent | types.EmbeddedResource] = []
        if screenshot:
            content.append(types.ImageContent(type="image", data=screenshot, mimeType="image/png"))
        content.append(types.TextContent(type="text", text=json.dumps(result)))
        return content

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
