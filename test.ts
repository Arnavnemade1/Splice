import { BrowserManager } from "./src/BrowserManager.js";
import fs from 'node:fs';

async function main() {
  const browser = new BrowserManager();
  console.log("Initializing browser...");
  await browser.init();

  console.log("Navigating to example.com...");
  await browser.navigate("https://example.com");

  console.log("Generating Observability Report...");
  const reportPath = await browser.generateObservabilityReport();
  console.log(`Report generated at: ${reportPath}`);

  if (fs.existsSync(reportPath)) {
    console.log("SUCCESS: Report file exists.");
  } else {
    console.log("FAILURE: Report file not found.");
  }

  console.log("\nClosing browser...");
  await browser.close();
}

main().catch(console.error);
