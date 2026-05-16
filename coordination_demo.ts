import { BrowserManager } from "./dist/BrowserManager.js";
import fs from "node:fs";

async function runCoordinationDemo() {
  const browser = new BrowserManager();
  console.log("\n═══════════════════════════════════════════");
  console.log("   SPLICE MULTI-AGENT COMMAND CENTER DEMO");
  console.log("═══════════════════════════════════════════\n");
  
  await browser.init();

  const coordinator = browser.coordinator;

  // 1. Register Agents
  console.log("👥 Registering agents...");
  coordinator.registerAgent("explorer-1", "explorer");
  coordinator.registerAgent("verifier-1", "verifier");
  coordinator.registerAgent("auditor-1", "auditor");

  // 2. Setup Branches & Findings
  console.log("🌿 Creating branches and promoting findings...");
  
  // explorer-1 owns main
  coordinator.acquireOwnership("main", "explorer-1");
  browser.promoteFinding("auth.status", { loggedIn: true, user: "admin" }, 0.95, "main", "explorer-1");
  browser.promoteFinding("site.version", "v2.4.0-stable", 1.0, "main", "explorer-1");

  // 3. Create a conflict
  const branchId = await browser.forkState("verifier-1");
  console.log(`⚠️ Simulating conflict from ${branchId}...`);
  browser.promoteFinding("auth.status", { loggedIn: false }, 0.6, branchId, "verifier-1");

  // 4. Record some "Coordination Tax" metrics
  console.log("📊 Injecting coordination tax metrics...");
  // Simulate some unauthorized attempts
  try { await browser.interact("dummy", "click", undefined, "verifier-1"); } catch(e) {}
  try { await browser.interact("dummy", "type", "secret", "auditor-1"); } catch(e) {}

  // 5. Add some security context for more "flavor"
  await browser.navigate("https://example.com");
  
  // 6. Generate the Command Center Report
  const reportPath = await browser.generateObservabilityReport();
  
  console.log("\n🚀 COMMAND CENTER READY:");
  console.log(`--------------------------------------------------`);
  console.log(`REPORT URL: file://${reportPath}`);
  console.log(`--------------------------------------------------`);

  console.log("\nOpening Command Center...");
  
  // We keep the browser open for a bit so the user can look if they want, 
  // but the report is static HTML.
  await new Promise(r => setTimeout(r, 5000));
  await browser.close();
  
  // Return the path for the browser subagent
  process.stdout.write(`REPORT_PATH=${reportPath}\n`);
}

runCoordinationDemo().catch(console.error);
