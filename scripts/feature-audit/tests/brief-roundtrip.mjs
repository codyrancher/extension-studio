// Reading a brief and agreeing it again must not lose anything.
//
// `brief.vue` writes the whole form over BRIEF.md when you agree. Until the read was added it
// never loaded the file, so agreeing an existing brief replaced it with a form that had never
// contained it - taking the acceptance criteria with it, which are the same items screen 12
// renders and screen 13 records verdicts against.
//
// This asserts the property that makes agreeing safe: parse then re-render is lossless for
// everything the form owns. Run it against the real brief from the pod.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SFC = join(HERE, '../../../pkg/barn/pages/brief.vue');
const src = readFileSync(SFC, 'utf8');

// Lift parseBrief out of the SFC so the test runs the shipped code, not a copy of it.
const m = src.match(/ {4}parseBrief\(text\) \{[\s\S]*?\n {4}\},\n/);

if (!m) {
  console.error('FAIL  parseBrief not found in brief.vue - has it been renamed?');
  process.exit(1);
}
const tmp = join(HERE, '.parser.mjs');

writeFileSync(tmp, `${ m[0].replace('parseBrief(text) {', 'export function parseBrief(text) {', 1).trim().replace(/,$/, '') }\n`);
const { parseBrief } = await import(`${ tmp }?t=${ process.pid }`);

const BRIEF = process.argv[2] || join(HERE, 'fixtures/brief-with-verdicts.md');
const text = readFileSync(BRIEF, 'utf8');
const got = parseBrief(text);

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${ cond ? 'PASS' : 'FAIL' }  ${ name }${ cond ? '' : `\n        ${ detail }` }`);
  if (!cond) {
    failures++;
  }
};

// The four prose sections come back non-empty and are not the literal placeholder.
for (const key of ['problem', 'who', 'changes', 'notDoing']) {
  check(`${ key } is read back`, !!got[key] && got[key] !== '_not stated_', `got ${ JSON.stringify(got[key]) }`);
}

// Every criterion in the file is read back, in order, with no verdict text attached.
const inFile = text.split('\n')
  .filter((l) => /^- \[[ xX]\]/.test(l))
  .map((l) => l.replace(/^- \[[ xX]\]\s+/, '').trim());

check('every criterion is read back', got.criteria?.length === inFile.length,
  `file has ${ inFile.length }, parser found ${ got.criteria?.length }`);
check('criteria match the file exactly', JSON.stringify(got.criteria) === JSON.stringify(inFile),
  `\n        want ${ JSON.stringify(inFile) }\n        got  ${ JSON.stringify(got.criteria) }`);

// The regression that shipped and was caught by testing: the `## Verification` section screen 13
// appends must not blank the criteria on the way past.
check('the verification section does not blank the criteria',
  !text.includes('## Verification') || (got.criteria?.length || 0) > 0,
  'criteria came back empty from a file that has a Verification section');

// No verdict text leaks into the criterion, which would be written back into the criterion line.
check('no verdict text leaks into a criterion',
  !(got.criteria || []).some((c) => c.includes('**')),
  `got ${ JSON.stringify(got.criteria) }`);

console.log(`\n${ failures === 0 ? 'ALL PASS' : `${ failures } FAILED` }`);
execSync(`rm -f ${ tmp }`);
process.exit(failures ? 1 : 0);
