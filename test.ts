import { BrowserManager } from "./src/BrowserManager.js";

async function main() {
  const browser = new BrowserManager();
  console.log("Initializing browser...");
  await browser.init();

  console.log("Navigating to example.com...");
  await browser.navigate("https://example.com");

  console.log("\n--- Testing Security Lens ---");
  const securityTree = await browser.getSemanticTree("password", "Security");
  console.log("Security Tree Nodes:", JSON.stringify(securityTree, null, 2));

  console.log("\n--- Testing Performance Lens ---");
  const perfTree = await browser.getSemanticTree("", "Performance");
  console.log("Performance Tree Nodes:", perfTree.children?.length || 0);

  console.log("\n--- Testing Debug Trace ---");
  const tracePath = await browser.debugFailure("test-session-1");
  console.log(`Saved debug trace to: ${tracePath}`);

  console.log("\nClosing browser...");
  await browser.close();
}

main().catch(console.error);
