// Must be first: applies splice.config.json to process.env before any module
// reads its environment variables.
import "./config.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BrowserManager, compactVerifiedPlan } from "./BrowserManager.js";
import { RunJournal } from "./RunJournal.js";
import { classifyError, withTimeout, errorMessage } from "./Resilience.js";
import fs from "node:fs";
import path from "node:path";
import { discordNotifier } from "./DiscordWebhook.js";

const spliceDir = path.join(process.cwd(), ".splice");
fs.mkdirSync(spliceDir, { recursive: true });

const journal = new RunJournal(spliceDir);
const browser = new BrowserManager();
browser.onReliabilityEvent = (kind, detail) => {
  journal.record({ kind, outcome: "info", detail });
};
browser.journalStatsProvider = () => journal.getStats() as unknown as Record<string, unknown>;

const SPLICE_PLAYBOOK = `# Splice Agent Playbook

Splice is a cognition and safety layer for browser work — it does not replace your agent, it makes your agent reliable on real web apps. Follow this loop:

1. **navigate** to the target URL.
2. **diagnose_agent_state** — never act blind. It classifies the page (ready, ui_obstruction, validation_blocked, auth_required, captcha, network_failure, ...) with evidence, a recommended next tool, and a trend that warns when you are stuck repeating the same failing approach.
3. **compile_verified_action** — express what you want in natural language ("click the pricing link", "type work email"). Splice ranks candidates, produces preconditions/postconditions/risk/alternatives, and (with execute: true) only acts when confidence and preconditions hold, then verifies the outcome. Prefer this over raw interact.
4. **interact** — low-level fallback when you already know the exact data-splice-id from the semantic tree.
5. On failure, read the typed error envelope: it carries a stable code (TARGET_NOT_FOUND, BROWSER_CRASHED, TIMEOUT, CAPTCHA_REQUIRED, ...), a recoverable flag, and the suggestedNextTool to call.

One-call primitives — reach for these before composing loops yourself:
- **wait_for** when the page needs time: block on text_present / element_visible / url_matches / network_idle instead of polling with reads. Timeouts return timedOut: true with a hint, never an error.
- **fill_form** for any form with 2+ fields: pass human labels and values, get per-field readback verification, validation state, and submit readiness (optionally submitIntent to submit too).
- **extract_structured** to pull rows of data (tables, repeated cards, label/value pairs) by naming fields — never scrape a full tree into your context.
- **assert_page_state** to check postconditions (url_contains, text_present, element_visible, ...) at a fraction of a tree read.
- When an action "did nothing": **get_page_events** (auto-handled dialogs, popups, downloads) and **get_network_activity** (failing requests with an insight sentence) explain what actually happened.
- **inspect_viewport** when the UI is visually complex (media players, canvas, drag-and-drop, dense grids, animations): returns the viewport as an image with numbered highlights over interactive elements plus a structured widget map with live state (e.g. video playing/position) and per-widget interaction advice. Verified actions also attach a pixel crop of the chosen target by default while the session vision budget lasts (visionByDefault / visionBudget in splice.config.json).

Guardrails that are always on: prompt-injection redaction in semantic trees, a secret egress firewall on non-GET requests, encrypted snapshots, and a crash-self-healing browser (get_runtime_health shows recovery state).

Efficiency: pass intent + maxTokens to get_semantic_tree_optimized to prune the DOM; after the first read, pass deltaOnly: true (with the same intent) to receive only what changed since your last observation instead of the whole tree; actions return an actionId (act-N) — pass it as sinceLastActionId to diff against the moment right after that action, with framework re-renders reported as rewrittenIds instead of add/remove noise; pass agentId on calls to get per-agent tracking and in-action optimization directives; use fork_state to test risky actions on a shadow branch before committing.`;

const server = new Server(
  {
    name: "splice-enterprise-browser",
    version: "2.2.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
    instructions: SPLICE_PLAYBOOK,
  }
);

// Define Resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "splice://current-page/semantic-tree",
        name: "Semantic Tree (Raw)",
        mimeType: "application/json",
        description: "The full, raw AI-optimized semantic representation of the current page's DOM structure.",
      },
      {
        uri: "splice://current-page/telemetry",
        name: "Telemetry Data",
        mimeType: "application/json",
        description: "Network and console logs generated by the page.",
      },
      {
        uri: "splice://session/health-dashboard",
        name: "Health & Performance Dashboard",
        mimeType: "application/json",
        description: "Tracks tokens saved, errors prevented, and CAPTCHAs handled in this session.",
      },
      {
        uri: "splice://session/live-feed",
        name: "Live Heartbeat Feed",
        mimeType: "application/json",
        description: "A real-time rolling window of the last 5 agent actions and 5 console logs — the agent's heartbeat.",
      },
      {
        uri: "splice://guide/agent-playbook",
        name: "Splice Agent Playbook",
        mimeType: "text/markdown",
        description: "The recommended cognition loop for any agent using Splice: diagnose → compile verified action → verify → recover. Read this first.",
      }
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri === "splice://current-page/semantic-tree") {
    try {
      const tree = await browser.getSemanticTree();
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "application/json",
            text: JSON.stringify(tree, null, 2),
          },
        ],
      };
    } catch (e: any) {
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "application/json",
            text: JSON.stringify({ error: e.message }),
          },
        ],
      };
    }
  }

  if (request.params.uri === "splice://current-page/telemetry") {
    try {
      const logs = browser.getTelemetryLogs();
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "application/json",
            text: JSON.stringify(logs, null, 2),
          },
        ],
      };
    } catch (e: any) {
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "application/json",
            text: JSON.stringify({ error: e.message }),
          },
        ],
      };
    }
  }

  if (request.params.uri === "splice://session/health-dashboard") {
    return {
      contents: [{ uri: request.params.uri, mimeType: "application/json", text: JSON.stringify(browser.metrics, null, 2) }],
    };
  }

  if (request.params.uri === "splice://session/live-feed") {
    return {
      contents: [{ uri: request.params.uri, mimeType: "application/json", text: JSON.stringify(browser.getLiveFeed(), null, 2) }],
    };
  }

  if (request.params.uri === "splice://guide/agent-playbook") {
    return {
      contents: [{ uri: request.params.uri, mimeType: "text/markdown", text: SPLICE_PLAYBOOK }],
    };
  }

  throw new Error(`Resource not found: ${request.params.uri}`);
});

