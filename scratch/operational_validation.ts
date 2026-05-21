import { BrowserManager } from "../dist/BrowserManager.js";
import fs from "node:fs";
import path from "node:path";

async function runOperationalValidation() {
  const browser = new BrowserManager();
  console.log("\n═══════════════════════════════════════════");
  console.log("   SPLICE OPERATIONAL VALIDATION (V2.0.0)");
  console.log("═══════════════════════════════════════════\n");
  
  await browser.init();

  // 1. Navigation & Diagnosis
  console.log("🌐 Navigating to GitHub...");
  await browser.navigate("https://github.com");
  
  console.log("🔍 Diagnosing page state...");
  const diagnosis = await browser.diagnoseAgentState("Understand the landing page");
  console.log(`   State: ${diagnosis.state} (Confidence: ${Math.round(diagnosis.confidence * 100)}%)`);

  // 2. Intent Compilation
  console.log("🧠 Compiling verified action for 'Search GitHub'...");
  const plan = await browser.compileVerifiedAction({
    intent: "click the search button",
    execute: false
  });
  console.log(`   Best target: ${plan.plan[0]?.target || 'none'} (Confidence: ${Math.round(plan.confidence * 100)}%)`);

  // 3. Multi-Agent Coordination
  console.log("👥 Registering agents...");
  browser.coordinator.registerAgent("explorer-1", "explorer");
  browser.coordinator.registerAgent("verifier-1", "verifier");
  browser.coordinator.acquireOwnership("main", "explorer-1");

  console.log("🌿 Forking branch for verifier...");
  const branchId = await browser.forkState("verifier-1");
  console.log(`   Branch ${branchId} created and owned by verifier-1.`);

  // 4. Promoting Findings
  console.log("📝 Promoting findings to ledger...");
  browser.promoteFinding("page.is_landing", true, 1.0, "main", "explorer-1");
  browser.promoteFinding("page.has_search", true, 0.9, branchId, "verifier-1");

  // 5. Simulation of "Coordination Tax" (violations)
  console.log("⚠️ Simulating ownership violation...");
  browser.activeBranch = branchId; // branchId is owned by verifier-1
  try {
    // explorer-1 tries to interact with verifier's branch
    await browser.interact("button-search", "click", undefined, "explorer-1");
  } catch (e: any) {
    console.log(`   Expected violation caught: ${e.message}`);
  }
  browser.activeBranch = "main"; // Switch back

  // 6. Report Generation
  console.log("📊 Generating final Command Center report...");
  const reportPath = await browser.generateObservabilityReport();
  
  console.log("\n✅ VALIDATION COMPLETE:");
  console.log(`--------------------------------------------------`);
  console.log(`REPORT URL: file://${reportPath}`);
  console.log(`--------------------------------------------------`);

  // Keep alive for a few seconds so the user can see it's done
  await new Promise(r => setTimeout(r, 5000));
  await browser.close();
  
  // Print for the agent to find
  console.log(`FINAL_REPORT_PATH=${reportPath}`);
}

runOperationalValidation().catch(console.error);
