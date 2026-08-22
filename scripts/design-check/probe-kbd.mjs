// Does REAL keyboard traversal (Tab) reproduce the 2px scroll, or only a mouse click?
import { chromium } from 'playwright-core';
import { login, RANCHER } from './login.mjs';
const b = await chromium.connectOverCDP(process.env.CLAUDE_BROWSER_CDP || 'http://localhost:9222');
const p = await b.contexts()[0].newPage();
p.setDefaultTimeout(60000);
await p.setViewportSize({ width: 1440, height: 900 });
await login(p);
await p.goto(`${RANCHER}/dashboard/barn/extensions/base/verification`, { waitUntil: 'domcontentloaded' });
await p.waitForSelector('.verify__body'); await p.waitForTimeout(4500);

const st = (tag) => p.evaluate((t) => ({ tag: t,
  rows: [...document.querySelectorAll('.verify__verdicts')].map(w => w.scrollLeft),
  focus: document.activeElement?.textContent?.trim().slice(0,12) || document.activeElement?.tagName }), tag);

console.log(JSON.stringify(await st('initial')));
// focus the FIRST segment of row 0, then Tab across to the third
await p.locator('.verify__criterion').nth(0).locator('.verify__verdict').nth(0).focus();
await p.waitForTimeout(300);
console.log(JSON.stringify(await st('focus seg1')));
await p.keyboard.press('Tab'); await p.waitForTimeout(300);
console.log(JSON.stringify(await st('Tab -> seg2')));
await p.keyboard.press('Tab'); await p.waitForTimeout(400);
console.log(JSON.stringify(await st('Tab -> seg3')));
// and activate it by keyboard
await p.keyboard.press('Enter'); await p.waitForTimeout(500);
console.log(JSON.stringify(await st('Enter on seg3')));
await p.close();
