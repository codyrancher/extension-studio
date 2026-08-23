// Fold the verifiers' verdicts into features.json.
//
// Each verifier owns one file under verdicts/ and never touches features.json, because a dozen
// agents writing one JSON file is a lost-update bug waiting to happen. This is the only writer.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'features.json');
const VERDICTS = join(HERE, 'verdicts');

const doc = JSON.parse(readFileSync(OUT, 'utf8'));
const byId = new Map(doc.features.map((f) => [f.id, f]));

const VALID = new Set(['pass', 'fail', 'blocked', 'not-implemented']);
let applied = 0;
const unknown = [];
const bad = [];

for (const file of readdirSync(VERDICTS).filter((f) => f.endsWith('.json')).sort()) {
  const v = JSON.parse(readFileSync(join(VERDICTS, file), 'utf8'));

  for (const r of v.verdicts || []) {
    const f = byId.get(r.id);

    if (!f) {
      // A verifier inventing an id means it verified something that is not on the list, which is
      // worth knowing about rather than silently dropping - it is usually a real feature the
      // extractor missed.
      unknown.push(`${ file }:${ r.id }`);
      continue;
    }
    if (!VALID.has(r.status)) {
      bad.push(`${ file }:${ r.id }=${ r.status }`);
      continue;
    }

    f.status = r.status;
    f.defect = r.status === 'pass' ? null : (r.defect || 'no detail given');
    f.evidence = r.evidence || null;
    f.verifiedAt = r.verifiedAt || new Date().toISOString().slice(0, 16);
    applied++;
  }
}

writeFileSync(OUT, `${ JSON.stringify(doc, null, 2) }\n`);

const by = doc.features.reduce((m, f) => ({ ...m, [f.status]: (m[f.status] || 0) + 1 }), {});
console.log(`applied ${ applied } verdicts`);
for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${ k.padEnd(16) } ${ v }`);
}
if (unknown.length) {
  console.log(`\nverdicts for ids not on the list (${ unknown.length }):\n  ${ unknown.join('\n  ') }`);
}
if (bad.length) {
  console.log(`\nunrecognised status values (${ bad.length }):\n  ${ bad.join('\n  ') }`);
}
