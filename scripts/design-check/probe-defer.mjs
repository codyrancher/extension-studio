// Defer a review, see the mark on the queue, answer it, see the mark go.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { login, RANCHER } from './login.mjs';

const kc = { env: { ...process.env, KUBECONFIG: '/workspace/.kube/config' } };
const pod = execFileSync('kubectl', ['-n', 'barn', 'get', 'pods', '-l', 'app=barn-base-extension',
  '-o', 'jsonpath={.items[0].metadata.name}'], kc).toString().trim();
const cfg = () => execFileSync('kubectl', ['-n', 'barn', 'exec', pod, '--', 'su', '-s', '/bin/bash', '-c',
  'cd /app/pkg/base && git config --local --get barn.review.deferred || echo "(unset)"', 'node'], kc).toString().trim();

const browser = await chromium.connectOverCDP(process.env.CLAUDE_BROWSER_CDP || 'http://localhost:9222');
const page = await browser.contexts()[0].newPage();
page.setDefaultTimeout(60000);
await page.setViewportSize({ width: 1440, height: 900 });
await login(page);

let fails = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ ok ? 'PASS' : 'FAIL' }  ${ label }${ detail ? `  ${ detail }` : '' }`);
  if (!ok) fails++;
};

try {
  execFileSync('kubectl', ['-n', 'barn', 'exec', pod, '--', 'su', '-s', '/bin/bash', '-c',
    'cd /app/pkg/base && git config --local --unset barn.review.deferred 2>/dev/null; true', 'node'], kc);
  check('starts undeferred', cfg() === '(unset)', cfg());

  await page.goto(`${ RANCHER }/dashboard/barn/review/base/working`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.rc__body', { timeout: 45000 });
  await page.waitForTimeout(3500);

  await page.locator('button:has-text("Come back to it")').first().click();
  await page.waitForTimeout(6000);

  check('git config now holds a deferral', cfg() !== '(unset)', cfg());
  check('landed back on the queue', page.url().includes('/barn/review'), page.url().split('/dashboard')[1]);

  await page.goto(`${ RANCHER }/dashboard/barn/review`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.queue__list', { timeout: 45000 });
  await page.waitForTimeout(7000);

  const marks = await page.evaluate(() => [...document.querySelectorAll('.queue__card')]
    .map((c) => ({ name: c.innerText.split('\n')[0], deferred: /Deferred/.test(c.innerText) })));

  check('the queue shows a Deferred mark', marks.some((m) => m.deferred), JSON.stringify(marks));

  // Answering clears it — use Request changes, which does not commit.
  await page.goto(`${ RANCHER }/dashboard/barn/review/base/working`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.rc__body', { timeout: 45000 });
  await page.waitForTimeout(3500);
  await page.locator('button:has-text("Request changes")').first().click();
  await page.waitForTimeout(6000);

  check('answering cleared the deferral', cfg() === '(unset)', cfg());
} catch (e) {
  console.log('ERROR', e.message.split('\n')[0]);
  fails++;
} finally {
  execFileSync('kubectl', ['-n', 'barn', 'exec', pod, '--', 'su', '-s', '/bin/bash', '-c',
    'cd /app/pkg/base && git config --local --unset barn.review.deferred 2>/dev/null; git config --local --unset barn.review.deferred-note 2>/dev/null; true', 'node'], kc);
  console.log(`\n${ fails === 0 ? 'ALL PASS' : fails + ' FAILED' }`);
  await page.close().catch(() => {});
  process.exit(fails === 0 ? 0 : 1);
}
