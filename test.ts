import { BrowserManager } from "./src/BrowserManager.js";

async function main() {
  const browser = new BrowserManager();
  console.log("Initializing browser...");
  await browser.init();

  console.log("Navigating to example.com...");
  await browser.navigate("https://example.com");

  console.log("Extracting OPTIMIZED semantic tree (Intent: 'domain information')...");
  const tree = await browser.getSemanticTree("domain information");
  console.log(JSON.stringify(tree, null, 2));

  console.log("Getting telemetry logs...");
  const logs = browser.getTelemetryLogs();
  console.log(`Logs found: ${logs.length}`);

  console.log(`Metrics: ${JSON.stringify(browser.metrics)}`);

  console.log("Testing branching...");
  const branchId = await browser.forkState();
  console.log(`Created branch: ${branchId}`);
  await browser.commitBranch(branchId);
  console.log(`Committed branch: ${branchId}`);

  console.log("Testing snapshot save...");
  const snapshotPath = await browser.saveSnapshot("test-snapshot");
  console.log(`Saved snapshot to ${snapshotPath}`);

  console.log("Closing browser...");
  await browser.close();
}

main().catch(console.error);
