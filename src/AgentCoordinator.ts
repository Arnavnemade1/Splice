import { createHash } from 'node:crypto';
import type {
  AgentRegistration,
  AgentRole,
  BranchStatus,
  CanonicalContext,
  CoordinationTaxMetrics,
  LedgerEntry,
} from './types.js';

/** Minimum confidence score for a finding to be included in the CCS. */
const QUORUM_CONFIDENCE_THRESHOLD = 0.7;

/**
 * AgentCoordinator — the single mediator for multi-agent collaboration.
 *
 * Design rules:
 *   - Agents never message each other. They pull state from this class.
 *   - Branch ownership is exclusive: at most one agent writes per branch.
 *   - The Ledger is append-only. Conflicting findings surface as quorum failures
 *     rather than silently overwriting each other.
 *   - The Canonical Context Snapshot (CCS) is built lazily on request, never pushed.
 */
export class AgentCoordinator {
  // ── Agent Registry ──────────────────────────────────────────────────────
  private agents: Map<string, AgentRegistration> = new Map();

  // ── Branch Ownership Locks ───────────────────────────────────────────────
  /** branchId → ownerAgentId */
  private ownership: Map<string, string> = new Map();

  // ── Immutable Evidence Ledger ────────────────────────────────────────────
  private ledger: LedgerEntry[] = [];
  /** key → array of ledger entry IDs posted under that key */
  private ledgerIndex: Map<string, string[]> = new Map();
  /** Monotonically increasing snapshot counter */
  private snapshotCounter: number = 0;

  // ── Coordination Tax Metrics ─────────────────────────────────────────────
  private taxMetrics: CoordinationTaxMetrics = {
    conflictsDetected: 0,
    conflictsResolved: 0,
    blockedActions: 0,
    ownershipViolationAttempts: 0,
    forcedReleases: 0,
  };

  // ── Blocked Action Log ───────────────────────────────────────────────────
  private blockedActionLog: string[] = [];

  // ── BranchStatus Mirror (fed by BrowserManager) ─────────────────────────
  private branchStatuses: Map<string, BranchStatus> = new Map();

  // ────────────────────────────────────────────────────────────────────────
  // Agent Registry
  // ────────────────────────────────────────────────────────────────────────

