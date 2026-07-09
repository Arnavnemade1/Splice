/**
 * Splice Resilience Layer
 *
 * Runtime reliability primitives for long-running autonomous sessions:
 * a typed error taxonomy, transient-failure classification, bounded
 * retries with exponential backoff, and hard timeouts so no tool call
 * can hang the agent loop forever.
 */

export type SpliceErrorCode =
  | 'BROWSER_CRASHED'
  | 'PAGE_CRASHED'
  | 'BRANCH_NOT_FOUND'
  | 'TARGET_NOT_FOUND'
  | 'NAVIGATION_FAILED'
  | 'NETWORK_TRANSIENT'
  | 'TIMEOUT'
  | 'CAPTCHA_REQUIRED'
  | 'OWNERSHIP_VIOLATION'
  | 'INVALID_INPUT'
  | 'POLICY_BLOCKED'
  | 'INTERNAL';

export interface SpliceErrorShape {
  code: SpliceErrorCode;
  message: string;
  /** Whether retrying the same call (possibly after recovery) can succeed. */
  recoverable: boolean;
  /** The MCP tool an agent should call next to get unstuck. */
  suggestedNextTool?: string;
  detail?: string;
}

export class SpliceError extends Error implements SpliceErrorShape {
  public readonly code: SpliceErrorCode;
  public readonly recoverable: boolean;
  public readonly suggestedNextTool?: string;
  public readonly detail?: string;

  constructor(shape: SpliceErrorShape) {
    super(shape.message);
    this.name = 'SpliceError';
    this.code = shape.code;
    this.recoverable = shape.recoverable;
    this.suggestedNextTool = shape.suggestedNextTool;
    this.detail = shape.detail;
  }

  toEnvelope(): SpliceErrorShape {
    return {
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      suggestedNextTool: this.suggestedNextTool,
      detail: this.detail,
    };
  }
}

/** Safely extract a message from any thrown value. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

const TRANSIENT_PATTERNS = [
  /net::ERR_(CONNECTION_(RESET|REFUSED|CLOSED|TIMED_OUT)|NETWORK_CHANGED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|TIMED_OUT)/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND/i,
  /Timeout \d+ms exceeded/i,
  /Navigation timeout/i,
  /socket hang up/i,
];

const CRASH_PATTERNS = [
  /Target (page, context or browser|closed)/i,
  /browser has been closed/i,
  /Target crashed/i,
  /Execution context was destroyed/i,
  /Protocol error.*(Target closed|Session closed)/i,
];

export function isTransientError(e: unknown): boolean {
  const msg = errorMessage(e);
  return TRANSIENT_PATTERNS.some((rx) => rx.test(msg));
}

export function isCrashError(e: unknown): boolean {
  const msg = errorMessage(e);
  return CRASH_PATTERNS.some((rx) => rx.test(msg));
}

/**
 * Normalize any thrown value into a SpliceError so every tool response
 * carries a machine-readable code, recoverability flag, and next step.
 */
export function classifyError(e: unknown): SpliceError {
  if (e instanceof SpliceError) return e;
  const msg = errorMessage(e);

  if (msg.includes('CAPTCHA_REQUIRED')) {
    return new SpliceError({
      code: 'CAPTCHA_REQUIRED',
      message: 'CAPTCHA or anti-bot verification is blocking the workflow.',
      recoverable: true,
      suggestedNextTool: 'request_human_intervention',
      detail: msg,
    });
  }
  if (isCrashError(e)) {
    return new SpliceError({
      code: 'BROWSER_CRASHED',
      message: 'The browser or page crashed mid-operation. Splice will recover the session on the next call.',
      recoverable: true,
      suggestedNextTool: 'get_runtime_health',
      detail: msg,
    });
  }
  if (isTransientError(e)) {
    return new SpliceError({
      code: 'NETWORK_TRANSIENT',
      message: 'A transient network failure occurred. Retrying the same call is likely to succeed.',
      recoverable: true,
      suggestedNextTool: 'diagnose_agent_state',
      detail: msg,
    });
  }
  if (/not found or not visible/i.test(msg) || /Element .* not found/i.test(msg)) {
    return new SpliceError({
      code: 'TARGET_NOT_FOUND',
      message: msg,
      recoverable: true,
      suggestedNextTool: 'get_semantic_tree_optimized',
      detail: 'Re-extract the semantic tree; the element ID may be stale after a page mutation.',
    });
  }
  if (/does not exist|not found/i.test(msg) && /branch/i.test(msg)) {
    return new SpliceError({
      code: 'BRANCH_NOT_FOUND',
      message: msg,
      recoverable: true,
      suggestedNextTool: 'get_runtime_health',
    });
  }
  if (/owned by|ownership/i.test(msg)) {
    return new SpliceError({
      code: 'OWNERSHIP_VIOLATION',
      message: msg,
      recoverable: true,
      suggestedNextTool: 'get_canonical_context',
    });
  }
  return new SpliceError({
    code: 'INTERNAL',
    message: msg,
    recoverable: false,
    suggestedNextTool: 'debug_failure',
  });
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Defaults to retrying only transient failures. */
  isRetryable?: (e: unknown) => boolean;
  onRetry?: (attempt: number, e: unknown) => void;
}

/** Run an async operation with bounded exponential-backoff retries. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    retries = 2,
    baseDelayMs = 300,
    maxDelayMs = 5_000,
    isRetryable = isTransientError,
    onRetry,
  } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt === retries || !isRetryable(e)) throw e;
      onRetry?.(attempt + 1, e);
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) + Math.floor(Math.random() * 100);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

/** Reject with a typed TIMEOUT error if the operation exceeds `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new SpliceError({
        code: 'TIMEOUT',
        message: `Operation "${label}" exceeded its ${ms}ms deadline and was aborted.`,
        recoverable: true,
        suggestedNextTool: 'diagnose_agent_state',
      }));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const REDACT_KEYS = /pass(word)?|secret|token|api[-_]?key|auth|credential|cookie|webhook/i;
const SECRET_VALUE_RX = /(AKIA[0-9A-Z]{16}|sk_(live|test)_[a-zA-Z0-9]{20,}|eyJ[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+)/g;

/** Redact secret-looking keys and values before persisting tool arguments. */
export function redactArguments(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (typeof value === 'string') return value.replace(SECRET_VALUE_RX, '[REDACTED]');
  if (Array.isArray(value)) return value.map((v) => redactArguments(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT_KEYS.test(k) ? '[REDACTED]' : redactArguments(v, depth + 1);
    }
    return out;
  }
  return value;
}
