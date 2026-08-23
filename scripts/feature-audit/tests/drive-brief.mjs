// Does the brief screen now load the existing BRIEF.md, in the browser, in the shipped bundle?
import { chromium } from 'playwright-core';
import { login, RANCHER } from '/workspace/magic-closet/barn/scripts/design-check/login.mjs';

const browser = await chromium.connectOverCDP(process.env.CLAUDE_BROWSER_CDP);
const page = await browser.contexts()[0].newPage();

page.setDefaultTimeout(60000);
await page.setViewportSize({ width: 1440, height: 900 });
await login(page);
await page.goto(`${ RANCHER }/dashboard/barn/extensions/base/brief`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.brief__columns', { timeout: 45000 });
await page.waitForTimeout(6000);

const got = await page.evaluate(() => {
  const vals = [...document.querySelectorAll('.brief__columns textarea, .brief__columns input')]
    .map((el) => el.value)
    .filter((v) => v && v.trim());

  return vals;
});

console.log(`fields carrying text: ${ got.length }`);
got.forEach((v) => console.log(`  - ${ v.slice(0, 72).replace(/\n/g, ' ') }`));

const joined = got.join(' | ');
const checks = [
  ['the problem came from the file',  /Mid-incident an operator/.test(joined)],
  ['who has it came from the file',   /Whoever is on call/.test(joined)],
  ['non-goals came from the file',    /No alerting/.test(joined)],
  ['criterion 1 came from the file',  /tab appears under the cluster nav/.test(joined)],
  ['criterion 4 came from the file',  /Nothing on the existing cluster page moves/.test(joined)],
  ['no verdict text leaked in',       !/\*\*Met\*\*|\*\*Not looked at\*\*/.test(joined)],
];

let bad = 0;

for (const [name, ok] of checks) {
  console.log(`${ ok ? 'PASS' : 'FAIL' }  ${ name }`);
  if (!ok) {
    bad++;
  }
}
console.log(`\n${ bad === 0 ? 'ALL PASS' : `${ bad } FAILED` }`);
await page.close();
process.exit(bad ? 1 : 0);
