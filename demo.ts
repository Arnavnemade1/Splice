import { BrowserManager } from "./src/BrowserManager.js";
import fs from "node:fs";

async function demo() {
  const browser = new BrowserManager();
  console.log("\n═══════════════════════════════════════════");
  console.log("   SPLICE V5 — AGENTIC SECURITY FIREWALL");
  console.log("═══════════════════════════════════════════\n");
  
  await browser.init();

  console.log("📺 WATCH MODE: ENABLED (Visible Browser)");
  await browser.toggleWatchMode(true);

  console.log("⚡ PERFORMANCE: Resource Blocking ENABLED (Ads/Media filtered)");
  await browser.toggleResourceBlocking(true);

  const target = "https://example.com";
  console.log(`🌐 NAVIGATING: ${target}`);
  await browser.navigate(target);

  // SIMULATE DEEP BEHAVIORAL DATA
  console.log("🧠 SIMULATING DEEP TELEMETRY: Scroll depth, form abandonment, and errors...");
  const telemetry = (browser as any).telemetry.get((browser as any).activeBranch);
  
  // 1. Simulate scroll depth (75%)
  telemetry.addLog({ type: 'behavior', timestamp: Date.now(), data: { event: 'scroll_depth', depth: 25 } });
  telemetry.addLog({ type: 'behavior', timestamp: Date.now(), data: { event: 'scroll_depth', depth: 50 } });
  telemetry.addLog({ type: 'behavior', timestamp: Date.now(), data: { event: 'scroll_depth', depth: 75 } });

  // 2. Simulate Form Abandonment
  telemetry.addLog({ 
    type: 'behavior', 
    timestamp: Date.now(), 
    data: { elementId: 'input-email', event: 'form_abandoned', tag: 'INPUT' } 
  });

  // 3. Simulate JS Error
  telemetry.addLog({ 
    type: 'behavior', 
    timestamp: Date.now(), 
    data: { event: 'js_error', message: 'Uncaught TypeError: Cannot read property "submit" of undefined', filename: 'app.js' } 
  });

  // 4. Simulate rage clicks on the "More information" link
  for (let i = 0; i < 5; i++) {
    telemetry.addLog({
      type: 'behavior',
      timestamp: Date.now(),
      data: { elementId: 'a-1', event: 'rage_click', text: 'More information...' }
    });
  }

  // SIMULATE AGENTIC SECURITY EVENTS
  console.log("🛡️ SIMULATING V5 SECURITY: Prompt Injection & Exfiltration Firewall...");
  
  // Simulate Exfiltration attempt
  (browser as any).pushLiveFeed('security_firewall', 'Blocked secret leak to malicious-domain.com');
  
  console.log("🕷️ EXTRACTING: Applying V5 Semantic tree with Prompt Injection scanning...");
  const tree = await browser.getSemanticTree("Optimize user flow", "Behavior");

  // Force a prompt injection flag for demo purposes
  if (tree.children && tree.children[0]) {
    tree.children[0].securityFlags = ['prompt-injection-detected'];
    tree.children[0].text = "[REDACTED: POTENTIAL PROMPT INJECTION]";
  }

  console.log("🛡️ AUDITING: Running Deep Security, ACE, & Behavioral Audit...");
  const reportPath = await browser.generateObservabilityReport();
  
  console.log("\n📊 V5 COMMAND CENTER READY:");
  console.log(`--------------------------------------------------`);
  console.log(`URL: ${reportPath}`);
  console.log(`--------------------------------------------------`);

  console.log("\n✨ Splice V5 Agentic Security is active.");
  console.log("- Check the 'Agentic Security (V5)' panel for Prompt Injections & Exfiltration logs.");
  console.log("- Run the 'scan_local_secrets' MCP tool to check for exposed API keys.");
  console.log("- Session remains active for 60s for your review.");
  
  await new Promise(r => setTimeout(r, 60000));
  await browser.close();
}

demo().catch(console.error);
