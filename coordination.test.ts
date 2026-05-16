#!/usr/bin/env node
/**
 * Splice Multi-Agent Coordination Test Suite
 * Verifies that the coordination tax is not introduced and isolation is maintained.
 */
import { BrowserManager } from "./dist/BrowserManager.js";
import fs from "node:fs";
import path from "node:path";

const RESULTS: Array<{ name: string; status: "PASS" | "FAIL" | "WARN"; detail: string }> = [];

function pass(name: string, detail = "") {
  console.log(`  ✓ PASS  ${name}${detail ? " — " + detail : ""}`);
  RESULTS.push({ name, status: "PASS", detail });
}

function fail(name: string, detail: string) {
  console.error(`  ✗ FAIL  ${name} — ${detail}`);
  RESULTS.push({ name, status: "FAIL", detail });
}

async function run(name: string, fn: () => Promise<void>) {
  process.stdout.write(`  Testing: ${name}... `);
  try {
    await fn();
  } catch (e: any) {
    console.log();
    fail(name, e.message);
  }
}

async function main() {
  console.log("\n═══════════════════════════════════════════");
  console.log("   SPLICE MULTI-AGENT COORDINATION TEST");
  console.log("═══════════════════════════════════════════\n");

  const browser = new BrowserManager();
  const coordinator = browser.coordinator;

  await run("Initialization", async () => {
    await browser.init();
    pass("Initialization", "Browser & Coordinator ready");
  });

  // ─────────────────────────────────────────────
  console.log("\n▶ PHASE 1: Registration & CCS");
  // ─────────────────────────────────────────────

  await run("Agent Registration", async () => {
    const agent1 = coordinator.registerAgent("explorer-1", "explorer");
    const agent2 = coordinator.registerAgent("verifier-1", "verifier");
    if (agent1.agentId !== "explorer-1" || agent1.role !== "explorer") throw new Error("Agent 1 registration failed");
    if (agent2.agentId !== "verifier-1" || agent2.role !== "verifier") throw new Error("Agent 2 registration failed");
    pass("Agent Registration", "2 agents registered with distinct roles");
  });

  await run("Canonical Context Snapshot (Empty)", async () => {
    const ccs = coordinator.buildCanonicalContext();
    if (ccs.registeredAgents.length !== 2) throw new Error(`Expected 2 agents, got ${ccs.registeredAgents.length}`);
    if (ccs.systemState !== 'healthy') throw new Error(`Expected healthy state, got ${ccs.systemState}`);
    pass("Canonical Context Snapshot (Empty)", `ID: ${ccs.snapshotId}`);
  });

  // ─────────────────────────────────────────────
  console.log("\n▶ PHASE 2: Branch Ownership & Isolation");
  // ─────────────────────────────────────────────

  await run("Exclusive Ownership Lock", async () => {
    // Acquire ownership of main for explorer-1 to test isolation on main
    coordinator.acquireOwnership("main", "explorer-1");
    
    const branchId = await browser.forkState("explorer-1");
    // Verify explorer-1 owns it
    if (coordinator.getOwner(branchId) !== "explorer-1") throw new Error("Ownership not recorded on fork");

    // Attempt to acquire by another agent should fail
    const acquired = coordinator.acquireOwnership(branchId, "verifier-1");
    if (acquired) throw new Error("Verifier-1 illegally acquired explorer-1's branch");
    
    pass("Exclusive Ownership Lock", `Branch ${branchId} locked to explorer-1`);
  });

  await run("Write Isolation Rejection", async () => {
    // verifier-1 tries to interact with 'main' which is owned by 'explorer-1'
    try {
      await browser.interact("dummy-id", "click", undefined, "verifier-1");
      throw new Error("Interaction should have been rejected for verifier-1 on owned branch 'main'");
    } catch (e: any) {
      if (!e.message.includes("owned by")) throw e;
      pass("Write Isolation Rejection", "verifier-1 blocked from writing to foreign branch 'main'");
    }
  });

  // ─────────────────────────────────────────────
  console.log("\n▶ PHASE 3: Ledger & Conflict Detection");
  // ─────────────────────────────────────────────

  await run("Promote Finding (Explorer)", async () => {
    // Promote from main (owned by explorer-1)
    const entry = browser.promoteFinding("auth.status", { loggedIn: true }, 0.9, "main", "explorer-1");
    if (entry.key !== "auth.status") throw new Error("Key mismatch in ledger");
    pass("Promote Finding (Explorer)", `Key: ${entry.key}, ID: ${entry.id}`);
  });

  await run("Conflict Detection (Contradictory Finding)", async () => {
    // Create another branch for verifier-1
    const branchId2 = await browser.forkState("verifier-1");
    
    // Verifier promotes a conflicting finding from its own branch
    browser.promoteFinding("auth.status", { loggedIn: false }, 0.8, branchId2, "verifier-1");
    
    const ccs = coordinator.buildCanonicalContext();
    if (ccs.systemState !== 'quorum_blocked') throw new Error("System should be in quorum_blocked state");
    if (!ccs.blockedKeys.includes("auth.status")) throw new Error("auth.status should be blocked");
    
    pass("Conflict Detection", "Contradictory findings triggered quorum block");
  });

  await run("Conflict Resolution (Highest Confidence Wins)", async () => {
    const winner = coordinator.resolveConflict("auth.status");
    if (!winner || winner.agentId !== "explorer-1") throw new Error("Explorer-1 should have won (0.9 vs 0.8)");
    
    const ccs = coordinator.buildCanonicalContext();
    if (ccs.systemState === 'quorum_blocked' && ccs.blockedKeys.includes("auth.status")) {
      throw new Error("Conflict still active after resolution");
    }
    pass("Conflict Resolution", `Winner: explorer-1 (conf=0.9)`);
  });

  // ─────────────────────────────────────────────
  console.log("\n▶ PHASE 4: Handoff & Error Containment");
  // ─────────────────────────────────────────────

  await run("Atomic Branch Handoff", async () => {
    // explorer-1 hands off 'main' to verifier-1
    browser.handoffBranch("main", "explorer-1", "verifier-1");
    
    if (coordinator.getOwner("main") !== "verifier-1") throw new Error("Handoff failed to update owner");
    
    // verifier-1 can now write to 'main'
    await browser.commitBranch("main");
    await browser.navigate("https://example.com"); 
    
    pass("Atomic Branch Handoff", "Ownership transferred explorer-1 -> verifier-1 on 'main'");
  });

  await run("Coordination Tax Measurement", async () => {
    const metrics = coordinator.getCoordinationTaxMetrics();
    if (metrics.conflictsDetected === 0) throw new Error("Metrics failed to track conflicts");
    if (metrics.ownershipViolationAttempts === 0) throw new Error("Metrics failed to track isolation violations");
    
    pass("Coordination Tax Measurement", 
      `Conflicts: ${metrics.conflictsDetected}, Violations: ${metrics.ownershipViolationAttempts}`
    );
  });

  // ─────────────────────────────────────────────
  await browser.close();

  const passed = RESULTS.filter(r => r.status === "PASS").length;
  const failed = RESULTS.filter(r => r.status === "FAIL").length;

  console.log("\n═══════════════════════════════════════════");
  console.log(`  RESULTS: ${passed} passed | ${failed} failed`);
  console.log("═══════════════════════════════════════════\n");

  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error("Fatal Error during test:", e); process.exit(1); });
