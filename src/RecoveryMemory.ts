/**
 * Splice Recovery Memory
 *
 * Lightweight local learning loop: when a verified action successfully
 * recovers a non-ready browser state, the (domain, state) → action pattern
 * is persisted to .splice/recovery-memory.json. Future diagnoses on the
 * same domain surface the learned strategy via recommendedRecoveryStrategy,
 * so agents stop rediscovering the same fixes on every run.
 *
 * Telemetry is strictly opt-in: only if SPLICE_TELEMETRY_URL is set does
 * Splice POST an anonymized pattern (hashed domain, state, action kind —
 * never URLs, selectors, text, or values). Fire-and-forget, never blocking.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { errorMessage } from './Resilience.js';

export interface RecoveryPattern {
  domain: string;
  state: string;
  /** The natural-language intent that recovered this state. */
  intent: string;
  /** The low-level action kind that was executed (click/type/...). */
  action: string;
  /** Label of the element that was acted on, for human readability. */
  targetLabel?: string;
  successCount: number;
  lastSuccessAt: number;
}

const MAX_PATTERNS = 500;

/**
 * Time decay: a pattern's rank halves every HALF_LIFE_DAYS without a fresh
 * success, so a fix that worked five times last quarter eventually loses to
 * one that worked once yesterday. Patterns decayed below MIN_SCORE are no
 * longer surfaced (the site has likely changed since they were learned).
 */
const HALF_LIFE_DAYS = 14;
const MIN_SCORE = 0.25;

function decayedScore(pattern: RecoveryPattern, now: number): number {
  const ageDays = Math.max(0, now - pattern.lastSuccessAt) / 86_400_000;
  return pattern.successCount * Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

export class RecoveryMemory {
  private patterns: RecoveryPattern[] = [];
  private readonly memoryPath: string;

  constructor(spliceDir: string) {
    this.memoryPath = path.join(spliceDir, 'recovery-memory.json');
    try {
      if (fs.existsSync(this.memoryPath)) {
        const parsed = JSON.parse(fs.readFileSync(this.memoryPath, 'utf8'));
        if (Array.isArray(parsed)) this.patterns = parsed;
      }
    } catch (e) {
      console.error(`[RecoveryMemory] Could not load memory: ${errorMessage(e)}. Starting fresh.`);
      this.patterns = [];
    }
  }

  /** Record that `intent`/`action` successfully recovered `state` on `domain`. */
  recordSuccess(domain: string, state: string, intent: string, action: string, targetLabel?: string): void {
    if (!domain || !state || state === 'ready') return;
    const existing = this.patterns.find(
      (p) => p.domain === domain && p.state === state && p.action === action && p.intent === intent
    );
    if (existing) {
      existing.successCount++;
      existing.lastSuccessAt = Date.now();
      if (targetLabel) existing.targetLabel = targetLabel;
    } else {
      this.patterns.push({
        domain,
        state,
        intent: intent.slice(0, 120),
        action,
        targetLabel: targetLabel?.slice(0, 80),
        successCount: 1,
        lastSuccessAt: Date.now(),
      });
      if (this.patterns.length > MAX_PATTERNS) {
        // Evict the pattern with the lowest time-decayed score.
        const now = Date.now();
        this.patterns.sort((a, b) => decayedScore(b, now) - decayedScore(a, now));
        this.patterns.length = MAX_PATTERNS;
      }
    }
    this.persist();
    this.emitTelemetry(domain, state, action);
  }

  /**
   * Learned patterns for (domain, state), ranked by time-decayed proof:
   * recent successes outrank old ones, and patterns that have fully decayed
   * are withheld rather than recommending a fix the site may have outgrown.
   */
  lookup(domain: string, state: string, now: number = Date.now()): RecoveryPattern[] {
    return this.patterns
      .filter((p) => p.domain === domain && p.state === state && decayedScore(p, now) >= MIN_SCORE)
      .sort((a, b) => decayedScore(b, now) - decayedScore(a, now) || b.lastSuccessAt - a.lastSuccessAt)
      .slice(0, 3);
  }

  getStats() {
    return { totalPatterns: this.patterns.length, memoryPath: this.memoryPath };
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.memoryPath, JSON.stringify(this.patterns, null, 2), { mode: 0o600 });
    } catch (e) {
      console.error(`[RecoveryMemory] Persist failed: ${errorMessage(e)}`);
    }
  }

  /** Opt-in, anonymized, fire-and-forget. Never sends raw domains or page content. */
  private emitTelemetry(domain: string, state: string, action: string): void {
    const endpoint = process.env.SPLICE_TELEMETRY_URL;
    if (!endpoint) return;
    const payload = {
      domainHash: createHash('sha256').update(domain).digest('hex').slice(0, 12),
      state,
      action,
      timestamp: Date.now(),
    };
    fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => { /* telemetry must never affect the agent loop */ });
  }
}
