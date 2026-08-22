import { chromium } from 'playwright-core';
import { login, RANCHER } from './login.mjs';

const browser = await chromium.connectOverCDP(process.env.CLAUDE_BROWSER_CDP || 'http://localhost:9222');
const page = await browser.contexts()[0].newPage();
page.setDefaultTimeout(60000);
await page.setViewportSize({ width: 1440, height: 900 });
await login(page);
await page.goto(`${RANCHER}/dashboard/barn/extensions/base/verification`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.verify__body', { timeout: 45000 });
await page.waitForTimeout(4000);

const snap = async (tag) => {
  const s = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.verify__criterion')];
    return {
      signoff: document.querySelector('.verify__signoff-text')?.textContent.trim(),
      badge: document.querySelector('.verify__masthead .s-badge')?.textContent.trim(),
      chip: document.querySelector('.verify__panel-head .s-chip')?.textContent.trim(),
      rows: rows.map((r) => ({
        text: r.querySelector('.verify__criterion-text')?.textContent.trim().slice(0, 34),
        badgeCls: r.querySelector('.verify__badge')?.className.replace('verify__badge ',''),
        badgeBg: getComputedStyle(r.querySelector('.verify__badge')).backgroundColor,
        wrapBg: getComputedStyle(r.querySelector('.verify__verdicts')).backgroundColor,
        meta: r.querySelector('.verify__meta')?.textContent.replace(/\s+/g,' ').trim() ?? null,
        segs: [...r.querySelectorAll('.verify__verdict')].map((b) => {
          const cs = getComputedStyle(b); const bb = b.getBoundingClientRect();
          return { label: b.textContent.trim(), pressed: b.getAttribute('aria-pressed'),
                   bg: cs.backgroundColor, color: cs.color,
                   box: `${bb.width.toFixed(2)}x${bb.height.toFixed(2)}@${bb.x.toFixed(2)},${bb.y.toFixed(2)}` };
        }),
      })),
    };
  });
  console.log(`\n########## ${tag}`);
  console.log('signoff :', s.signoff);
  console.log('badge   :', s.badge, '| chip:', s.chip);
  s.rows.forEach((r, i) => {
    console.log(` row${i} "${r.text}" badge=${r.badgeCls} ${r.badgeBg} wrapBg=${r.wrapBg}`);
    console.log(`      meta=${JSON.stringify(r.meta)}`);
    r.segs.forEach((g) => console.log(`      [${g.label}] pressed=${g.pressed} bg=${g.bg} fg=${g.color} ${g.box}`));
  });
  return s;
};

const click = async (row, label) => {
  await page.locator('.verify__criterion').nth(row).locator('.verify__verdict', { hasText: label }).first().click();
  await page.waitForTimeout(500);
};

// geometry / box-sizing facts
console.log('=== GEOMETRY ===');
console.log(await page.evaluate(() => {
  const w = document.querySelector('.verify__verdicts');
  const cs = getComputedStyle(w); const r = w.getBoundingClientRect();
  const segs = [...w.children].map(c => { const b = c.getBoundingClientRect();
    return { w: +b.width.toFixed(3), h: +b.height.toFixed(3), x: +b.x.toFixed(2), right: +b.right.toFixed(2), y:+b.y.toFixed(2), bottom:+b.bottom.toFixed(2) }; });
  return { boxSizing: cs.boxSizing, wrap: { w:+r.width.toFixed(3), h:+r.height.toFixed(3), x:+r.x.toFixed(2), right:+r.right.toFixed(2), y:+r.y.toFixed(2), bottom:+r.bottom.toFixed(2) },
           clientW: w.clientWidth, clientH: w.clientHeight, overflow: cs.overflow, segs,
           sumSegs: +segs.reduce((a,s)=>a+s.w,0).toFixed(3),
           onWarning: getComputedStyle(document.documentElement).getPropertyValue('--studio-on-warning'),
           warning: getComputedStyle(document.documentElement).getPropertyValue('--studio-warning') };
}));

await snap('INITIAL (untouched, read back off BRIEF.md)');
await click(0, 'Yes');       await snap('row0 -> Yes');
await click(0, 'No');        await snap('row0 -> No');
await click(0, "Can't tell");await snap("row0 -> Can't tell");
await click(1, "Can't tell");await snap("row1 -> Can't tell (2 unsure)");
await click(0, "Can't tell");await snap('row0 -> toggle OFF (press pressed segment)');
await page.screenshot({ path: '/workspace/videos/verdict-states.png' });
await page.close();
