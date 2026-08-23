// Merge the per-screen extraction files into one feature list, and keep the verification
// verdicts that have already been recorded against it.
//
// The extraction agents each own one file under raw/. This is the only thing that writes
// features.json, so a re-run of one extractor cannot clobber another's work, and re-running
// this after a verification pass preserves every verdict already recorded (matched by id).
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, 'raw');
const OUT = join(HERE, 'features.json');

// Verdicts already recorded, so merging does not throw away a verification pass.
const prior = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { features: [] };
const priorById = new Map(prior.features.map((f) => [f.id, f]));

const SCREEN_ORDER = [
  '01-home', '02-new', '03-workspace', '04-review', '05-files', '06-import', '06a-import-first',
  '07-publish', '08-failed', '09-settings', '10-brief', '11-queue', '12-change', '13-verify',
];

const features = [];
const seen = new Set();
const dupes = [];

for (const file of readdirSync(RAW).filter((f) => f.endsWith('.json')).sort()) {
  const doc = JSON.parse(readFileSync(join(RAW, file), 'utf8'));

  for (const screen of doc.screens || []) {
    for (const f of screen.features || []) {
      if (seen.has(f.id)) {
        // Two extractors claiming the same id is a real collision: the sub-frames of screen 03
        // overlap its main frame, and 04 and 12 both draw a diff. Keep the first and say so.
        dupes.push(f.id);
        continue;
      }
      seen.add(f.id);

      const was = priorById.get(f.id);

      features.push({
        ...f,
        screen:     screen.screen,
        figmaFrame: screen.figmaFrame,
        // Verification state. `status` is unverified until an agent has driven the real UI.
        status:     was?.status || 'unverified',
        defect:     was?.defect ?? null,
        verifiedAt: was?.verifiedAt ?? null,
        attempts:   was?.attempts ?? 0,
      });
    }
  }
}

features.sort((a, b) => {
  const s = SCREEN_ORDER.indexOf(a.screen) - SCREEN_ORDER.indexOf(b.screen);
  return s !== 0 ? s : a.id.localeCompare(b.id);
});

writeFileSync(OUT, `${ JSON.stringify({ features }, null, 2) }\n`);

const by = (key) => features.reduce((m, f) => ({ ...m, [f[key]]: (m[f[key]] || 0) + 1 }), {});
const interactive = features.filter((f) => f.kind !== 'display');

console.log(`${ features.length } features (${ interactive.length } interactive, ${ features.length - interactive.length } display-only)`);
console.log('\nby screen:');
for (const [k, v] of Object.entries(by('screen'))) {
  console.log(`  ${ k.padEnd(18) } ${ v }`);
}
console.log('\nby kind:');
for (const [k, v] of Object.entries(by('kind')).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${ k.padEnd(12) } ${ v }`);
}
console.log('\nby status:');
for (const [k, v] of Object.entries(by('status'))) {
  console.log(`  ${ k.padEnd(12) } ${ v }`);
}
if (dupes.length) {
  console.log(`\nduplicate ids dropped (${ dupes.length }): ${ dupes.join(', ') }`);
}
