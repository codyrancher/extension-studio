// The regression test for the two data-loss bugs on screen 13.
//
// Both were invisible to measurement and both wrote wrong data into a git-committed file, so
// this drives the real UI against a deliberately hostile brief: checkboxes ABOVE the criteria
// section (which the old code ticked by position) and a hand-written section BELOW the
// verification block (which the old code deleted to end of file).
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { login, RANCHER } from './login.mjs';

const NS = 'extension-studio';
const kc = { env: { ...process.env, KUBECONFIG: '/workspace/.kube/config' } };
const pod = execFileSync('kubectl', ['-n', NS, 'get', 'pods', '-l', 'app=barn-base-extension',
  '-o', 'jsonpath={.items[0].metadata.name}'], kc).toString().trim();

const podSh = (script) => execFileSync('kubectl',
  ['-n', NS, 'exec', pod, '--', 'bash', '-lc', script], kc).toString();

const BRIEF = '/app/pkg/base/BRIEF.md';
const original = podSh(`cat ${ BRIEF }`);

const HOSTILE = `# base

## What we are deliberately not doing
- [ ] DECOY ONE no alerting
- [ ] DECOY TWO no history beyond 24 hours

## How we will know it worked
- [ ] CRIT ONE the tab appears under the cluster nav
- [ ] CRIT TWO it renders with metrics-server absent
- [ ] CRIT THREE a 24-hour trend is readable

## Verification

Verdict: **stale, from a previous run**

## Afterword written by a person
This paragraph is below the verification block and must survive.
- [ ] DECOY THREE also below the block
`;

const write = (text) => {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  podSh(`printf %s '${ b64 }' | base64 -d > ${ BRIEF } && chown 1000:1000 ${ BRIEF }`);
};

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ ok ? 'PASS' : 'FAIL' }  ${ label }${ detail ? `  ${ detail }` : '' }`);
  if (!ok) failures++;
};

const browser = await chromium.connectOverCDP(process.env.CLAUDE_BROWSER_CDP || 'http://localhost:9222');
const page = await browser.contexts()[0].newPage();
page.setDefaultTimeout(60000);
await page.setViewportSize({ width: 1440, height: 900 });

try {
  write(HOSTILE);
  await login(page);
  await page.goto(`${ RANCHER }/dashboard/barn/extensions/base/verification`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.verify__criterion', { timeout: 45000 });
  await page.waitForTimeout(3500);

  const rows = await page.locator('.verify__criterion').count();

  check('only the criteria section is shown (3 rows, decoys excluded)', rows === 3, `got ${ rows }`);

  // Yes on the first, No on the second, leave the third untouched.
  await page.locator('.verify__criterion').nth(0).locator('button', { hasText: 'Yes' }).click();
  await page.waitForTimeout(400);
  await page.locator('.verify__criterion').nth(1).locator('button', { hasText: 'No' }).click();
  await page.waitForTimeout(400);

  await page.locator('button', { hasText: 'Record the result' }).first().click();
  await page.waitForTimeout(9000);

  const after = podSh(`cat ${ BRIEF }`);

  check('decoys above the criteria section were not ticked',
    /- \[ \] DECOY ONE/.test(after) && /- \[ \] DECOY TWO/.test(after));
  check('the Yes landed on CRIT ONE', /- \[x\] CRIT ONE/.test(after));
  check('CRIT TWO (a No) is left unticked', /- \[ \] CRIT TWO/.test(after));
  check('CRIT THREE (untouched) is left unticked', /- \[ \] CRIT THREE/.test(after));
  check('the section below the verification block survived',
    /## Afterword written by a person/.test(after) && /must survive/.test(after));
  check('the decoy below the block survived', /- \[ \] DECOY THREE/.test(after));
  check('the stale verdict line was replaced, not duplicated',
    !/stale, from a previous run/.test(after) && (after.match(/## Verification/g) || []).length === 1);
  check('all four states are recorded by criterion text',
    /Met.*CRIT ONE/s.test(after) && /Not met.*CRIT TWO/s.test(after));

  // And the states come back on a reload.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.verify__criterion', { timeout: 45000 });
  await page.waitForTimeout(3500);

  const pressed = await page.evaluate(() => [...document.querySelectorAll('.verify__criterion')]
    .map((r) => [...r.querySelectorAll('[aria-pressed="true"]')].map((b) => b.innerText.trim())));

  check('after reload the No survived', JSON.stringify(pressed[1]) === '["No"]', JSON.stringify(pressed));
  check('after reload the Yes survived', JSON.stringify(pressed[0]) === '["Yes"]');
  check('the untouched row is still unanswered', JSON.stringify(pressed[2]) === '[]');
} catch (e) {
  console.log('ERROR', e.message.split('\n')[0]);
  failures++;
} finally {
  write(original);
  console.log(`\n${ failures === 0 ? 'ALL PASS' : failures + ' FAILED' } - BRIEF.md restored`);
  await page.close().catch(() => {});
  process.exit(failures === 0 ? 0 : 1);
}
