// The todo list: every feature that is not `pass`, ordered so the worst comes first.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(readFileSync(join(HERE, 'features.json'), 'utf8'));

const RANK = { 'not-implemented': 0, fail: 1, blocked: 2, unverified: 3, pass: 4 };
const open = doc.features
  .filter((f) => f.status !== 'pass')
  .sort((a, b) => (RANK[a.status] - RANK[b.status]) || a.id.localeCompare(b.id));

const only = process.argv[2];
const list = only ? open.filter((f) => f.screen === only || f.status === only) : open;

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ todo: list }, null, 2));
} else {
  for (const f of list) {
    console.log(`[${ f.status.padEnd(15) }] ${ f.id }`);
    console.log(`    ${ f.name } (${ f.kind })`);
    if (f.defect) {
      console.log(`    defect: ${ f.defect }`);
    }
  }
  console.log(`\n${ list.length } open of ${ doc.features.length }`);
}
