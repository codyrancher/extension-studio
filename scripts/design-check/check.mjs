// Diff what rendered against what the Figma file says, and print the disagreements.
//
// Output is deliberately terse and machine-ish: one line per defect, naming the screen, the
// selector, the property, what was expected and what was measured, and the Figma node the
// expectation came from - so a fix can be checked at source rather than argued about.
import { readFileSync } from 'node:fs';

const spec = JSON.parse(readFileSync(process.argv[2] || '/workspace/videos/spec.json', 'utf8'));
const got = JSON.parse(readFileSync(process.argv[3] || '/workspace/videos/measured.json', 'utf8'));

// Colours come back as rgb(); compare on normalised hex.
const hex = (v) => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(v));

  return m ? `#${ [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('') }`.toUpperCase() : String(v).toUpperCase();
};

// A gap is written "10" in the spec when both axes are 10, and the measurer reports
// "10/10". Normalise both sides to row/column so the two notations compare equal - without
// this every symmetric gap in the file reads as a defect and the real ones are lost in them.
const gap = (v) => {
  const str = String(v);
  const [row, col] = str.includes('/') ? str.split('/') : [str, str];

  return `${ row }/${ col }`;
};

// "180x*" means only the width is specified.
//
// Exact, not near. This used to allow a pixel either way, which sounds harmless and is not:
// it made every 1px expectation in the file a no-op, and it is why the harness reported a
// clean run while the verdict segments were 72px inside a 214px content box - overflowing,
// turning the control into a scroll container, and visibly clipping a segment on click. A
// tolerance that hides the defect you wrote the expectation to catch is worse than no
// expectation, because it reads as a pass.
//
// Sub-pixel layout is real, so the comparison rounds to the whole pixel the measurer already
// reports rather than demanding float equality.
const sizeMatches = (want, have) => {
  const [ww, wh] = String(want).split('x');
  const [hw, hh] = String(have).split('x');
  const same = (a, b) => Math.round(Number(a)) === Math.round(Number(b));

  return (ww === '*' || same(ww, hw)) && (wh === '*' || same(wh, hh));
};

let defects = 0;
let checked = 0;
let missing = 0;

for (const [screen, def] of Object.entries(spec.screens)) {
  const measured = got[screen];

  if (!measured) {
    continue;
  }

  for (const [sel, want] of Object.entries(def.expect || {})) {
    const have = measured[sel];

    if (!have) {
      console.log(`MISSING  ${ screen }  ${ sel }  (not in the DOM)`);
      missing++;
      continue;
    }

    for (const [prop, wantVal] of Object.entries(want)) {
      if (prop === 'from') {
        continue;
      }

      checked++;
      const haveVal = have[prop];
      let ok;

      if (prop === 'bg' || prop === 'color' || prop === 'bcol') {
        ok = hex(haveVal) === hex(wantVal);
      } else if (prop === 'size') {
        ok = sizeMatches(wantVal, haveVal);
      } else if (prop === 'gap') {
        ok = gap(haveVal) === gap(wantVal);
      } else if (prop === 'radius') {
        ok = String(haveVal) === String(wantVal);
      } else {
        ok = String(haveVal) === String(wantVal);
      }

      if (!ok) {
        console.log(`DEFECT   ${ screen }  ${ sel }  ${ prop }: want ${ wantVal }  got ${ haveVal }   [${ want.from }]`);
        defects++;
      }
    }
  }
}

console.log(`\n${ defects } defects, ${ missing } selectors missing, ${ checked } properties checked`);
process.exit(0);
