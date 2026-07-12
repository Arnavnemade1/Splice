/**
 * Splice Prompt Optimizer
 *
 * Rewrites verbose, conversational prompts into the structured intents
 * Splice's cognition APIs rank best — deterministically, offline, with no
 * model calls. Three levers:
 *
 *  1. Compression — courtesy filler, hedges, and redundant context are
 *     stripped ("Could you please click on the Submit button for me?" →
 *     'click "Submit"'), saving tokens on every call that carries the intent.
 *  2. Grounding — the target phrase is matched against the page's actual
 *     visible labels and replaced with the exact on-page text, quoted, which
 *     is precisely what candidate ranking scores highest.
 *  3. Routing — prompts that describe a job for a one-call primitive
 *     (fill_form, wait_for, extract_structured, assert_page_state) are
 *     detected and redirected, replacing N compile/observe round trips
 *     with one purpose-built call.
 *
 * Permission model: this module never applies anything by itself. Callers
 * surface the optimization (optimize_prompt tool), apply it per-call
 * (optimizeIntent: true on compile_verified_action), or enable standing
 * permission via promptOptimization in splice.config.json. Every applied
 * rewrite is reported back with the original preserved — never silent.
 */

export interface PageLabel {
  kind: 'click' | 'type' | 'select';
  label: string;
}

export interface PromptOptimization {
  original: string;
  optimized: string;
  /** Extracted input value — pass as compile_verified_action's `value`. */
  value?: string;
  changed: boolean;
  /** Human-readable record of every transformation applied. */
  transformations: string[];
  /** Set when the target was matched to an exact visible on-page label. */
  groundedTo?: string;
  /** Set when a one-call primitive fits this prompt better than a compiled action. */
  toolSuggestion?: { tool: string; reason: string; args?: Record<string, unknown> };
  /**
   * Set when the prompt chained sequential actions ("… then …"). Each step is
   * independently optimized; execute them in order with compile_verified_action.
   * `optimized` holds the first step for callers that apply a single intent.
   */
  steps?: Array<{ intent: string; value?: string; toolSuggestion?: PromptOptimization['toolSuggestion'] }>;
  /** Chars/4 heuristic, consistent with the rest of the codebase. */
  estimatedTokensSaved: number;
}

// ─── Compression ────────────────────────────────────────────────────────────

