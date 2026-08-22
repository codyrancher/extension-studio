// Load every screen and fail on any uncaught runtime error.
//
// This is the check that catches what neither the harness nor a static pass can: a control
// wired to a symbol that does not exist at runtime. A misplaced import throws
// `X is not a function` synchronously, which goes around any .catch and aborts the whole
// load - the screen renders, measures clean, and is empty. Found exactly that way.
import { chromium } from 'playwright-core';
import { login, RANCHER } from './login.mjs';

const SCREENS = [
  ['01-home',      '/barn/extensions',                   '.studio-home__table'],
  ['02-new',       '/barn/extensions/new',               '.new-ext__card'],
  ['03-workspace', '/barn/editor',                       '.mc-editor'],
  ['04-review',    '/barn/extensions/base/review',       '.review__body'],
  ['05-files',     '/barn/extensions/base/files',        '.files__body'],
  ['08-failed',    '/barn/extensions/base/build-failed', '.failed__masthead'],
  ['10-brief',     '/barn/extensions/base/brief',        '.brief__columns'],
  ['11-queue',     '/barn/review',                       '.queue__list'],
  ['12-change',    '/barn/review/base/working',          '.rc__body'],
  ['13-verify',    '/barn/extensions/base/verification', '.verify__body'],
];

const browser = await chromium.connectOverCDP(process.env.CLAUDE_BROWSER_CDP || 'http://localhost:9222');
const page = await browser.contexts()[0].newPage();
page.setDefaultTimeout(60000);
await page.setViewportSize({ width: 1440, height: 900 });

let errors = [];

page.on('pageerror', (e) => errors.push(`pageerror: ${ e.message.split('\n')[0].slice(0, 150) }`));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  // Rancher's own noise, and resource 404s that are not ours.
  if (/favicon|Failed to load resource|net::ERR|Unauthorized 401/.test(t)) return;
  errors.push(`console: ${ t.slice(0, 150) }`);
});

await login(page);

let failed = 0;

for (const [name, route, ready] of SCREENS) {
  errors = [];
  await page.goto(`${ RANCHER }/dashboard${ route }`, { waitUntil: 'domcontentloaded' });
  const found = await page.waitForSelector(ready, { timeout: 40000 }).then(() => true).catch(() => false);

  await page.waitForTimeout(6000);

  const uniq = [...new Set(errors)];
  const ok = found && uniq.length === 0;

  if (!ok) failed++;
  console.log(`${ ok ? 'PASS' : 'FAIL' }  ${ name.padEnd(13) } ${ found ? '' : 'selector missing  ' }${ uniq.slice(0, 2).join(' | ') }`);
}

console.log(`\n${ failed === 0 ? 'ALL CLEAN' : failed + ' screens with runtime errors' }`);
await page.close();
process.exit(failed === 0 ? 0 : 1);