// Define Tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "navigate",
        description: "Navigate the active browser branch to a URL. Transient network failures are retried automatically; cookie banners are auto-dismissed; the page is waited to stability. Follow with diagnose_agent_state before acting.",
        annotations: { title: "Navigate", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "The full URL to navigate to, or one of the literals 'back', 'forward', 'reload' for history navigation." },
            agentId: { type: "string", description: "Optional agent identifier for per-agent tracking and in-action optimization." },
          },
          required: ["url"],
        },
      },
      {
        name: "wait_for",
        description: "Semantic waiting primitive — blocks until the FIRST of your conditions is satisfied (any-of), then reports which one matched and how long it took. Conditions: text_present, text_gone, element_visible, element_hidden (label/text match), url_matches, title_matches (substring), network_idle. Never errors on timeout: returns timedOut: true with a hint about why (requests still in flight vs. page settled without the change). Use this instead of polling with repeated tree reads — one call replaces N observations. Example: { conditions: [{ kind: 'text_present', value: 'order confirmed' }, { kind: 'url_matches', value: '/success' }], timeoutMs: 8000 }.",
        annotations: { title: "Wait For", readOnlyHint: true },
        inputSchema: {
          type: "object",
          properties: {
            conditions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["text_present", "text_gone", "element_visible", "element_hidden", "url_matches", "title_matches", "network_idle"] },
                  value: { type: "string", description: "Text/label/url fragment to match, case-insensitive. Omit for network_idle." }
                },
                required: ["kind"]
              },
              description: "Conditions checked every poll; the first to hold wins."
            },
            timeoutMs: { type: "number", description: "Total wait budget in ms (default 10000, max 60000)." },
            pollIntervalMs: { type: "number", description: "Poll cadence in ms (default 250)." },
            agentId: { type: "string", description: "Optional agent identifier for per-agent tracking." }
          },
          required: ["conditions"],
        },
      },
      {
        name: "fill_form",
        description: "Batch verified form fill — one call fills an entire form. Pass fields as human labels ({ field: 'work email', value: 'a@b.com' }); Splice resolves each to a control by label / aria-label / aria-labelledby / placeholder / name matching, fills it (text, textarea, select, checkbox, radio, plus custom ARIA widgets: contenteditable, role=textbox/combobox/switch), verifies by reading the value back, and reports per-field status with the control kind and browser-native validation state. Honest reporting: not_found for unmatched fields, readback_mismatch when the value didn't stick, skipped_disabled for disabled controls, and an ambiguous flag (with the runner-up label) when a field's match was a near-tie. Optionally pass submitIntent ('submit checkout') to submit with full verification once the form is ready — if it can't, submit.reason says why (not_submittable, form_not_ready, no_submit_control). Replaces N interact+observe round-trips with one call.",
        annotations: { title: "Fill Form", destructiveHint: true },
        inputSchema: {
          type: "object",
          properties: {
            fields: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  field: { type: "string", description: "Human label of the control, e.g. 'work email', 'country', 'agree to terms'." },
                  value: { type: "string", description: "Value to enter. For checkboxes/radios use true/false/yes/no." }
                },
                required: ["field", "value"]
              }
            },
            submitIntent: { type: "string", description: "Optional: submit the form via compile_verified_action once every field is filled and valid, e.g. 'submit checkout'." },
            agentId: { type: "string", description: "Optional agent identifier to track conflicts." }
          },
          required: ["fields"],
        },
      },
      {
        name: "extract_structured",
        description: "Schema-driven data extraction — name the fields you want ({ name: 'price', hint: 'cost amount' }) and Splice finds the best matching structure on the page: a table (headers matched to your fields), repeated cards/list items, or label/value pairs. Returns clean rows with per-field coverage and confidence. No selectors, no manual tree walking, no token-heavy scraping in your context window.",
        annotations: { title: "Extract Structured Data", readOnlyHint: true },
        inputSchema: {
          type: "object",
          properties: {
            fields: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "Field name to appear in each returned row." },
                  hint: { type: "string", description: "Optional extra words matched against headers, labels, and class names." }
                },
                required: ["name"]
              }
            },
            maxRows: { type: "number", description: "Maximum rows to return (default 50)." },
            agentId: { type: "string", description: "Optional agent identifier for per-agent tracking." }
          },
          required: ["fields"],
        },
      },
      {
        name: "assert_page_state",
        description: "Cheap verification primitive — evaluate a list of expectations against the live page in one pass: url_contains, title_contains, text_present, text_absent, element_visible, element_hidden. Returns per-expectation pass/fail with the actual value observed (including a text snippet around matches). Costs a fraction of a tree read; ideal for checking postconditions between actions or confirming a workflow completed.",
        annotations: { title: "Assert Page State", readOnlyHint: true },
        inputSchema: {
          type: "object",
          properties: {
            expectations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["url_contains", "title_contains", "text_present", "text_absent", "element_visible", "element_hidden"] },
                  value: { type: "string", description: "Fragment/label to check, case-insensitive." }
                },
                required: ["kind", "value"]
              }
            },
            agentId: { type: "string", description: "Optional agent identifier for per-agent tracking." }
          },
          required: ["expectations"],
        },
      },
      {
        name: "get_network_activity",
        description: "Network cognition — what has the page's network actually been doing? Lifecycle-tracked requests (method, url, status, duration, failure reason) with aggregates and an insight sentence, e.g. 'Most recent problem: POST /api/checkout → 500'. Filters: urlContains, failedOnly, sinceMs (lookback window), limit. Answers 'did my submit fire a request and did it succeed?' without a screenshot or tree read.",
        annotations: { title: "Network Activity", readOnlyHint: true },
        inputSchema: {
          type: "object",
          properties: {
            urlContains: { type: "string", description: "Only requests whose URL contains this fragment." },
            failedOnly: { type: "boolean", description: "Only requests that failed at the network level or returned status >= 400." },
            sinceMs: { type: "number", description: "Lookback window in milliseconds (e.g. 30000 = last 30s)." },
            limit: { type: "number", description: "Maximum request records to return (default 50)." },
            agentId: { type: "string", description: "Optional agent identifier for per-agent tracking." }
          },
        },
      },
      {
        name: "get_page_events",
        description: "Out-of-band page events a DOM-only observer never sees: native dialogs (auto-handled — alerts accepted, confirm/prompt dismissed non-destructively, always recorded with their message), popups (recorded with their URL, left open), and downloads (saved to .splice/downloads with the path recorded). Check this when a click 'did nothing' — the page may have opened a dialog, popup, or download instead.",
        annotations: { title: "Page Events", readOnlyHint: true },
        inputSchema: {
          type: "object",
          properties: {
            sinceMs: { type: "number", description: "Lookback window in milliseconds." },
            type: { type: "string", enum: ["dialog", "popup", "download"], description: "Only events of this type." },
            limit: { type: "number", description: "Maximum events to return (default 25)." },
            agentId: { type: "string", description: "Optional agent identifier for per-agent tracking." }
          },
        },
      },
      {
        name: "get_semantic_tree_optimized",
        description: "Extract an AI-optimized semantic tree of the current page, pruned by your intent and viewed through a lens (UX, Security, Performance, Network, Behavior, Vision). Returns stable data-splice-id handles for every actionable element — these IDs are what interact and compile_verified_action operate on — plus a snapshotHash identifying this observation. Hostile page text (prompt injection) is redacted before it reaches you. On long sessions, pass deltaOnly: true (with the SAME intent as your previous read) to receive only what changed since the last observation: added/removed elements, text and value mutations, and URL/title transitions. If no baseline exists or your lastSnapshotHash is stale, the full tree is returned instead (fullTreeRequired: true) and the baseline is re-established. Example: { intent: 'find checkout form', lens: 'UX', maxTokens: 1200 } then { intent: 'find checkout form', deltaOnly: true }.",
        annotations: { title: "Semantic Tree", readOnlyHint: true },
        inputSchema: {
          type: "object",
          properties: {
            intent: { type: "string", description: "Your current goal (e.g. 'checkout', 'login', 'read article'). Used to prune irrelevant DOM elements. Keep it identical across deltaOnly calls so diffs reflect real page changes, not pruning changes." },
            lens: { type: "string", enum: ["UX", "Security", "Performance", "Vision"], description: "The Semantic Lens to view the page through." },
            maxTokens: { type: "number", description: "The maximum number of tokens to return. Triggers aggressive truncation if exceeded." },
            deltaOnly: { type: "boolean", description: "If true, return only the changes since the previous observation on this branch (added/removed/changed elements, URL/title transitions) instead of the full tree. Falls back to the full tree when no baseline exists." },
            lastSnapshotHash: { type: "string", description: "Optional with deltaOnly: the snapshotHash from your last observation. If it no longer matches the server baseline, the full tree is returned so you never act on a stale diff." },
            structuralOnly: { type: "boolean", description: "Optional with deltaOnly: suppress text-only mutations (tickers, timestamps, counters) and report only added/removed elements and value changes. textChangesIgnored counts what was filtered." },
            sinceLastActionId: { type: "string", description: "Optional with deltaOnly: diff against the snapshot captured right after a specific action instead of your last observation. Action ids (act-N) are returned by navigate, interact, fill_form, and executed compile_verified_action calls; the last 12 are kept. Anchored diffs are unpruned on both sides (intent is ignored) so they never fabricate changes. Re-rendered elements whose content is unchanged are reported separately as rewrittenIds, not as added/removed." },
            agentId: { type: "string", description: "Optional agent identifier for per-agent tracking and in-action optimization." }
          },
          required: ["intent"],
        },
      },
      {
        name: "interact",
        description: "Low-level: perform click/type/focus/select/press on an element by its data-splice-id from the semantic tree. Self-heals stale IDs via text fallback and waits for stability afterward. Prefer compile_verified_action when working from natural-language intent — it adds candidate ranking, preconditions, and post-action verification.",
        annotations: { title: "Interact (low-level)", destructiveHint: true },
        inputSchema: {
          type: "object",
          properties: {
            elementId: { type: "string", description: "The data-splice-id of the element (e.g., 'button-1')" },
            action: { type: "string", enum: ["click", "type", "focus", "select", "press", "hover", "clear", "check", "uncheck", "scroll_into_view"], description: "The action to perform" },
            value: { type: "string", description: "Optional value for 'type', 'select', or 'press' actions" },
            agentId: { type: "string", description: "Optional agent identifier to track conflicts." }
          },
          required: ["elementId", "action"],
        },
      },
      {
        name: "diagnose_agent_state",
        description: "Agent State Forensics — call this before acting and whenever something fails. Classifies the page as ready, ui_obstruction, validation_blocked, auth_required, captcha, navigation_pending, network_failure, or stale_or_missing_target, with confidence, evidence, and a recommended next tool. Includes a predictive trend: it detects when you are stuck (same failing state 3+ times on one URL) and forecasts whether repeating your approach will work. Costs one cheap DOM scan; saves entire wasted action loops.",
        annotations: { title: "State Forensics", readOnlyHint: true },
        inputSchema: {
          type: "object",
          properties: {
            goal: { type: "string", description: "Optional current agent goal, used to make the diagnosis more specific." },
            lastActions: {
              type: "array",
              items: { type: "string" },
              description: "Optional recent action summaries, newest last."
            },
            agentId: { type: "string", description: "Optional agent identifier for per-agent tracking and in-action optimization." }
          }
        },
      },
      {
        name: "compile_verified_action",
        description: "Verified Intent Actions — the recommended way to act. Compiles a STRUCTURED natural-language intent (action + target: 'click the pricing link', 'type work email' — never a bare goal like 'finish' or 'do it') into a ranked target with preconditions, postconditions, risk, expectedOutcome, and alternatives. Vague goals are not guessed at: the call returns needsClarification: true with structured intents suggested from the page's visible controls — restate and retry. With execute: true it acts only when confidence and preconditions hold, then verifies the result against the page (URL/title/text change, obstruction resolution, validation progress). Declare the outcome you expect via expect (url_contains, text_present, ...) and it is checked after execution with per-expectation evidence — verification.passed is then true only if your declared postconditions hold. With includeVision: true it returns a pixel crop of the chosen target for vision-model confirmation.",
        annotations: { title: "Verified Intent Action", destructiveHint: true },
        inputSchema: {
          type: "object",
          properties: {
            intent: { type: "string", description: "A structured browser intent: action + target, e.g. 'click the pricing link' or 'type work email'. Bare goals ('finish', 'continue') are rejected with needsClarification and suggested restatements." },
            value: { type: "string", description: "Optional value for type/select/press actions." },
            execute: { type: "boolean", description: "If true, execute only when confidence and preconditions are sufficient." },
            expect: {
              type: "array",
              description: "Optional declared postconditions verified after execution (polled up to 5s). Example: [{ kind: 'url_contains', value: '/thanks' }, { kind: 'text_present', value: 'order confirmed' }]. Results appear in verification.expectations and gate verification.passed.",
              items: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["url_contains", "title_contains", "text_present", "text_absent", "element_visible", "element_hidden"] },
                  value: { type: "string" }
                },
                required: ["kind", "value"]
              }
            },
            includeVision: { type: "boolean", description: "Include targetPreview: a base64 PNG crop of the chosen target element for hybrid vision+DOM confirmation. Defaults to ON while the session vision budget lasts (visionByDefault/visionBudget in splice.config.json); pass true to force beyond the budget or false to opt out." },
            compact: { type: "boolean", description: "If true, trim the response to essentials — plan, confidence, risk, expectedOutcome, and the verification verdict with a delta summary. Drops alternatives and compile-time evidence to save tokens on long sessions." },
            constraints: {
              type: "object",
              properties: {
                noNavigationOutsideDomain: { type: "boolean", description: "Penalize or reject targets that navigate to a different host." },
                avoidDestructiveActions: { type: "boolean", description: "Block destructive intents such as delete, pay, buy, transfer, or cancellation." },
                requireExactText: { type: "boolean", description: "Require candidate labels to include intent terms." }
              }
            },
            agentId: { type: "string", description: "Optional agent identifier for per-agent tracking and in-action optimization." }
          },
          required: ["intent"],
        },
      },
      {
        name: "fork_state",
        description: "Clone the current browser state into a new background branch for shadow testing risky actions.",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "Optional agent ID that will own the new branch. Ownership is recorded immediately." }
          },
        },
      },
      {
        name: "speculative_fork",
        description: "Proactively fork branches and navigate to a list of URLs in the background to reduce latency when you later navigate to them. Pages that finish loading within the wait budget return a comparison against the active branch (elements unique to the pre-loaded page, active-branch elements it lacks) so you can pick the right branch without visiting each one; slower pages are marked 'loading' and keep pre-loading in the background.",
        inputSchema: {
          type: "object",
          properties: {
            urls: {
              type: "array",
              items: { type: "string" },
              description: "Array of URLs to speculatively pre-load."
            }
          },
          required: ["urls"],
        },
      },
      {
        name: "commit_branch",
        description: "Make a background branch the primary active state.",
        inputSchema: {
          type: "object",
          properties: {
            branchId: { type: "string", description: "The branch ID to commit" },
          },
          required: ["branchId"],
        },
      },
      {
        name: "save_snapshot",
        description: "Serialize the active session (cookies, auth) to the local machine so it can be resumed instantly.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Name of the snapshot (e.g., 'auth-github')" },
          },
          required: ["name"],
        },
      },
      {
        name: "load_snapshot",
        description: "Instantly teleport the browser into a previously saved session state.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Name of the snapshot to load" },
          },
          required: ["name"],
        },
      },
      {
        name: "request_human_intervention",
        description: "Halt the agent and spawn a visible Chromium window on the host machine to solve a CAPTCHA or unblock a flow.",
        inputSchema: {
          type: "object",
          properties: {
            reason: { type: "string", description: "Why the human is needed (e.g., 'Solve Cloudflare turnstile')" },
          },
          required: ["reason"],
        },
      },
      {
        name: "debug_failure",
        description: "Save a time-travel Playwright trace of the current session to debug hallucination or errors.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string", description: "A unique identifier for this debug trace" },
          },
          required: ["sessionId"],
        },
      },
      {
        name: "capture_node_screenshot",
        description: "Vision Lens: Capture a base64 encoded screenshot of a specific element to pass to a vision model.",
        inputSchema: {
          type: "object",
          properties: {
            elementId: { type: "string", description: "The data-splice-id of the element to capture" },
          },
          required: ["elementId"],
        },
      },
      {
        name: "generate_observability_report",
        description: "Generate a high-aesthetic HTML dashboard with auto-refresh every 5s showing micro-snapshots and metrics.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "capture_annotated_screenshot",
        description: "Vibe Coding: Capture a base64 screenshot where every interactive element has a bright bounding box and ID label.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "inspect_viewport",
        description: "Multi-modal 'what's visible?': returns the current viewport as an image with numbered highlights over interactive elements (each number maps to a data-splice-id in the JSON), plus a structured map of complex widgets the semantic tree under-reports — video (with live playing/position state), canvas, iframes, sliders, drag-and-drop targets, dropzones, carousels, dense grids — each with interaction advice, and a count of currently animating elements. Use on visually complex UIs (dense grids, media players, animations) where DOM-only observation misleads, or whenever you need to see what a user would see.",
        annotations: { title: "What's Visible?", readOnlyHint: true },
        inputSchema: {
          type: "object",
          properties: {
            maxHighlights: { type: "number", description: "Max interactive elements to number on the overlay (default 40)." },
            includeScreenshot: { type: "boolean", description: "Set false to skip the image and return only the structured widget map (cheaper)." }
          },
        },
      },
      {
        name: "execute_script",
        description: "God-Mode: Execute arbitrary JavaScript in the browser context.",
        inputSchema: {
          type: "object",
          properties: {
            script: { type: "string", description: "JavaScript to execute. Must return a serializable value or undefined." },
          },
          required: ["script"],
        },
      },
      {
        name: "toggle_watch_mode",
        description: "Toggle between headless (invisible) and headful (visible) browser. When enabled, a real Chrome window appears so you can watch the agent work.",
        inputSchema: {
          type: "object",
          properties: {
            enabled: { type: "boolean", description: "true = visible browser, false = headless" },
          },
          required: ["enabled"],
        },
      },
      {
        name: "maintenance_cleanup",
        description: "Delete old snapshots, traces, and report files to free disk space.",
        inputSchema: {
          type: "object",
          properties: {
            olderThanDays: { type: "number", description: "Delete files older than this many days (default: 7)" },
          },
        },
      },
      {
        name: "run_security_audit",
        description: "Agent QA Lab: Run a comprehensive security audit against a URL. Checks security headers, XSS surfaces, CSRF tokens, sensitive data exposure, and third-party dependencies. Automatically crawls linked pages and returns a structured, machine-readable report with actionable AI feedback.",
        inputSchema: {
          type: "object",
          properties: {
            targetUrl: {
              type: "string",
              description: "The URL of the app to audit (e.g. http://localhost:3000)"
            },
            safeMode: {
              type: "boolean",
              description: "If true (default), skip active form probing. Set to false for full active XSS scanning in dev environments only."
            },
            crawl: {
              type: "boolean",
              description: "If true (default), automatically follow same-domain links and audit each page."
            },
            maxCrawlDepth: {
              type: "number",
              description: "Maximum number of pages to crawl (default: 5)."
            },
            checks: {
              type: "array",
              items: { type: "string", enum: ["headers", "xss", "auth", "data", "deps"] },
              description: "Which checks to run. Defaults to all: headers, xss, auth, data, deps."
            }
          },
          required: ["targetUrl"]
        }
      },
      {
        name: "run_diagnostics",
        description: "DX QoL: Run a health check on the Splice environment. Verifies Playwright, Chromium, Vault, and Network connectivity.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "toggle_resource_blocking",
        description: "Performance QoL: Toggle blocking of ads, tracking, and heavy media (images/video). Default is ON for agents.",
        inputSchema: {
          type: "object",
          properties: {
            enabled: { type: "boolean", description: "true = block ads/media, false = allow all" },
          },
          required: ["enabled"],
        },
      },
      {
        name: "get_product_intelligence",
        description: "Behavioral V4: Analyze user behavior logs (clicks, rage-clicks, friction) and provide product-driven feature recommendations for coding agents.",
        inputSchema: {
          type: "object",
          properties: {
            targetUrl: { type: "string", description: "The URL of the product to analyze." },
            intent: { type: "string", description: "Optional specific feature goal (e.g. 'Optimize checkout flow')." }
          },
          required: ["targetUrl"]
        },
      },
      {
        name: "scan_local_secrets",
        description: "Agentic Security V5: Scan the local workspace repository for hardcoded API keys or secrets to prevent supply chain leaks.",
        inputSchema: {
          type: "object",
          properties: {
            directory: { type: "string", description: "The directory to scan. Defaults to process.cwd()." }
          }
        }
      },
      {
        name: "toggle_openclaw_gateway",
        description: "Control the dynamic lifecycle of the optional local OpenClaw gateway server (port 18789). Enables/disables local OpenClaw agents from connecting.",
        inputSchema: {
          type: "object",
          properties: {
            enabled: { type: "boolean", description: "Set true to start the gateway, false to stop it." }
          },
          required: ["enabled"]
        }
      },
      {
        name: "configure_discord_webhook",
        description: "Dynamically configure or update the target Discord Webhook URL for automated significant-event notifications.",
        inputSchema: {
          type: "object",
          properties: {
            webhookUrl: { type: "string", description: "The full Discord webhook URL." }
          },
          required: ["webhookUrl"]
        }
      },
      {
        name: "send_discord_update",
        description: "Send a manual custom status or alert card directly to the configured Discord channel.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Title of the alert card." },
            description: { type: "string", description: "Summary or message details." },
            color: { type: "string", enum: ["red", "green", "yellow", "blue"], description: "Color signature of the notification." }
          },
          required: ["title", "description"]
        }
      },
      {
        name: "get_runtime_health",
        description: "Runtime Reliability: Report live server health — browser connectivity, branch states with last-known URLs, crash/recovery counters, uptime, and run-journal statistics. Call this after any BROWSER_CRASHED or TIMEOUT error to confirm the session recovered.",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "export_run_journal",
        description: "Runtime Reliability: Export the append-only run journal (every tool call with redacted arguments, outcome, duration, and errors) for reproducibility and post-mortem analysis of long autonomous runs.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Maximum number of most-recent entries to return (default: 50)." }
          }
        }
      },
      {
        name: "get_agent_analytics",
        description: "Agent Tracking: Live per-agent performance profiles — success rates, latency, failure streaks, error-class breakdown, tool usage — plus ranked in-action optimization directives for each agent. Pass agentId to inspect one agent, or omit for all tracked agents.",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "Optional: return the profile for a single agent instead of all tracked agents." }
          }
        }
      },
      // ─── Multi-Agent Collaboration Tools ──────────────────────────────────────
      {
        name: "register_agent",
        description: "Multi-Agent: Register this agent with Splice and declare its role. Enables role-appropriate constraints and branch ownership tracking. Roles: explorer, verifier, executor, auditor.",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "Stable identifier for this agent instance (e.g. 'explorer-1')." },
            role: { type: "string", enum: ["explorer", "verifier", "executor", "auditor"], description: "The agent's functional role." }
          },
          required: ["agentId", "role"]
        }
      },
      {
        name: "get_canonical_context",
        description: "Multi-Agent: Pull the Canonical Context Snapshot (CCS) — the single shared source of truth that replaces all agent-to-agent messaging. Returns active branches, promoted findings, quorum state, and registered agents.",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "acquire_branch_ownership",
        description: "Multi-Agent: Claim exclusive write access to a browser branch. Required before calling interact, promote_finding, or handoff_branch on that branch. Fails if another agent already holds it.",
        inputSchema: {
          type: "object",
          properties: {
            branchId: { type: "string", description: "The branch to acquire ownership of." },
            agentId: { type: "string", description: "The acquiring agent's ID." }
          },
          required: ["branchId", "agentId"]
        }
      },
      {
        name: "promote_finding",
        description: "Multi-Agent: Promote a locally-produced finding to the Immutable Evidence Ledger so other agents can read it via get_canonical_context. Requires a confidence score (0–1). Conflicting findings on the same key are flagged for quorum resolution rather than silently overwritten.",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string", description: "Semantic topic key, e.g. 'auth.status' or 'checkout.form.valid'." },
            value: { description: "The finding value (any JSON-serializable type)." },
            confidence: { type: "number", description: "0–1. How confident the agent is in this finding. Entries below 0.7 are excluded from the CCS until resolved." },
            branchId: { type: "string", description: "The branch this finding was produced from. Agent must own this branch." },
            agentId: { type: "string", description: "The agent promoting the finding." }
          },
          required: ["key", "value", "confidence", "branchId", "agentId"]
        }
      },
      {
        name: "resolve_conflict",
        description: "Multi-Agent: Resolve a quorum conflict on a ledger key by selecting the highest-confidence entry. Marks losing entries as superseded and unblocks actions that were waiting on consensus.",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string", description: "The conflicted ledger key to resolve." }
          },
          required: ["key"]
        }
      },
      {
        name: "handoff_branch",
        description: "Multi-Agent: Atomically transfer write ownership of a browser branch from one agent to another. The source agent must currently own the branch. The transfer is recorded in the ledger for auditability.",
        inputSchema: {
          type: "object",
          properties: {
            branchId: { type: "string", description: "The branch to transfer." },
            fromAgentId: { type: "string", description: "The agent releasing ownership." },
            toAgentId: { type: "string", description: "The agent receiving ownership." }
          },
          required: ["branchId", "fromAgentId", "toAgentId"]
        }
      },
      {
        name: "get_coordination_health",
        description: "Multi-Agent: Returns CoordinationTaxMetrics — a live measure of overhead introduced by multi-agent collaboration. Non-zero values in conflictsDetected, blockedActions, or ownershipViolationAttempts indicate the system is paying a coordination tax.",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "get_summons",
        description: "Multi-Agent: List all pending and active summon requests from human users asking for help.",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "acknowledge_summon",
        description: "Multi-Agent: Let an agent acknowledge a pending summon by ID, marking it as accepted by that agent.",
        inputSchema: {
          type: "object",
          properties: {
            summonId: { type: "string", description: "The ID of the summon to acknowledge (e.g., 'summon-123')." },
            agentId: { type: "string", description: "The ID of the agent acknowledging the summon." }
          },
          required: ["summonId", "agentId"]
        }
      }
    ],
  };
});

