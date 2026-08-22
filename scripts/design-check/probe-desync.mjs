import { chromium } from 'playwright-core';
import { login, RANCHER } from './login.mjs';
const browser = await chromium.connectOverCDP(process.env.CLAUDE_BROWSER_CDP || 'http://localhost:9222');
const page = await browser.contexts()[0].newPage();
page.setDefaultTimeout(60000);
await page.setViewportSize({ width: 1440, height: 900 });
await login(page);
await page.goto(`${RANCHER}/dashboard/barn/extensions/base/verification`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.verify__body'); await page.waitForTimeout(5000);
console.log('criteria shown:', await page.evaluate(() =>
  [...document.querySelectorAll('.verify__criterion-text')].map(e => e.textContent.trim())));
// answer CRIT-1 = Yes, CRIT-2 = Yes
for (const n of [0, 1]) {
  await page.locator('.verify__criterion').nth(n).locator('.verify__verdict', { hasText: 'Yes' }).first().click();
  await page.waitForTimeout(300);
}
console.log('signoff:', await page.locator('.verify__signoff-text').textContent());
await page.locator('.verify__signoff button:has-text("Record the result")').click();
await page.waitForTimeout(10000);
await page.close();
