/**
 * Splice Run Journal
 *
 * Append-only JSONL record of every tool invocation in a session:
 * what was called, with which (redacted) arguments, what happened,
 * and how long it took. This is the reproducibility backbone for
 * long autonomous runs — after a crash or a surprising outcome, the
 * journal replays exactly what the agent did and in what order.
 *
 * The journal is written synchronously with O_APPEND semantics so a
 * process crash never loses acknowledged entries, and it survives
 * restarts (one file per server process).
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactArguments, errorMessage } from './Resilience.js';

export interface JournalEntry {
  seq: number;
  sessionId: string;
  timestamp: number;
  kind: 'tool_call' | 'lifecycle' | 'crash' | 'recovery';
  tool?: string;
  arguments?: unknown;
  outcome: 'ok' | 'error' | 'info';
  durationMs?: number;
  errorCode?: string;
  detail?: string;
}

export interface JournalStats {
  sessionId: string;
  journalPath: string;
  startedAt: number;
  totalEntries: number;
  toolCalls: number;
  errors: number;
  crashes: number;
  recoveries: number;
  lastError?: { tool?: string; errorCode?: string; detail?: string; timestamp: number };
}

export class RunJournal {
  public readonly sessionId: string;
  public readonly journalPath: string;
  private readonly startedAt = Date.now();
  private seq = 0;
  private stats = { toolCalls: 0, errors: 0, crashes: 0, recoveries: 0 };
  private lastError?: JournalStats['lastError'];
  private fd: number | null = null;

  constructor(spliceDir: string) {
    this.sessionId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const journalDir = path.join(spliceDir, 'journal');
    fs.mkdirSync(journalDir, { recursive: true });
    this.journalPath = path.join(journalDir, `${this.sessionId}.jsonl`);
    try {
      this.fd = fs.openSync(this.journalPath, 'a', 0o600);
    } catch (e) {
      console.error(`[RunJournal] Could not open journal file: ${errorMessage(e)}. Journaling disabled.`);
      this.fd = null;
    }
    this.record({ kind: 'lifecycle', outcome: 'info', detail: 'session_started' });
  }

  record(entry: Omit<JournalEntry, 'seq' | 'sessionId' | 'timestamp'>): void {
    const full: JournalEntry = {
      seq: ++this.seq,
      sessionId: this.sessionId,
      timestamp: Date.now(),
      ...entry,
      arguments: entry.arguments === undefined ? undefined : redactArguments(entry.arguments),
    };
    if (full.kind === 'tool_call') this.stats.toolCalls++;
    if (full.kind === 'crash') this.stats.crashes++;
    if (full.kind === 'recovery') this.stats.recoveries++;
    if (full.outcome === 'error') {
      this.stats.errors++;
      this.lastError = {
        tool: full.tool,
        errorCode: full.errorCode,
        detail: full.detail?.slice(0, 300),
        timestamp: full.timestamp,
      };
    }
    if (this.fd === null) return;
    try {
      fs.writeSync(this.fd, JSON.stringify(full) + '\n');
    } catch (e) {
      // Never let journaling failures break the agent loop.
      console.error(`[RunJournal] write failed: ${errorMessage(e)}`);
    }
  }

  getStats(): JournalStats {
    return {
      sessionId: this.sessionId,
      journalPath: this.journalPath,
      startedAt: this.startedAt,
      totalEntries: this.seq,
      ...this.stats,
      lastError: this.lastError,
    };
  }

  /** Read back the most recent entries for export/replay. */
  tail(limit = 100): JournalEntry[] {
    try {
      const lines = fs.readFileSync(this.journalPath, 'utf8').trimEnd().split('\n');
      return lines.slice(-limit).map((line) => JSON.parse(line) as JournalEntry);
    } catch {
      return [];
    }
  }

  close(): void {
    this.record({ kind: 'lifecycle', outcome: 'info', detail: 'session_closed' });
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch { /* already closed */ }
      this.fd = null;
    }
  }
}
