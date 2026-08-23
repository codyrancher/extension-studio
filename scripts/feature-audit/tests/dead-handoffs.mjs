// A screen that hands the next screen a query parameter nobody reads.
//
// This is a class of defect, not one bug. The navigation happens, so the control looks like it
// worked; the instruction it carried is dropped on the floor. The audit found three at once:
//
//   brief.vue        -> editor  ?brief=1        "the workspace picks the brief up and sends it to
//                                                the assistant as the first instruction"
//   review.vue       -> editor  ?publish=local  publish again after reviewing
//   build-failed.vue -> editor  ?publish=local  "Try the publish again"
//
// None of the three was read anywhere. Two verifiers found two of them independently, from
// different screens, which is how it became clear this was a pattern rather than an oversight.
//
// So: every query key the product hands over must be read somewhere, or be listed below with a
// reason. Static check, no browser, runs in a second.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '../../../pkg/barn');

// Keys that are deliberately written and never read, with the reason. Empty, and it should stay
// that way: a handoff nobody reads is almost always a feature that was never finished.
const ALLOWED = {};

const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') {
      continue;
    }
    const p = join(dir, e.name);

    if (e.isDirectory()) {
      walk(p);
    } else if (/\.(vue|ts)$/.test(e.name)) {
      files.push(p);
    }
  }
};

walk(SRC);

const written = new Map();
const read = new Set();

for (const f of files) {
  const text = readFileSync(f, 'utf8');
  const rel = f.slice(SRC.length + 1);

  // `query: { key: ... }` and `query: { key }` on a router push.
  for (const m of text.matchAll(/query:\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const key = part.split(':')[0].trim();

      if (/^[a-zA-Z][a-zA-Z0-9]*$/.test(key)) {
        written.set(key, [...(written.get(key) || []), rel]);
      }
    }
  }

  for (const m of text.matchAll(/\$route\.query\.([a-zA-Z][a-zA-Z0-9]*)/g)) {
    read.add(m[1]);
  }
  for (const m of text.matchAll(/route\.query\[['"]([a-zA-Z][a-zA-Z0-9]*)['"]\]/g)) {
    read.add(m[1]);
  }
}

let failures = 0;

for (const [key, where] of [...written.entries()].sort()) {
  if (read.has(key) || key in ALLOWED) {
    console.log(`PASS  ?${ key } is read`);
    continue;
  }
  failures++;
  console.log(`FAIL  ?${ key } is handed over by ${ where.join(', ') } and read by nothing`);
}

console.log(`\n${ failures === 0 ? 'ALL PASS' : `${ failures } dead handoff${ failures === 1 ? '' : 's' }` } (${ written.size } keys checked)`);
process.exit(failures ? 1 : 0);
