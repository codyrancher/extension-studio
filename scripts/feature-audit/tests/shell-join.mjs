// A shell script assembled from an array must not put `;` where the shell forbids one.
//
// `baselineRef` built its script as an array joined with ' ; '. One element ended in `do`, so the
// join emitted `for r in ... ; do ; git rev-parse ...` and the pod's dash answered
// `Syntax error: ";" unexpected`, exit 2. A `.catch(() => '')` turned that into an empty string,
// so the function reported "no history yet" for every extension, forever - and every screen that
// measures from a baseline silently fell back to HEAD. Screen 04 went on offering to discard
// commits it could not reach for two waves.
//
// The shell keywords that cannot be followed by `;`: do, then, else, in, and `{`. This walks every
// array-joined shell script in extensions.ts and review.ts and fails on any element that ends in
// one of them while being joined by something starting with a separator.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILES = ['../../../pkg/barn/extensions.ts', '../../../pkg/barn/review.ts'];

// A `;` may not follow any of these.
const OPENERS = /(^|\s)(do|then|else|in|\{)$/;

let failures = 0;
let checked = 0;

// The bug being guarded, so this test cannot quietly stop working. This is `baselineRef`'s script
// exactly as it was written, and the guard must flag it.
const KNOWN_BAD = `const out = await inPackage(name, [
    BASELINE_SH,
    \`for r in \${ BASELINE_OCI_REF } \${ BASELINE_LOCAL_REF } ; do\`,
    'git rev-parse --verify -q "$r" >/dev/null && { echo "KIND=$r"; break; } ; done',
    'echo "SHA=$BARN_BASE"',
  ].join(' ; '));`;

const scan = (src) => {
  const found = [];

  for (const m of src.matchAll(/\[([^\]]*?)\]\s*\.join\((['"`])(.*?)\2\)/gs)) {
    const [, body, , sep] = m;

    if (!/^\s*;/.test(sep)) {
      continue;
    }
    const elements = body
      .split(/,\s*\n/)
      .map((e) => e.trim().replace(/^['"`]|['"`],?$/g, '').trim())
      .filter(Boolean);

    elements.slice(0, -1).forEach((el, i) => {
      if (OPENERS.test(el)) {
        found.push({ i, el, sep, index: m.index });
      }
    });
  }

  return found;
};

if (scan(KNOWN_BAD).length !== 1) {
  console.log('FAIL  the guard no longer detects the bug it was written for');
  console.log('        (baselineRef\'s original `; do` join scanned clean, so this test proves nothing)');
  process.exit(1);
}
console.log('PASS  the guard still detects the original `; do` bug');

for (const rel of FILES) {
  const path = join(HERE, rel);
  const src = readFileSync(path, 'utf8');

  // Find `[ ... ].join(<sep>)` blocks. Non-greedy to the nearest `].join(`.
  for (const m of src.matchAll(/\[([^\]]*?)\]\s*\.join\((['"`])(.*?)\2\)/gs)) {
    const [, body, , sep] = m;

    // Only separators that begin with a command terminator can break a keyword.
    if (!/^\s*;/.test(sep)) {
      continue;
    }

    // Each element's trailing text, ignoring template-literal interpolation.
    const elements = body
      .split(/,\s*\n/)
      .map((e) => e.trim().replace(/^['"`]|['"`],?$/g, '').trim())
      .filter(Boolean);

    checked++;

    elements.slice(0, -1).forEach((el, i) => {
      if (OPENERS.test(el)) {
        failures++;
        const line = src.slice(0, m.index).split('\n').length;
        console.log(`FAIL  ${ rel.split('/').pop() }:${ line } element ${ i } ends in a shell keyword that cannot take a ';'`);
        console.log(`        ...${ el.slice(-60) }`);
        console.log(`        joined with ${ JSON.stringify(sep) } - use '\\n' for this script`);
      }
    });
  }
}

console.log(`\n${ failures === 0 ? 'ALL PASS' : `${ failures } bad join${ failures === 1 ? '' : 's' }` } (${ checked } array-joined shell scripts checked)`);
process.exit(failures ? 1 : 0);