/** Leading conversational scaffolding, applied repeatedly since it stacks. */
const LEADING_FILLER: RegExp[] = [
  /^(hey|hi|hello|ok(ay)?|alright|so)[,!.]?\s+/i,
  /^(can|could|would|will) you( please)?( kindly)?\s+/i,
  /^i('d| would)? (want|need|would like|like) (you |it )?(to )?\s*/i,
  /^(please|kindly|go ahead and|let'?s|just|simply|now|then|try to|proceed to)\s+/i,
];

/** Inline noise that survives anywhere in the prompt. */
const INLINE_FILLER: Array<{ pattern: RegExp; note: string }> = [
  { pattern: /\b(please|kindly)\b\s*/gi, note: '"please"/"kindly"' },
  { pattern: /\b(for me|for us)\b\s*/gi, note: '"for me"' },
  { pattern: /\bif (you can|possible|you don'?t mind)\b\s*/gi, note: '"if possible"' },
  { pattern: /\bon (the|this) (current )?(page|screen|site|website|form)\b\s*/gi, note: 'page references' },
  { pattern: /\b(thanks( in advance)?|thank you|thx)\b[.!]?\s*$/i, note: 'sign-off' },
];

/** Keyboard keys that keep "press" as a keyboard action instead of a click. */
const KEY_NAMES = /^(enter|return|tab|escape|esc|space|spacebar|backspace|delete|home|end|page ?(up|down)|arrow ?(up|down|left|right)|f\d{1,2})\b/i;

/** Trailing container nouns that add tokens without adding ranking signal. */
const CONTAINER_NOUNS = /\s+(button|link|field|box|input|textbox|checkbox|check box|toggle|switch|tab|icon|element|control|dropdown|menu item)$/i;

// ─── Target handling ────────────────────────────────────────────────────────

const ACTION_VERB = /^(click|type|select|check|uncheck|hover|focus|press|clear|toggle|open|close|dismiss|expand|scroll to)\b/i;

function tokensOf(phrase: string): string[] {
  return phrase
    .toLowerCase()
    .replace(CONTAINER_NOUNS, '')
    .replace(/["'.,!?]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !['the', 'a', 'an', 'my', 'that', 'this', 'to', 'on', 'in'].includes(t));
}

/**
 * Match a target phrase against visible page labels. Returns the label only
 * on a confident match: most target tokens present in the label, and the
 * label not wildly longer than what was asked for.
 */
function groundTarget(targetPhrase: string, labels: PageLabel[], preferKind?: PageLabel['kind']): PageLabel | null {
  const target = tokensOf(targetPhrase);
  if (target.length === 0 || labels.length === 0) return null;
  let best: { label: PageLabel; score: number } | null = null;
  for (const candidate of labels) {
    const labelTokens = tokensOf(candidate.label);
    if (labelTokens.length === 0) continue;
    const hits = target.filter((t) => labelTokens.some((l) => l === t || l.startsWith(t) || t.startsWith(l))).length;
    let score = hits / target.length;
    if (labelTokens.length > target.length + 4) score -= 0.15; // asked for a word, matched a paragraph
    if (preferKind && candidate.kind === preferKind) score += 0.1;
    if (score > (best?.score ?? 0)) best = { label: candidate, score };
  }
  return best && best.score >= 0.7 ? best.label : null;
}

// ─── Tool routing ───────────────────────────────────────────────────────────

function detectToolRouting(prompt: string): PromptOptimization['toolSuggestion'] | undefined {
  // navigate: "go to example.com/pricing", "open https://app.example.com"
  const nav = prompt.match(/^(?:go to|navigate to|open|visit|load)\s+(?:the\s+)?((?:https?:\/\/)?[\w-]+(?:\.[\w-]+)+(?:\/\S*)?)\s*$/i);
  if (nav) {
    const url = nav[1].startsWith('http') ? nav[1] : `https://${nav[1]}`;
    return {
      tool: 'navigate',
      reason: 'URL prompts are a direct navigation, not a compiled page action.',
      args: { url },
    };
  }

  // fill_form (credentials): "log in with alice@example.com and password hunter2"
  const login = prompt.match(/^(?:log ?in|sign ?in)(?: to [\w .-]+)?\s+(?:with|as|using)\s+(?:username\s+|email\s+|user\s+)?(\S+?),?\s+(?:and\s+)?(?:with\s+)?password\s+(\S+)\s*$/i);
  if (login) {
    return {
      tool: 'fill_form',
      reason: 'Login prompts map to one verified batch fill plus a submit intent.',
      args: {
        fields: [
          { field: login[1].includes('@') ? 'email' : 'username', value: login[1] },
          { field: 'password', value: login[2] },
        ],
        submitIntent: 'click "Sign in"',
      },
    };
  }

  // wait_for: "wait until the receipt appears", "wait for the spinner to disappear"
  const wait = prompt.match(/^wait (?:for|until)\s+(.+)$/i);
  if (wait) {
    const rest = wait[1].replace(/^the\s+/i, '');
    const gone = /\b(disappear|to disappear|is gone|goes? away|vanish(es)?|is hidden|to hide)\b/i;
    const kind = gone.test(rest) ? 'element_hidden' : /\burl\b/i.test(rest) ? 'url_matches' : 'text_present';
    const value = rest.replace(gone, '').replace(/\b(to (appear|show( up)?|load|be visible)|appears?|shows? up|loads?|is visible)\b/i, '').trim().replace(/[.!?]+$/, '');
    return {
      tool: 'wait_for',
      reason: 'Waiting prompts should block on a semantic condition instead of compiling an action.',
      args: { conditions: [{ kind, value }] },
    };
  }

  // assert_page_state: "verify that the order total is $49" — but never
  // "check the terms checkbox", which is an action on a control.
  const assert = prompt.match(/^(?:check|verify|confirm|ensure|make sure|assert)(?:\s+that)?\s+(.+)$/i);
  if (assert && (/\bthat\b/i.test(prompt) || /\b(is|are|was|were|has|have|shows?|says?|contains?|appears?|displayed|visible|loaded|exists?)\b/i.test(assert[1]))) {
    const kind = /\burl\b/i.test(assert[1]) ? 'url_contains' : 'text_present';
    return {
      tool: 'assert_page_state',
      reason: 'Verification prompts cost a fraction of a compiled action as postcondition checks.',
      args: { expectations: [{ kind, value: assert[1].trim().replace(/[.!?]+$/, '') }] },
    };
  }

  // extract_structured: "extract the plan names and prices", "get all the prices"
  const extract = prompt.match(/^(extract|scrape|collect|pull|grab|get|list)\s+(?:all\s+|the\s+|every\s+)*(.+)$/i);
  if (extract && !CONTAINER_NOUNS.test(` ${extract[2]}`)) {
    const verb = extract[1].toLowerCase();
    const explicitVerb = ['extract', 'scrape', 'collect'].includes(verb);
    const fields = extract[2].split(/,|\band\b/i).map((f) => tokensOf(f).join(' ')).filter(Boolean);
    if (explicitVerb || (fields.length >= 2) || /\b(all|every)\b/i.test(prompt)) {
      return {
        tool: 'extract_structured',
        reason: 'Data prompts should pull clean rows by field name instead of reading trees into context.',
        args: { fields: fields.map((name) => ({ name, hint: name })) },
      };
    }
  }

  // fill_form: two or more field/value pairs in one prompt.
  const body = prompt.replace(/^fill (?:in |out )?(?:the )?form (?:with )?/i, '');
  const pairs = body
    .split(/,|\band\b/i)
    .map((segment) => segment.match(/([a-z][\w ]*?)\s+(?:with|as|=|:|\bto\b)\s+("[^"]+"|'[^']+'|\S+)/i))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ field: tokensOf(m[1]).join(' '), value: m[2].replace(/^["']|["']$/g, '') }))
    .filter((p) => p.field.length > 0);
  if (pairs.length >= 2) {
    return {
      tool: 'fill_form',
      reason: `One batch fill replaces ${pairs.length} compile/observe round trips with per-field readback verification.`,
      args: { fields: pairs },
    };
  }

  return undefined;
}

// ─── The optimizer ──────────────────────────────────────────────────────────

/**
 * Sequential chains ("do X, then do Y, after that do Z") split into ordered
 * steps, each optimized independently. Only unambiguous sequence markers
 * split — a bare "and" stays intact because it also joins field/value pairs.
 */
const STEP_SEPARATOR = /\s*(?:[,;.]\s*)?\b(?:and )?then\b\s*|\s*(?:[,;.]\s*)?\bafter (?:that|which)\b,?\s*|\s*;\s+/i;

export function optimizePrompt(prompt: string, pageLabels: PageLabel[] = []): PromptOptimization {
  const segments = prompt.split(new RegExp(STEP_SEPARATOR.source, 'gi')).map((s) => (s ?? '').trim()).filter(Boolean);
  if (segments.length >= 2) {
    const steps = segments.map((segment) => {
      const sub = optimizeSingle(segment, pageLabels);
      return {
        intent: sub.optimized,
        ...(sub.value !== undefined ? { value: sub.value } : {}),
        ...(sub.toolSuggestion !== undefined ? { toolSuggestion: sub.toolSuggestion } : {}),
      };
    });
    const first = optimizeSingle(segments[0], pageLabels);
    return {
      ...first,
      original: prompt,
      changed: true,
      steps,
      transformations: [`split into ${steps.length} sequential steps`, ...first.transformations],
      estimatedTokensSaved: Math.max(0, Math.round((prompt.length - steps.reduce((n, s) => n + s.intent.length + (s.value?.length ?? 0), 0)) / 4)),
    };
  }
  return optimizeSingle(prompt, pageLabels);
}

function optimizeSingle(prompt: string, pageLabels: PageLabel[] = []): PromptOptimization {
  const original = prompt;
  const transformations: string[] = [];
  let text = prompt.replace(/\s+/g, ' ').trim();

  // 1. Compression: strip conversational scaffolding.
  const inlineNotes = new Set<string>();
  for (const { pattern, note } of INLINE_FILLER) {
    if (pattern.test(text)) {
      text = text.replace(pattern, ' ').replace(/\s+/g, ' ').trim();
      inlineNotes.add(note);
    }
  }
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const pattern of LEADING_FILLER) {
      if (pattern.test(text)) {
        text = text.replace(pattern, '').trim();
        stripped = true;
        inlineNotes.add('leading scaffolding');
      }
    }
  }
  text = text.replace(/[.!?\s]+$/, '');
  if (inlineNotes.size > 0) transformations.push(`stripped filler (${[...inlineNotes].join(', ')})`);

  // 2. Verb normalization onto the vocabulary candidate ranking expects.
  const verbFixes: Array<[RegExp, string]> = [
    [/\b(tap|hit|push)( on)?\b/gi, 'click'],
    [/\bclick on\b/gi, 'click'],
    [/^(input|write|enter)\b/i, 'type'],
    [/^(choose|pick)\b/i, 'select'],
  ];
  for (const [pattern, replacement] of verbFixes) {
    if (pattern.test(text)) {
      text = text.replace(pattern, replacement);
      transformations.push(`normalized verb → "${replacement}"`);
    }
  }
  // "press X" is a click unless X is a keyboard key.
  const press = text.match(/^press(?: on)?\s+(.+)$/i);
  if (press && !KEY_NAMES.test(press[1].replace(/^the\s+/i, ''))) {
    text = `click ${press[1]}`;
    transformations.push('normalized verb → "click"');
  }

  // 3. Routing: does a one-call primitive fit better?
  const toolSuggestion = detectToolRouting(text);

  // 4. Value extraction: "type agent@x.com into the work email field"
  //    becomes intent 'type into "work email"' + a separate value.
  let value: string | undefined;
  if (!toolSuggestion) {
    const typed = text.match(/^type\s+(.+?)\s+(?:in|into|inside|on)\s+(?:the\s+)?(.+)$/i);
    if (typed) {
      value = typed[1].replace(/^["']|["']$/g, '');
      const targetPhrase = typed[2].replace(CONTAINER_NOUNS, '');
      const grounded = groundTarget(targetPhrase, pageLabels, 'type');
      text = `type into "${grounded ? grounded.label : targetPhrase}"`;
      transformations.push('separated value from intent (pass as `value`)');
      if (grounded) transformations.push(`grounded target to on-page label "${grounded.label}"`);
      return finish(original, text, transformations, value, grounded?.label, toolSuggestion);
    }
  }

  // 5. Grounding for click-family intents: quote the exact visible label.
  const verbMatch = text.match(ACTION_VERB);
  if (!toolSuggestion && verbMatch && !/"/.test(text)) {
    const verb = verbMatch[0].toLowerCase();
    const targetPhrase = text.slice(verbMatch[0].length).replace(/^\s+(the|a|an|my)\s+/i, ' ').trim();
    if (targetPhrase) {
      const bare = targetPhrase.replace(CONTAINER_NOUNS, '');
      const grounded = groundTarget(bare, pageLabels, verb === 'type' ? 'type' : verb === 'select' ? 'select' : 'click');
      if (grounded) {
        text = `${verb} "${grounded.label}"`;
        transformations.push(`grounded target to on-page label "${grounded.label}"`);
        return finish(original, text, transformations, value, grounded.label, toolSuggestion);
      }
      if (bare !== targetPhrase) {
        text = `${verb} ${bare}`;
        transformations.push('dropped redundant container noun');
      }
    }
  }

  return finish(original, text, transformations, value, undefined, toolSuggestion);
}

function finish(
  original: string,
  optimized: string,
  transformations: string[],
  value: string | undefined,
  groundedTo: string | undefined,
  toolSuggestion: PromptOptimization['toolSuggestion']
): PromptOptimization {
  if (toolSuggestion) transformations.push(`routed to ${toolSuggestion.tool}: ${toolSuggestion.reason}`);
  const changed = optimized !== original || value !== undefined || toolSuggestion !== undefined;
  const savedChars = original.length - optimized.length - (value?.length ?? 0);
  return {
    original,
    optimized,
    ...(value !== undefined ? { value } : {}),
    changed,
    transformations,
    ...(groundedTo !== undefined ? { groundedTo } : {}),
    ...(toolSuggestion !== undefined ? { toolSuggestion } : {}),
    estimatedTokensSaved: Math.max(0, Math.round(savedChars / 4)),
  };
}