// Per-tool deadlines so a hung page or dead socket can never stall the
// agent loop indefinitely. 0 = no deadline (human-in-the-loop tools).
const TOOL_TIMEOUTS_MS: Record<string, number> = {
  navigate: 90_000,
  speculative_fork: 120_000,
  run_security_audit: 300_000,
  get_product_intelligence: 180_000,
  request_human_intervention: 0,
};
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const startedAt = Date.now();
  const agentId = typeof (request.params.arguments as any)?.agentId === "string"
    ? (request.params.arguments as any).agentId as string
    : undefined;
  try {
    const timeoutMs = TOOL_TIMEOUTS_MS[toolName] ?? DEFAULT_TOOL_TIMEOUT_MS;
    const execution = dispatchTool(request);
    const result = timeoutMs > 0 ? await withTimeout(execution, timeoutMs, toolName) : await execution;
    const durationMs = Date.now() - startedAt;
    journal.record({
      kind: "tool_call",
      tool: toolName,
      arguments: request.params.arguments,
      outcome: "ok",
      durationMs,
    });
    if (agentId) {
      // Token accounting: rough estimate of what this response costs the agent.
      const tokensReturned = Array.isArray(result?.content)
        ? Math.round(result.content.reduce((sum: number, c: any) => sum + (typeof c?.text === "string" ? c.text.length : 0), 0) / 4)
        : 0;
      browser.agentTracker.recordAction(agentId, { tool: toolName, outcome: "ok", durationMs, tokensReturned });
      // In-action optimization: if the agent's live health has degraded,
      // attach a corrective directive directly to the successful response.
      const directive = browser.agentTracker.getInlineDirective(agentId);
      if (directive && Array.isArray(result?.content)) {
        result.content.push({ type: "text", text: directive });
      }
    }
    return result;
  } catch (error: unknown) {
    const classified = classifyError(error);
    const durationMs = Date.now() - startedAt;
    journal.record({
      kind: "tool_call",
      tool: toolName,
      arguments: request.params.arguments,
      outcome: "error",
      durationMs,
      errorCode: classified.code,
      detail: classified.message,
    });
    if (agentId) {
      browser.agentTracker.recordAction(agentId, { tool: toolName, outcome: "error", durationMs, errorCode: classified.code });
    }
    const directive = agentId ? browser.agentTracker.getInlineDirective(agentId) : null;
    if (classified.code === "CAPTCHA_REQUIRED") {
      return {
        content: [{ type: "text", text: "ERROR: CAPTCHA detected. Please call the 'request_human_intervention' tool." }],
        isError: true,
      };
    }
    const errorText = `Error executing tool '${toolName}': ${classified.message}\n${JSON.stringify({ error: classified.toEnvelope() }, null, 2)}`;
    return {
      content: [{
        type: "text",
        text: directive ? `${errorText}\n\n${directive}` : errorText,
      }],
      isError: true,
    };
  }
});

