// Screenshot every Studio screen in the real Rancher dashboard.
//
// Against the real dashboard rather than the extension's dev server, which is the right target
// for two reasons: it serves the minified production bundle (the thing that actually ships),
// and it has proper history routing, so each screen can be reached by its own URL instead of
// being driven through the app's router.
import { chromium } from 'playwright-core';
import { login, RANCHER } from './login.mjs';

const OUT = process.env.SHOT_DIR || '/workspace/videos/shots';

const t0 = Date.now();
const log = (...a) => console.log(`${ ((Date.now() - t0) / 1000).toFixed(1) }s`, ...a);

const SCREENS = [
  ['01-home',      '/barn/extensions',                   '.studio-home__table'],
  ['02-new',       '/barn/extensions/new',               '.new-ext__card'],
  ['03-workspace', '/barn/editor',                       '.mc-editor'],
  ['04-review',    '/barn/extensions/base/review',       '.review__body'],
  ['05-files',     '/barn/extensions/base/files',        '.files__body'],
  ['08-failed',    '/barn/extensions/base/build-failed', '.failed__body'],
  ['10-brief',     '/barn/extensions/base/brief',        '.brief__columns'],
  ['11-queue',     '/barn/review',                       '.queue__list'],
  ['12-change',    '/barn/review/base/working',          '.rc__body'],
  ['13-verify',    '/barn/extensions/base/verification', '.verify__body'],
];

const browser = await chromium.connectOverCDP(process.env.CLAUDE_BROWSER_CDP || 'http://localhost:9222');
const page = await browser.contexts()[0].newPage();
page.setDefaultTimeout(90000);
await page.setViewportSize({ width: 1440, height: 900 });

const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${ e.message.slice(0, 160) }`));
page.on('console', (m) => {
  if (m.type() === 'error') {
    const t = m.text();
    if (!/favicon|Failed to load resource|net::ERR/.test(t)) errors.push(t.slice(0, 160));
  }
});

const results = [];

try {
  log('login');
  log('login ->', await login(page));

  // Pin the theme, for the same reason measure.mjs does: the dark probe persists
  // `theme: dark` into the shared browser profile, and a capture run after it silently
  // produces dark screenshots into the light directory. A verifier then reads a stale or
  // mis-themed PNG and reports a fixed bug as live, which happened.
  await page.evaluate(() => {
    try {
      window.localStorage.setItem('theme', 'light');
    } catch { /* storage can be unavailable */ }
  });

  log('signed in ->', page.url());

  for (const [name, route, sel] of SCREENS) {
    errors.length = 0;

    // Screen 08 only has something to draw when a publish has failed. Seeding the record it
    // reads is the only way to see its populated state without breaking a build on purpose;
    // the shape and the key are exactly what publish-failure.ts writes.
    if (name === '08-failed') {
      await page.goto(`${ RANCHER }/dashboard/barn/extensions`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        window.sessionStorage.setItem('barn.publish.failure', JSON.stringify({
          extension: 'base',
          message:   'the extension did not build',
          at:        Date.now(),
          log:       [
            '> barn@0.5.22 build-pkg',
            'Building for production as library (umd-min)...',
            '',
            'ERROR in ./pages/NodeHealth.vue',
            "Module not found: Error: Can't resolve '@shell/utils/conditions' in '/app/pkg/base/pages'",
            ' @ ./routing/index.ts 4:0-52',
            ' @ ./index.ts 3:0-31',
            '',
            'ERROR in ./routing/index.ts:12:18',
            "TS2551: Property 'addRoutes' does not exist on type 'IPlugin'. Did you mean 'addRoute'?",
            '',
            'webpack compiled with 2 errors',
          ].join('\n'),
        }));
      });
    }
    await page.goto(`${ RANCHER }/dashboard${ route }`, { waitUntil: 'domcontentloaded' });

    const found = await page.waitForSelector(sel, { timeout: 40000 }).then(() => true).catch(() => false);

    await page.evaluate(() => {
      document.body.classList.remove('theme-dark');
      document.body.classList.add('theme-light');
    });

    await page.waitForTimeout(4000);
    await page.screenshot({ path: `${ OUT }/${ name }.png` });

    const bodyLen = await page.evaluate(() => (document.body.innerText || '').length);

    results.push({
      name, found, bodyLen, errors: [...errors],
    });
    log(`${ name.padEnd(13) } sel=${ found ? 'OK ' : 'MISS' } text=${ String(bodyLen).padStart(5) } ${ errors[0] || '' }`);
  }
} catch (e) {
  log('FAILED', e.message.split('\n')[0]);
} finally {
  console.log(`\ncaptured to ${ OUT } at ${ new Date().toISOString() }`);
  console.log('\n=== summary ===');
  results.forEach((r) => console.log(`${ r.found ? 'ok  ' : 'MISS' } ${ r.name } (${ r.bodyLen } chars)${ r.errors.length ? ' errors: ' + r.errors.slice(0, 2).join(' | ') : '' }`));
  await page.close().catch(() => {});
  process.exit(0);
}