  registerAgent(agentId: string, role: AgentRole): AgentRegistration {
    if (this.agents.has(agentId)) {
      // Update last active timestamp on re-registration
      const existing = this.agents.get(agentId)!;
      existing.lastActiveAt = Date.now();
      return existing;
    }
    const reg: AgentRegistration = {
      agentId,
      role,
      registeredAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    this.agents.set(agentId, reg);
    return reg;
  }

  touchAgent(agentId: string) {
    const reg = this.agents.get(agentId);
    if (reg) reg.lastActiveAt = Date.now();
  }

  getRegisteredAgents(): AgentRegistration[] {
    return Array.from(this.agents.values());
  }

  // ────────────────────────────────────────────────────────────────────────
  // Branch Ownership Locks
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Attempt to acquire exclusive write ownership of a branch.
   * Returns true on success; false if another agent already holds it.
   */
  acquireOwnership(branchId: string, agentId: string): boolean {
    const current = this.ownership.get(branchId);
    if (current && current !== agentId) {
      this.taxMetrics.ownershipViolationAttempts++;
      return false;
    }
    this.ownership.set(branchId, agentId);
    this.touchAgent(agentId);
    return true;
  }

  /**
   * Release ownership of a branch. Must be called by the current owner.
   * Returns false if the caller does not own the branch.
   */
  releaseOwnership(branchId: string, agentId: string): boolean {
    if (this.ownership.get(branchId) !== agentId) return false;
    this.ownership.delete(branchId);
    return true;
  }

  /**
   * Emergency override. Always logs to the coordination tax metrics.
   * Used when an agent crashes or becomes unresponsive.
   */
  forceRelease(branchId: string, reason: string): void {
    this.ownership.delete(branchId);
    this.taxMetrics.forcedReleases++;
    console.error(`[AgentCoordinator] Force-released branch ${branchId}: ${reason}`);
  }

  /**
   * Verify that a given agent owns a branch before allowing a write action.
   * Throws with a diagnostic message on failure so errors are explicit and local.
   */
  verifyOwnership(branchId: string, agentId: string | undefined): void {
    if (!agentId) return; // anonymous agents bypass ownership checks for backward compat
    const owner = this.ownership.get(branchId);
    if (!owner) return; // unowned branch — first write implicitly acquires
    if (owner !== agentId) {
      this.taxMetrics.ownershipViolationAttempts++;
      throw new Error(
        `[Coordination] Agent "${agentId}" attempted to write to branch "${branchId}" ` +
        `which is owned by "${owner}". Call acquire_branch_ownership first, or ` +
        `use handoff_branch to transfer ownership.`
      );
    }
    this.touchAgent(agentId);
  }

  /**
   * Atomically transfer ownership from one agent to another.
   * Writes a ledger entry recording the transfer for auditability.
   */
  handoffBranch(branchId: string, fromAgentId: string, toAgentId: string): void {
    if (this.ownership.get(branchId) !== fromAgentId) {
      throw new Error(
        `[Coordination] Handoff rejected: agent "${fromAgentId}" does not own branch "${branchId}".`
      );
    }
    this.ownership.set(branchId, toAgentId);
    // Record the handoff as a ledger entry for auditability
    this.appendToLedger({
      key: `_handoff.${branchId}`,
      value: { from: fromAgentId, to: toAgentId },
      confidence: 1.0,
      agentId: fromAgentId,
      branchId,
      causalSnapshot: String(this.snapshotCounter),
    });
    this.touchAgent(fromAgentId);
    this.touchAgent(toAgentId);
  }

  getOwner(branchId: string): string | undefined {
    return this.ownership.get(branchId);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Branch Status Mirror (kept in sync by BrowserManager)
  // ────────────────────────────────────────────────────────────────────────

  updateBranchStatus(branchId: string, url: string) {
    this.branchStatuses.set(branchId, {
      branchId,
      ownerAgentId: this.ownership.get(branchId) ?? null,
      currentUrl: url,
      lastActionAt: Date.now(),
    });
  }

  removeBranchStatus(branchId: string) {
    this.branchStatuses.delete(branchId);
    this.ownership.delete(branchId);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Immutable Evidence Ledger
  // ────────────────────────────────────────────────────────────────────────

  private computeEntryId(
    previousId: string,
    key: string,
    value: unknown,
    agentId: string
  ): string {
    const payload = `${previousId}:${key}:${JSON.stringify(value)}:${agentId}`;
    return createHash('sha256').update(payload).digest('hex').slice(0, 24);
  }

  private appendToLedger(params: Omit<LedgerEntry, 'id' | 'timestamp'>): LedgerEntry {
    const previousId = this.ledger.at(-1)?.id ?? 'genesis';
    const id = this.computeEntryId(previousId, params.key, params.value, params.agentId);
    const entry: LedgerEntry = { id, timestamp: Date.now(), ...params };
    this.ledger.push(entry);
    const existing = this.ledgerIndex.get(params.key) ?? [];
    existing.push(id);
    this.ledgerIndex.set(params.key, existing);
    return entry;
  }

  /**
   * Promote a local finding to the shared ledger.
   * If a conflicting entry already exists on the same key, the conflict is
   * recorded and the CCS systemState becomes 'quorum_blocked' for that key.
   * Agents on unowned branches cannot promote findings.
   */
  promoteFinding(
    key: string,
    value: unknown,
    confidence: number,
    branchId: string,
    agentId: string,
    causalSnapshot: string
  ): LedgerEntry {
    if (confidence < 0 || confidence > 1) {
      throw new Error(`[Coordination] Confidence must be between 0 and 1, got ${confidence}.`);
    }

    // Ensure the agent owns the branch they're promoting from
    const owner = this.ownership.get(branchId);
    if (owner && owner !== agentId) {
      this.taxMetrics.ownershipViolationAttempts++;
      throw new Error(
        `[Coordination] Agent "${agentId}" cannot promote a finding from branch "${branchId}" — not the owner.`
      );
    }

    const entry = this.appendToLedger({ key, value, confidence, agentId, branchId, causalSnapshot });

    // Conflict detection: if another non-superseded entry on this key exists with different value
    const siblingIds = (this.ledgerIndex.get(key) ?? []).filter(id => id !== entry.id);
    const siblings = siblingIds
      .map(id => this.ledger.find(e => e.id === id))
      .filter((e): e is LedgerEntry => !!e && !e.supersededBy);

    for (const sibling of siblings) {
      if (JSON.stringify(sibling.value) !== JSON.stringify(value)) {
        this.taxMetrics.conflictsDetected++;
        console.error(
          `[AgentCoordinator] CONFLICT on key "${key}": ` +
          `agent "${agentId}" (conf=${confidence}) vs agent "${sibling.agentId}" (conf=${sibling.confidence}). ` +
          `Call resolve_conflict to unblock.`
        );
      }
    }

    this.touchAgent(agentId);
    return entry;
  }

  /**
   * Resolve a conflict on a key by choosing the entry with the highest confidence
   * (breaking ties by recency). Marks losing entries as superseded.
   * Returns the winning entry.
   */
  resolveConflict(key: string): LedgerEntry | null {
    const entryIds = this.ledgerIndex.get(key) ?? [];
    const candidates = entryIds
      .map(id => this.ledger.find(e => e.id === id))
      .filter((e): e is LedgerEntry => !!e && !e.supersededBy);

    if (candidates.length <= 1) return candidates[0] ?? null;

    // Sort: highest confidence first, then most recent
    candidates.sort((a, b) =>
      b.confidence - a.confidence || b.timestamp - a.timestamp
    );

    const winner = candidates[0];
    for (const loser of candidates.slice(1)) {
      loser.supersededBy = winner.id;
    }

    this.taxMetrics.conflictsResolved++;
    console.error(
      `[AgentCoordinator] Conflict resolved for key "${key}": ` +
      `winner is agent "${winner.agentId}" (id=${winner.id}, conf=${winner.confidence}).`
    );
    return winner;
  }

  /**
   * Check whether a high-confidence consensus exists for a key.
   * Used by BrowserManager before executing high-risk actions.
   * Returns false (blocked) if there's an unresolved conflict.
   */
  checkQuorum(key: string, blockedActionDescription: string): boolean {
    const entryIds = this.ledgerIndex.get(key) ?? [];
    const active = entryIds
      .map(id => this.ledger.find(e => e.id === id))
      .filter((e): e is LedgerEntry => !!e && !e.supersededBy);

    // Multiple conflicting active entries = quorum failure
    const uniqueValues = new Set(active.map(e => JSON.stringify(e.value)));
    if (uniqueValues.size > 1) {
      this.taxMetrics.blockedActions++;
      this.blockedActionLog.unshift(blockedActionDescription);
      if (this.blockedActionLog.length > 20) this.blockedActionLog.pop();
      return false;
    }

    // Single entry below confidence threshold = also blocked
    if (active.length === 1 && active[0].confidence < QUORUM_CONFIDENCE_THRESHOLD) {
      this.taxMetrics.blockedActions++;
      this.blockedActionLog.unshift(blockedActionDescription);
      if (this.blockedActionLog.length > 20) this.blockedActionLog.pop();
      return false;
    }

    return true;
  }

  getLedger(): LedgerEntry[] {
    return this.ledger;
  }

  getConflictedKeys(): string[] {
    const conflicted: string[] = [];
    for (const [key, ids] of this.ledgerIndex.entries()) {
      const active = ids
        .map(id => this.ledger.find(e => e.id === id))
        .filter((e): e is LedgerEntry => !!e && !e.supersededBy);
      const uniqueValues = new Set(active.map(e => JSON.stringify(e.value)));
      if (uniqueValues.size > 1) conflicted.push(key);
    }
    return conflicted;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Canonical Context Snapshot (CCS) — pull-only, never pushed
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Build the CCS on demand. This is the ONLY way agents learn about each other.
   * It replaces all agent-to-agent messaging.
   */
  buildCanonicalContext(): CanonicalContext {
    this.snapshotCounter++;
    const snapshotId = String(this.snapshotCounter);

    const conflictedKeys = this.getConflictedKeys();
    const promotedFindings = this.ledger.filter(
      e => !e.supersededBy &&
           !e.key.startsWith('_') && // exclude internal entries like _handoff.*
           e.confidence >= QUORUM_CONFIDENCE_THRESHOLD &&
           !conflictedKeys.includes(e.key)
    );

    const systemState: CanonicalContext['systemState'] =
      conflictedKeys.length > 0 ? 'quorum_blocked' :
      this.taxMetrics.ownershipViolationAttempts > 0 ? 'degraded' :
      'healthy';

    return {
      snapshotId,
      generatedAt: Date.now(),
      activeBranches: Array.from(this.branchStatuses.values()).map(bs => ({
        ...bs,
        ownerAgentId: this.ownership.get(bs.branchId) ?? null,
      })),
      promotedFindings,
      systemState,
      blockedKeys: conflictedKeys,
      blockedActions: this.blockedActionLog.slice(0, 10),
      registeredAgents: Array.from(this.agents.values()),
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Coordination Tax Metrics
  // ────────────────────────────────────────────────────────────────────────

  getCoordinationTaxMetrics(): CoordinationTaxMetrics {
    return { ...this.taxMetrics };
  }
}
