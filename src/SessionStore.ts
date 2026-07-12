/**
 * SessionStore — the on-disk registry of isolated browser identities.
 *
 * A "session" is a named, persistent browser identity: one account. Each
 * session owns an isolated BrowserContext (cookies + storage are already
 * partitioned per Playwright context), a DETERMINISTIC fingerprint derived
 * from its seed (so the same account presents the same UA/platform/WebGL/
 * timezone across restarts and a DIFFERENT one from every other account), and
 * an optional encrypted storage-state file so logins survive process restarts.
 *
 * This store owns only the durable metadata and the paths. The live browser
 * context and the encrypted state I/O live in BrowserManager, which has the
 * vault and the Playwright handles. Keeping the registry as plain JSON (no
 * secrets — the seed is not sensitive) means the CLI can create, list, and
 * remove account identities WITHOUT launching a browser.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface SessionRecord {
  /** Stable, filesystem-safe identity name (the "account" handle). */
  name: string;
  /** Optional human label, e.g. "acme-admin". */
  label?: string;
  /**
   * Fingerprint seed. The same seed always resolves to the same coherent
   * identity via StealthProfile.resolveFingerprint. Defaults to the name so a
   * caller only has to pick a name; override to decouple identity from name.
   */
  seed: string;
  createdAt: number;
  lastUsedAt: number;
  /** When true, storage state is persisted to disk on save/close. */
  persistent: boolean;
}

/** The branch-id namespace under which sessions live in BrowserManager. */
export const SESSION_BRANCH_PREFIX = 'session:';

export function sessionBranchId(name: string): string {
  return `${SESSION_BRANCH_PREFIX}${name}`;
}

export function isSessionBranch(branchId: string): boolean {
  return branchId.startsWith(SESSION_BRANCH_PREFIX);
}

export function sessionNameFromBranch(branchId: string): string {
  return branchId.slice(SESSION_BRANCH_PREFIX.length);
}

/** Session names double as branch ids and file names — keep them tight. */
export function sanitizeSessionName(name: string): string {
  const cleaned = String(name ?? '').trim().toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (!cleaned) {
    throw new Error('A session name must contain at least one alphanumeric character.');
  }
  return cleaned.slice(0, 60);
}

export class SessionStore {
  private dir: string;
  private registryPath: string;

  constructor(spliceDir: string) {
    this.dir = path.join(spliceDir, 'sessions');
    this.registryPath = path.join(this.dir, 'registry.json');
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Absolute path to a session's encrypted storage-state file. */
  statePath(name: string): string {
    return path.join(this.dir, `${sanitizeSessionName(name)}.session`);
  }

  hasState(name: string): boolean {
    return fs.existsSync(this.statePath(name));
  }

  private readRegistry(): Record<string, SessionRecord> {
    try {
      const raw = fs.readFileSync(this.registryPath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private writeRegistry(records: Record<string, SessionRecord>): void {
    fs.writeFileSync(this.registryPath, JSON.stringify(records, null, 2));
  }

  list(): SessionRecord[] {
    return Object.values(this.readRegistry()).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  get(name: string): SessionRecord | undefined {
    return this.readRegistry()[sanitizeSessionName(name)];
  }

  /**
   * Create or update an identity. Preserves createdAt on an existing record.
   * Returns the persisted record.
   */
  upsert(input: { name: string; label?: string; seed?: string; persistent?: boolean }): SessionRecord {
    const name = sanitizeSessionName(input.name);
    const records = this.readRegistry();
    const existing = records[name];
    const now = Date.now();
    const record: SessionRecord = {
      name,
      label: input.label ?? existing?.label,
      seed: input.seed ?? existing?.seed ?? name,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
      persistent: input.persistent ?? existing?.persistent ?? true,
    };
    records[name] = record;
    this.writeRegistry(records);
    return record;
  }

  /** Update lastUsedAt without touching the rest of the record. */
  touch(name: string): void {
    const key = sanitizeSessionName(name);
    const records = this.readRegistry();
    if (records[key]) {
      records[key].lastUsedAt = Date.now();
      this.writeRegistry(records);
    }
  }

  /**
   * Remove an identity from the registry. When purge is true, the encrypted
   * storage-state file is deleted too (the account's saved login is destroyed).
   * Returns whether a record existed.
   */
  remove(name: string, opts: { purge?: boolean } = {}): boolean {
    const key = sanitizeSessionName(name);
    const records = this.readRegistry();
    const existed = key in records;
    delete records[key];
    this.writeRegistry(records);
    if (opts.purge) {
      try { fs.rmSync(this.statePath(key), { force: true }); } catch { /* best effort */ }
    }
    return existed;
  }
}