async function dispatchTool(request: { params: { name: string; arguments?: Record<string, unknown> } }): Promise<any> {
  {
    if (request.params.name === "navigate") {
      const { url } = request.params.arguments as { url: string };
      if (url === "back" || url === "forward" || url === "reload") {
        const result = await browser.historyNavigate(url);
        return { content: [{ type: "text", text: `History ${url} → ${result.url} ("${result.title}").${result.actionId ? ` actionId: ${result.actionId}` : ""}` }] };
      }
      await browser.navigate(url);
      const navActionId = browser.getLastActionId();
      return { content: [{ type: "text", text: `Navigated to ${url}.${navActionId ? ` actionId: ${navActionId} (usable as sinceLastActionId in delta reads)` : ""}` }] };
    }

    if (request.params.name === "wait_for") {
      const { conditions, timeoutMs, pollIntervalMs } = request.params.arguments as any;
      const result = await browser.waitFor(conditions, { timeoutMs, pollIntervalMs });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (request.params.name === "fill_form") {
      const { fields, submitIntent, agentId } = request.params.arguments as any;
      const report = await browser.fillForm({ fields, submitIntent, agentId });
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }

    if (request.params.name === "extract_structured") {
      const { fields, maxRows } = request.params.arguments as any;
      const extraction = await browser.extractStructured({ fields, maxRows });
      return { content: [{ type: "text", text: JSON.stringify(extraction, null, 2) }] };
    }

    if (request.params.name === "assert_page_state") {
      const { expectations } = request.params.arguments as any;
      const assertion = await browser.assertPageState(expectations);
      return { content: [{ type: "text", text: JSON.stringify(assertion, null, 2) }] };
    }

    if (request.params.name === "get_network_activity") {
      const { urlContains, failedOnly, sinceMs, limit } = (request.params.arguments as any) || {};
      const activity = browser.getNetworkActivity({ urlContains, failedOnly: failedOnly === true, sinceMs, limit });
      return { content: [{ type: "text", text: JSON.stringify(activity, null, 2) }] };
    }

    if (request.params.name === "get_page_events") {
      const { sinceMs, type, limit } = (request.params.arguments as any) || {};
      const events = browser.getPageEvents({ sinceMs, type, limit });
      return { content: [{ type: "text", text: JSON.stringify(events, null, 2) }] };
    }

    if (request.params.name === "get_semantic_tree_optimized") {
      const { intent, lens, maxTokens, deltaOnly, lastSnapshotHash, structuralOnly, sinceLastActionId } = request.params.arguments as any;
      if (deltaOnly === true || typeof sinceLastActionId === "string") {
        const delta = await browser.getSemanticDelta(intent, lens || "UX", lastSnapshotHash, structuralOnly === true, sinceLastActionId);
        return { content: [{ type: "text", text: JSON.stringify(delta, null, 2) }] };
      }
      const tree = await browser.getSemanticTree(intent, lens || "UX", maxTokens);
      // snapshotHash is additive: existing clients keep the same tree shape,
      // delta-aware clients feed it back via lastSnapshotHash.
      const content: Array<{ type: string; text: string }> = [
        { type: "text", text: JSON.stringify({ ...tree, snapshotHash: browser.getSnapshotHash() }, null, 2) },
      ];
      // Token efficiency: if this full read re-sent an unchanged page, say so.
      const hint = browser.getObservationEfficiencyHint();
      if (hint) content.push({ type: "text", text: hint });
      return { content };
    }

    if (request.params.name === "interact") {
      const { elementId, action, value, agentId } = request.params.arguments as any;
      const actionId = await browser.interact(elementId, action, value, agentId);
      await new Promise(r => setTimeout(r, 1000)); // wait for network idle/renders
      return { content: [{ type: "text", text: `Successfully performed '${action}' on element '${elementId}'.${actionId ? ` actionId: ${actionId} (usable as sinceLastActionId in delta reads)` : ""}` }] };
    }

    if (request.params.name === "diagnose_agent_state") {
      const { goal, lastActions } = (request.params.arguments as any) || {};
      const diagnosis = await browser.diagnoseAgentState(goal, Array.isArray(lastActions) ? lastActions : []);
      return { content: [{ type: "text", text: JSON.stringify(diagnosis, null, 2) }] };
    }

    if (request.params.name === "compile_verified_action") {
      const { intent, value, constraints, execute, includeVision, compact, expect } = request.params.arguments as any;
      const plan = await browser.compileVerifiedAction({ intent, value, constraints, execute: execute === true, includeVision: typeof includeVision === 'boolean' ? includeVision : undefined, expect: Array.isArray(expect) ? expect : undefined });
      const payload = compact === true ? compactVerifiedPlan(plan) : plan;
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }

    if (request.params.name === "fork_state") {
      const { agentId } = (request.params.arguments as any) || {};
      const branchId = await browser.forkState(agentId);
      return { content: [{ type: "text", text: `Created new branch: ${branchId}${agentId ? ` (owned by ${agentId})` : ''}. Switch using commit_branch.` }] };
    }

    if (request.params.name === "speculative_fork") {
      const { urls } = request.params.arguments as { urls: string[] };
      const summaries = await browser.speculativeFork(urls);
      return {
        content: [{
          type: "text",
          text: `Speculatively forked ${urls.length} branches. How each pre-loaded page differs from the active branch:\n${JSON.stringify(summaries, null, 2)}`,
        }],
      };
    }

    if (request.params.name === "commit_branch") {
      const { branchId } = request.params.arguments as { branchId: string };
      await browser.commitBranch(branchId);
      return { content: [{ type: "text", text: `Active branch is now ${branchId}.` }] };
    }

    if (request.params.name === "save_snapshot") {
      const { name } = request.params.arguments as { name: string };
      const path = await browser.saveSnapshot(name);
      return { content: [{ type: "text", text: `Snapshot saved to ${path}.` }] };
    }

    if (request.params.name === "load_snapshot") {
      const { name } = request.params.arguments as { name: string };
      await browser.loadSnapshot(name);
      return { content: [{ type: "text", text: `Loaded snapshot ${name}. Session resumed.` }] };
    }

    if (request.params.name === "request_human_intervention") {
      const { reason } = request.params.arguments as { reason: string };
      await browser.requestHumanIntervention(reason);
      return { content: [{ type: "text", text: `Human solved the issue and returned control. Resume your task.` }] };
    }

    if (request.params.name === "debug_failure") {
      const { sessionId } = request.params.arguments as { sessionId: string };
      const tracePath = await browser.debugFailure(sessionId);
      return { content: [{ type: "text", text: `Saved Playwright trace to ${tracePath}. To view it, run 'npx playwright show-trace ${tracePath}' on the host machine.` }] };
    }

    if (request.params.name === "capture_node_screenshot") {
      const { elementId } = request.params.arguments as { elementId: string };
      const base64Str = await browser.captureNodeScreenshot(elementId);
      return { content: [{ type: "text", text: base64Str }] };
    }

    if (request.params.name === "generate_observability_report") {
      const reportPath = await browser.generateObservabilityReport();
      return { content: [{ type: "text", text: `Observability Dashboard generated at: ${reportPath}. Open this file in your browser to visualize the agent's processes.` }] };
    }

    if (request.params.name === "capture_annotated_screenshot") {
      const base64Str = await browser.captureAnnotatedScreenshot();
      return { content: [{ type: "text", text: base64Str }] };
    }

    if (request.params.name === "inspect_viewport") {
      const { maxHighlights, includeScreenshot } = (request.params.arguments as any) || {};
      const inspection = await browser.inspectViewport({
        maxHighlights: typeof maxHighlights === 'number' ? maxHighlights : undefined,
        includeScreenshot: includeScreenshot !== false,
      });
      const { screenshot, ...structured } = inspection;
      const content: any[] = [];
      if (screenshot) content.push({ type: "image", data: screenshot, mimeType: "image/png" });
      content.push({ type: "text", text: JSON.stringify(structured, null, 2) });
      return { content };
    }

    if (request.params.name === "execute_script") {
      const { script } = request.params.arguments as { script: string };
      const result = await browser.executeScript(script);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (request.params.name === "toggle_watch_mode") {
      const { enabled } = request.params.arguments as { enabled: boolean };
      await browser.toggleWatchMode(enabled);
      return { content: [{ type: "text", text: `Watch Mode is now ${enabled ? 'ENABLED — a browser window should be visible on your screen.' : 'DISABLED — running headless.'}` }] };
    }

    if (request.params.name === "maintenance_cleanup") {
      const { olderThanDays } = (request.params.arguments as any) || {};
      const result = await browser.maintenanceCleanup(olderThanDays ?? 7);
      return { content: [{ type: "text", text: `Cleanup complete. Removed ${result.removed} files older than ${result.olderThanDays} days.` }] };
    }

    if (request.params.name === "run_security_audit") {
      const { targetUrl, safeMode, crawl, maxCrawlDepth, checks } = request.params.arguments as any;
      const report = await browser.runSecurityAudit(targetUrl, {
        safeMode: safeMode !== false, // default true
        crawl: crawl !== false,       // default true
        maxCrawlDepth: maxCrawlDepth ?? 5,
        checks
      });

      // Return the agent-facing feedback as the primary response, with full JSON appended
      const agentText = [
        `=== SPLICE SECURITY AUDIT REPORT ===`,
        `Target: ${report.url}`,
        `Crawled: ${report.crawledUrls.length} page(s): ${report.crawledUrls.join(', ')}`,
        `Safe Mode: ${report.safeMode}`,
        ``,
        `SUMMARY: ${report.agentFeedback.summary}`,
        `Results: ${report.totals.critical} critical | ${report.totals.warning} warnings | ${report.totals.info} info | ${report.totals.passed} passed`,
        ``,
        report.agentFeedback.criticalActions.length > 0 ? `CRITICAL — FIX IMMEDIATELY:\n${report.agentFeedback.criticalActions.join('\n')}` : '',
        report.agentFeedback.warningActions.length > 0  ? `\nWARNINGS — ADDRESS BEFORE LAUNCH:\n${report.agentFeedback.warningActions.join('\n')}` : '',
        `\nPASSED CHECKS:\n${report.agentFeedback.passed.join('\n')}`,
        ``,
        `=== FULL JSON REPORT ===`,
        JSON.stringify(report, null, 2)
      ].filter(Boolean).join('\n');

      return { content: [{ type: "text", text: agentText }] };
    }

    if (request.params.name === "run_diagnostics") {
      const health = browser.getRuntimeHealth();
      const results = {
        chromium: health.browserConnected ? "OK" : "DISCONNECTED (will auto-recover on next call)",
        vault: fs.existsSync(path.join(spliceDir, ".key")) || process.env.SPLICE_ENCRYPTION_KEY ? "OK" : "NO KEY",
        journal: journal.getStats().totalEntries > 0 ? "OK" : "EMPTY",
        network: "OK",
        crashCount: health.browserCrashCount,
        timestamp: new Date().toISOString()
      };
      // Simple connectivity check
      try { await browser.navigate("https://example.com"); } catch { results.network = "FAIL"; }

      return { content: [{ type: "text", text: `Splice Health Check:\n${JSON.stringify(results, null, 2)}` }] };
    }

    if (request.params.name === "toggle_resource_blocking") {
      const { enabled } = request.params.arguments as { enabled: boolean };
      await browser.toggleResourceBlocking(enabled);
      return { content: [{ type: "text", text: `Resource blocking is now ${enabled ? 'ENABLED' : 'DISABLED'}. Heavy media and ads will be ${enabled ? 'blocked' : 'allowed'} in new branches.` }] };
    }

    if (request.params.name === "get_product_intelligence") {
      const { targetUrl, intent } = request.params.arguments as { targetUrl: string, intent?: string };
      
      // 1. Get the behavior-focused semantic tree
      const tree = await browser.getSemanticTree(intent || "Analyze user behavior", "Behavior");
      
      // 2. Generate a high-level summary of hotspots and friction
      let frictionPoints: any[] = [];
      const findFriction = (node: any) => {
        if (node.behaviorSummary) {
          if (node.behaviorSummary.frictionScore > 30 || node.behaviorSummary.abandonedInputs > 0) {
            frictionPoints.push({
              element: node.text || node.type,
              id: node.id,
              clicks: node.behaviorSummary.clicks,
              rage: node.behaviorSummary.rageClicks,
              abandoned: node.behaviorSummary.abandonedInputs,
              score: node.behaviorSummary.frictionScore,
              scroll: node.behaviorSummary.maxScrollDepth
            });
          }
        }
        if (node.children) node.children.forEach(findFriction);
      };
      findFriction(tree);

      const maxScroll = frictionPoints.length > 0 ? frictionPoints[0].scroll : 0;

      const recommendations = frictionPoints.map(f => {
        if (f.abandoned > 0) return `- Input "${f.element}" (ID: ${f.id}) has high abandonment. Users start but don't finish. Suggest checking validation or label clarity.`;
        if (f.rage > 0) return `- Element "${f.element}" (ID: ${f.id}) is causing rage clicks. Suggest verifying if the event handler is responsive or if the UI is confusing.`;
        if (f.clicks > 10) return `- Element "${f.element}" (ID: ${f.id}) is a high-traffic hotspot. Suggest prioritizing feature enhancements here.`;
        return `- Element "${f.element}" has a friction score of ${f.score}. Suggest UI polish.`;
      }).join('\n');

      const scrollIntel = maxScroll < 50 ? `⚠️ Low engagement: Users only scroll to ${maxScroll}% of the page. Consider moving key content higher.` : `✅ Healthy engagement: Users scroll to ${maxScroll}% of the page.`;

      const intelReport = `
### 📊 Splice Deep Product Intelligence: ${targetUrl}

#### 🛠️ Behavioral Analysis
- Analyzed User Intent: ${intent || "General Exploration"}
- Friction Points Detected: ${frictionPoints.length}
- **Engagement (Scroll Depth):** ${scrollIntel}

#### 💡 Agent Recommendations
${recommendations || "- No major friction points detected. The current UI appears intuitive."}

#### 🤖 Action Plan for Coding Agent:
1. Optimize elements with high abandonment or rage-clicks.
2. Ensure primary CTAs are within the active scroll depth (${maxScroll}%).
3. Review the Behavioral Heatmap for visibility-dwell correlations.
      `.trim();

      return { content: [{ type: "text", text: intelReport }] };
    }

    if (request.params.name === "scan_local_secrets") {
      const { directory = process.cwd() } = (request.params.arguments as any) || {};
      const results: string[] = [];
      const SECRET_RX = /(AKIA[0-9A-Z]{16}|sk_(live|test)_[a-zA-Z0-9]{20,}|eyJ[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+)/;

      const scanDir = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file === 'node_modules' || file === '.git' || file === '.splice' || file === 'dist') continue;
          const fullPath = path.join(dir, file);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            scanDir(fullPath);
          } else {
            try {
              const content = fs.readFileSync(fullPath, 'utf8');
              const match = content.match(SECRET_RX);
              if (match) {
                results.push(`[EXPOSED SECRET] File: ${fullPath} contains potential secret: ${match[0].substring(0, 10)}...`);
              }
            } catch (e) { /* ignore binary/unreadable files */ }
          }
        }
      };

      scanDir(directory);
      const text = results.length > 0 
        ? `⚠️ WARNING: Found ${results.length} exposed secrets in the repository:\n${results.join('\n')}\nPlease remove these before committing!`
        : `✅ SCAN PASSED: No exposed API keys or secrets found in ${directory}.`;
      
      // Send automated Discord notification for exposed secrets
      if (results.length > 0 && discordNotifier.isActive()) {
        discordNotifier.sendEmbed({
          title: "🚨 CRITICAL: Exposed Secrets Found in Repository",
          description: `Splice local secret scanner has detected **${results.length}** exposed API keys or tokens in the codebase.`,
          color: 0xe74c3c,
          fields: [
            { name: "Scanned Directory", value: directory, inline: false },
            { name: "Details", value: results.join('\n').substring(0, 1000), inline: false }
          ],
          footerText: "Splice Enterprise Security Hub"
        }).catch(err => console.error("Error sending secrets alert to Discord:", err.message));
      }
      
      return { content: [{ type: "text", text }] };
    }

    if (request.params.name === "toggle_openclaw_gateway") {
      const { enabled } = request.params.arguments as { enabled: boolean };
      await browser.toggleOpenClawGateway(enabled);
      return { content: [{ type: "text", text: `OpenClaw Gateway server is now ${enabled ? 'ENABLED and listening securely on port 18789' : 'DISABLED'}.` }] };
    }

    if (request.params.name === "configure_discord_webhook") {
      const { webhookUrl } = request.params.arguments as { webhookUrl: string };
      discordNotifier.setWebhookUrl(webhookUrl);
      return { content: [{ type: "text", text: `Discord Webhook URL has been configured successfully.` }] };
    }

    if (request.params.name === "send_discord_update") {
      const { title, description, color } = request.params.arguments as { title: string; description: string; color?: string };
      
      let colorCode = 0x3498db; // blue
      if (color === "red") colorCode = 0xe74c3c;
      else if (color === "green") colorCode = 0x2ecc71;
      else if (color === "yellow") colorCode = 0xf1c40f;

      const sent = await discordNotifier.sendEmbed({
        title,
        description,
        color: colorCode
      });

      if (!sent) {
        return { 
          content: [{ type: "text", text: `Failed to send Discord update. Ensure DISCORD_WEBHOOK_URL is configured.` }],
          isError: true
        };
      }
      return { content: [{ type: "text", text: `Successfully sent manual status update to Discord.` }] };
    }

    // ─── Multi-Agent Collaboration Handlers ─────────────────────────────────

    if (request.params.name === "register_agent") {
      const { agentId, role } = request.params.arguments as { agentId: string; role: any };
      const reg = browser.coordinator.registerAgent(agentId, role);
      return { content: [{ type: "text", text: `Agent registered:\n${JSON.stringify(reg, null, 2)}` }] };
    }

    if (request.params.name === "get_canonical_context") {
      const ccs = browser.coordinator.buildCanonicalContext();
      return { content: [{ type: "text", text: JSON.stringify(ccs, null, 2) }] };
    }

    if (request.params.name === "acquire_branch_ownership") {
      const { branchId, agentId } = request.params.arguments as { branchId: string; agentId: string };
      const acquired = browser.coordinator.acquireOwnership(branchId, agentId);
      if (!acquired) {
        const owner = browser.coordinator.getOwner(branchId);
        return {
          content: [{ type: "text", text: `Ownership rejected: branch "${branchId}" is currently owned by "${owner}". Call handoff_branch first, or wait for the owner to release it.` }],
          isError: true
        };
      }
      return { content: [{ type: "text", text: `Agent "${agentId}" now owns branch "${branchId}". You may now call interact and promote_finding on this branch.` }] };
    }

    if (request.params.name === "promote_finding") {
      const { key, value, confidence, branchId, agentId } = request.params.arguments as any;
      const entry = browser.promoteFinding(key, value, confidence, branchId, agentId);
      const conflicted = browser.coordinator.getConflictedKeys();
      const isConflicted = conflicted.includes(key);
      return {
        content: [{
          type: "text",
          text: [
            `Finding promoted to ledger (id=${entry.id}).`,
            isConflicted
              ? `⚠️  CONFLICT DETECTED on key "${key}": another agent has posted a contradictory finding. Call resolve_conflict to unblock related actions.`
              : `✅ No conflicts on key "${key}". Finding is visible in the Canonical Context.`
          ].join('\n')
        }]
      };
    }

    if (request.params.name === "resolve_conflict") {
      const { key } = request.params.arguments as { key: string };
      const winner = browser.coordinator.resolveConflict(key);
      if (!winner) {
        return { content: [{ type: "text", text: `No active conflict found for key "${key}".` }] };
      }
      return {
        content: [{
          type: "text",
          text: [
            `Conflict resolved for key "${key}".`,
            `Winner: agent "${winner.agentId}" (confidence=${winner.confidence}, id=${winner.id}).`,
            `Any actions that were blocked by this conflict are now unblocked.`
          ].join('\n')
        }]
      };
    }

    if (request.params.name === "handoff_branch") {
      const { branchId, fromAgentId, toAgentId } = request.params.arguments as any;
      browser.handoffBranch(branchId, fromAgentId, toAgentId);
      return { content: [{ type: "text", text: `Branch "${branchId}" transferred from "${fromAgentId}" to "${toAgentId}". Transfer recorded in the Evidence Ledger.` }] };
    }

    if (request.params.name === "get_coordination_health") {
      const metrics = browser.coordinator.getCoordinationTaxMetrics();
      const ccs = browser.coordinator.buildCanonicalContext();
      const report = [
        `=== COORDINATION HEALTH REPORT ===`,
        `System State: ${ccs.systemState.toUpperCase()}`,
        ``,
        `COORDINATION TAX METRICS (non-zero = overhead introduced by multi-agent setup):`,
        `  Conflicts Detected:           ${metrics.conflictsDetected}`,
        `  Conflicts Resolved:           ${metrics.conflictsResolved}`,
        `  Actions Blocked by Quorum:    ${metrics.blockedActions}`,
        `  Ownership Violation Attempts: ${metrics.ownershipViolationAttempts}`,
        `  Forced Branch Releases:       ${metrics.forcedReleases}`,
        ``,
        `CONFLICTED KEYS (require resolve_conflict):`,
        ccs.blockedKeys.length > 0 ? ccs.blockedKeys.map(k => `  - ${k}`).join('\n') : '  None',
        ``,
        `REGISTERED AGENTS: ${ccs.registeredAgents.length}`,
        ...ccs.registeredAgents.map(a => `  - ${a.agentId} [${a.role}]`),
        ``,
        `ACTIVE BRANCHES: ${ccs.activeBranches.length}`,
        ...ccs.activeBranches.map(b => `  - ${b.branchId} → owner: ${b.ownerAgentId ?? 'none'} (${b.currentUrl})`),
      ].join('\n');
      return { content: [{ type: "text", text: report }] };
    }

    if (request.params.name === "get_summons") {
      const summons = browser.coordinator.getSummons();
      return { content: [{ type: "text", text: JSON.stringify(summons, null, 2) }] };
    }

    if (request.params.name === "acknowledge_summon") {
      const { summonId, agentId } = request.params.arguments as { summonId: string; agentId: string };
      const req = browser.acknowledgeSummon(summonId, agentId);
      if (!req) {
        return {
          content: [{ type: "text", text: `Summon request with ID "${summonId}" not found.` }],
          isError: true
        };
      }
      return { content: [{ type: "text", text: `Agent "${agentId}" successfully acknowledged summon "${summonId}". You are now assigned to help the user on branch 'main'.` }] };
    }

    if (request.params.name === "get_runtime_health") {
      const health = browser.getRuntimeHealth();
      const journalStats = journal.getStats();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ...health, journal: journalStats }, null, 2),
        }],
      };
    }

    if (request.params.name === "get_agent_analytics") {
      const { agentId } = (request.params.arguments as any) || {};
      if (agentId) {
        const profile = browser.agentTracker.getProfile(agentId);
        if (!profile) {
          return {
            content: [{ type: "text", text: `No tracked activity for agent "${agentId}". Actions are tracked when tools are called with an agentId argument.` }],
          };
        }
        return { content: [{ type: "text", text: JSON.stringify(profile, null, 2) }] };
      }
      const profiles = browser.agentTracker.getAllProfiles();
      if (profiles.length === 0) {
        return {
          content: [{ type: "text", text: "No agent activity tracked yet. Pass agentId on tool calls (e.g. interact) to enable per-agent tracking and in-action optimization." }],
        };
      }
      const summary = profiles.map((p) =>
        `${p.agentId}: ${p.status.toUpperCase()} — ${Math.round(p.successRate * 100)}% success over ${p.totalActions} action(s), avg ${p.avgDurationMs}ms${p.optimizations[0] ? `\n  ↳ ${p.optimizations[0].directive}` : ""}`
      ).join("\n");
      return {
        content: [{
          type: "text",
          text: `=== AGENT PERFORMANCE ANALYTICS ===\n${summary}\n\n=== FULL PROFILES ===\n${JSON.stringify(profiles, null, 2)}`,
        }],
      };
    }

    if (request.params.name === "export_run_journal") {
      const { limit } = (request.params.arguments as any) || {};
      const entries = journal.tail(typeof limit === "number" && limit > 0 ? Math.min(limit, 500) : 50);
      return {
        content: [{
          type: "text",
          text: [
            `Run journal: ${journal.journalPath}`,
            `Session: ${journal.sessionId} — ${entries.length} most recent entries below.`,
            JSON.stringify(entries, null, 2),
          ].join("\n"),
        }],
      };
    }

    throw new Error(`Tool not found: ${request.params.name}`);
  }
}

