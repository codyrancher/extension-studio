// Measure what the Studio actually renders, so it can be diffed against the Figma values.
//
// Screenshots are for spotting that something is wrong; they are hopeless for saying a gap is
// 10px when the design says 12. This walks a list of selectors per screen and dumps the
// computed box - padding, gap, font, colour, border, size - as JSON.
import { chromium } from 'playwright-core';
import { login, RANCHER } from './login.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const SPEC = JSON.parse(readFileSync(process.argv[2] || '/workspace/videos/spec.json', 'utf8'));
const ONLY = process.argv[3] || '';
const OUT = process.argv[4] || '/workspace/videos/measured.json';

const browser = await chromium.connectOverCDP(process.env.CLAUDE_BROWSER_CDP || 'http://localhost:9222');
const page = await browser.contexts()[0].newPage();
page.setDefaultTimeout(90000);
await page.setViewportSize({ width: 1440, height: 900 });

await login(page);

// Pin the theme. The dark-mode probe persists `theme: dark` in localStorage, and the browser
// sidecar is shared, so a later measurement run would silently read dark-theme colours against
// a spec written from a light-mode design file - three colour defects that are not defects.
// The spec's colours are light-theme literals, so light is what has to be measured.
await page.evaluate(() => {
  try {
    window.localStorage.setItem('theme', 'light');
  } catch { /* storage can be unavailable */ }
});

const measured = {};

for (const [screen, def] of Object.entries(SPEC.screens)) {
  if (ONLY && screen !== ONLY) {
    continue;
  }

  if (def.seedFailure) {
    // Screen 08 renders nothing without a recorded failure; seed the record it reads.
    await page.goto(`${ RANCHER }/dashboard/barn/extensions`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
      window.sessionStorage.setItem('barn.publish.failure', JSON.stringify({
        extension: 'base',
        message:   'the extension did not build',
        at:        Date.now(),
        log:       'ERROR in ./pages/NodeHealth.vue\nModule not found\nwebpack compiled with 1 error',
      }));
    });
  }

  await page.goto(`${ RANCHER }/dashboard${ def.route }`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(def.ready, { timeout: 45000 }).catch(() => {});
  // Rancher restores the stored theme on each route render, so re-assert after navigation.
  await page.evaluate(() => {
    document.body.classList.remove('theme-dark');
    document.body.classList.add('theme-light');
  });
  await page.waitForTimeout(4500);

  measured[screen] = await page.evaluate((selectors) => {
    const px = (v) => Math.round(parseFloat(v) * 100) / 100;
    const out = {};

    for (const sel of selectors) {
      const el = document.querySelector(sel);

      if (!el) {
        out[sel] = null;
        continue;
      }

      const c = getComputedStyle(el);
      const r = el.getBoundingClientRect();

      out[sel] = {
        pad:    [c.paddingTop, c.paddingRight, c.paddingBottom, c.paddingLeft].map(px).join(' '),
        gap:    c.columnGap === 'normal' ? px(c.rowGap) : `${ px(c.rowGap) }/${ px(c.columnGap) }`,
        font:   `${ px(c.fontSize) }/${ c.fontWeight }`,
        lh:     c.lineHeight === 'normal' ? 'normal' : px(c.lineHeight),
        color:  c.color,
        bg:     c.backgroundColor,
        radius: px(c.borderTopLeftRadius),
        border: [c.borderTopWidth, c.borderRightWidth, c.borderBottomWidth, c.borderLeftWidth].map(px).join(' '),
        bcol:   c.borderTopColor === c.borderBottomColor ? c.borderTopColor : `${ c.borderTopColor }|${ c.borderBottomColor }`,
        size:   `${ Math.round(r.width) }x${ Math.round(r.height) }`,
        dir:    c.flexDirection,
        align:  c.alignItems,
      };
    }

    return out;
  }, def.measure);

  console.log(`measured ${ screen } (${ Object.values(measured[screen]).filter(Boolean).length }/${ def.measure.length } found)`);
}

writeFileSync(OUT, JSON.stringify(measured, null, 2));
console.log(`wrote ${ OUT }`);

await page.close();
process.exit(0);
