import { BrowserManager } from './BrowserManager.js';
async function main() {
    const browser = new BrowserManager();
    await browser.init();
    const reportPath = await browser.generateObservabilityReport();
    console.log(reportPath);
    await browser.close();
}
main();