// ─── Process-level runtime reliability ──────────────────────────────────────
// Long autonomous runs must survive stray async failures. Anything that
// escapes a tool handler is journaled and absorbed; the browser layer
// self-heals on the next call instead of taking the whole server down.

let shuttingDown = false;

process.on("unhandledRejection", (reason) => {
  journal.record({ kind: "crash", outcome: "error", errorCode: "UNHANDLED_REJECTION", detail: errorMessage(reason) });
  console.error("[Splice Reliability] Unhandled rejection absorbed:", errorMessage(reason));
});

process.on("uncaughtException", (error) => {
  journal.record({ kind: "crash", outcome: "error", errorCode: "UNCAUGHT_EXCEPTION", detail: errorMessage(error) });
  console.error("[Splice Reliability] Uncaught exception absorbed:", errorMessage(error));
});

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[Splice] Received ${signal} — shutting down gracefully...`);
  journal.record({ kind: "lifecycle", outcome: "info", detail: `shutdown_${signal.toLowerCase()}` });
  try {
    await withTimeout(browser.close(), 10_000, "graceful shutdown");
  } catch (e) {
    console.error("[Splice] Browser close during shutdown failed:", errorMessage(e));
  }
  journal.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function main() {
  await browser.init();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  journal.record({ kind: "lifecycle", outcome: "info", detail: "mcp_server_connected" });
  console.error(`Splice Enterprise MCP Server is running... (journal: ${journal.journalPath})`);
}

main().catch((error) => {
  journal.record({ kind: "crash", outcome: "error", errorCode: "FATAL_STARTUP", detail: errorMessage(error) });
  journal.close();
  console.error("Fatal error running server:", error);
  process.exit(1);
});
