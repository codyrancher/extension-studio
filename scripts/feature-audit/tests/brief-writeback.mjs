// Everything that writes BRIEF.md, held to the two properties three data-loss bugs bought.
//
// `brief-roundtrip.mjs` guards the read half: parsing a brief does not lose the criteria. This
// guards the write half, which is where the losses actually happened:
//
//   1. `brief.vue`'s autosave replaces only the sections the form owns and copies the rest
//      through byte for byte - including `## Verification`, the blank line above it, a footer,
//      and any section a person wrote by hand.
//   2. `verification.vue`'s accept-drift moves the sentence the term is in, not the whole line
//      it happens to share with other rules, and reports what stays so the screen can show it.
//
// Both are lifted out of the SFCs so the test runs the shipped code rather than a copy. No
// browser and no cluster: about a second.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '../../../pkg/barn/pages');

/** Pull named methods out of an Options API SFC and make them callable on one object. */
async function lift(file, names, prelude = '') {
  const src = readFileSync(file, 'utf8');
  const parts = names.map((name) => {
    const m = new RegExp(`\\n {4}${ name }\\(([^)]*)\\) \\{\\n([\\s\\S]*?)\\n {4}\\},\\n`).exec(src);

    if (!m) {
      throw new Error(`${ name } not found in ${ file } - has it been renamed?`);
    }

    return `  ${ name }(${ m[1] }) {\n${ m[2] }\n  },`;
  });
  const code = `${ prelude }\nexport const M = {\n${ parts.join('\n') }\n};\n`;

  return (await import(`data:text/javascript,${ encodeURIComponent(code) }`)).M;
}

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${ cond ? 'PASS' : 'FAIL' }  ${ name }${ cond ? '' : `\n        ${ detail }` }`);
  if (!cond) {
    failures++;
  }
};

// ---------------------------------------------------------------- screen 10, the autosave

const ROLES = ['Cluster operator', 'Support engineer', 'Platform admin', 'App developer'];
const brief = await lift(join(PKG, 'brief.vue'), [
  'parseBrief', 'briefDocument', 'ownedSections', 'criteriaBody', 'rolesBody', 'questionsBody',
  'reuseBody', 'after',
], `const ROLES = ${ JSON.stringify(ROLES) };`);

/** A component-shaped object with the file already read into it, as `load()` leaves it. */
const formFor = (text) => {
  const form = {
    extension: 'base',
    request:   '',
    problem:   '',
    who:       '',
    changes:   '',
    notDoing:  '',
    criteria:  [],
    ticked:    new Set(),
    roles:     [],
    questions: [],
    reuse:     [],
    placement: '',
    seededPlacement: false,
    agreedOn:  '',
    get filledCriteria() {
      return this.criteria.map((c) => c.trim()).filter(Boolean);
    },
    ...brief,
  };
  const s = form.parseBrief(text);

  ['request', 'problem', 'who', 'changes', 'notDoing'].forEach((k) => {
    if (s[k] !== undefined) {
      form[k] = s[k];
    }
  });

  if (s.criteria?.length) {
    form.criteria = s.criteria;
    form.ticked = new Set(s.criteria.filter((_, i) => s.criteriaTicked[i]));
  }

  ['roles', 'questions', 'reuse'].forEach((k) => {
    if (s[k]) {
      form[k] = s[k];
    }
  });

  form.agreedOn = s.agreedOn || '';
  form.seededPlacement = /^##\s+Where it appears\s*$/mi.test(text);

  return form;
};

// A brief that has been through the whole product: agreed (so it carries the footer), verified
// (so screen 13 has appended `## Verification`), and edited by hand underneath.
const FULL = `# base

## Who asked
Default Admin - 2026-08-20 - local://user-btc48

## What you were handed
A tab showing node condition history.

## The problem
Mid-incident an operator cannot tell a spike in node pressure apart from a slow
degradation, so they open Grafana or guess.

## Who has it
Whoever is on call, in the first two minutes of an incident.

## Written for
- Cluster operator

## What changes for them
A tab on the cluster page showing how node conditions trended.

## What we are deliberately not doing
No alerting, and no history beyond 24 hours. Both belong in monitoring.

## How we will know it worked
- [x] The tab appears under the cluster nav without a reload
- [ ] A 24-hour trend is readable at a glance

## Open questions
_none open_

## Prior art we are reusing
_nothing chosen_

## The challenge
The assistant argued with the ticket here.

## Where it appears
Parent route: \`c-cluster-explorer\`, because the trend belongs beside the cluster it is
about and nowhere else in the nav made sense.

---

Written in the Extension Studio before any code existed.

_Agreed in the Extension Studio on 2026-08-20._

## Verification

Verdict: **1 still to check**

Passed 1 of 2. Not looked at: 1.

### Criteria

- **Met**: The tab appears under the cluster nav without a reload
  > a note the reviewer typed
- **Not looked at**: A 24-hour trend is readable at a glance

## Afterword by a person
This paragraph is below the verification block and must survive.
`;

const same = formFor(FULL).briefDocument(FULL);

check('a brief nobody edited is written back byte for byte', same === FULL,
  `${ FULL.length } bytes in, ${ same.length } out`);

// The one that regressed: the footer was re-emitted with a blank line above it and none below,
// so an appended `## Verification` ended up welded to the agreed line.
check('the blank line above an appended ## Verification survives',
  /_Agreed in the Extension Studio on 2026-08-20\._\n\n## Verification/.test(same),
  same.slice(same.indexOf('_Agreed'), same.indexOf('## Verification') + 20));

check('the write is idempotent', formFor(same).briefDocument(same) === same);

const edited = (() => {
  const f = formFor(FULL);

  f.who = 'Whoever is on call, in the first two minutes.';

  return f.briefDocument(FULL);
})();
const changed = [];
const a = FULL.split('\n');
const bLines = edited.split('\n');

for (let i = 0; i < Math.max(a.length, bLines.length); i++) {
  if (a[i] !== bLines[i]) {
    changed.push(`${ i + 1 }: ${ JSON.stringify(a[i]) } -> ${ JSON.stringify(bLines[i]) }`);
  }
}

check('editing one owned field changes exactly one line', changed.length === 1, changed.join('\n        '));
check('the verification block is untouched by the edit',
  edited.includes(FULL.slice(FULL.indexOf('## Verification'))));

// ---------------------------------------------------------- screen 13, accepting scope drift

const verify = await lift(join(PKG, 'verification.vue'),
  ['driftPlan', 'sentences', 'sectionRange', 'closesSection']);

const plan = verify.driftPlan(FULL, 'alerting', 'accepted on 2026-08-23 by admin');

check('the sentence holding the term is what moves',
  plan.moving?.join('|') === 'No alerting, and no history beyond 24 hours.',
  JSON.stringify(plan.moving));
check('a second rule in the same line is left ruled out',
  plan.staying?.join('|') === 'Both belong in monitoring.', JSON.stringify(plan.staying));
check('the section is not emptied by accepting one term',
  !/## What we are deliberately not doing\n_not stated_/.test(plan.text || ''));
check('the accepted rule lands under What changes for them',
  /## What changes for them[\s\S]*?- No alerting, and no history beyond 24 hours\. \(accepted on 2026-08-23 by admin\)/
    .test(plan.text || ''));
check('accepting leaves the verification block alone',
  (plan.text || '').includes(FULL.slice(FULL.indexOf('## Verification'))));

const perLine = verify.driftPlan(`# x

## What changes for them
A tab.

## What we are deliberately not doing
- [ ] No alerting of any kind
- No history beyond 24 hours
`, 'alerting', 'stamp');

check('one rule per line still moves the whole rule',
  perLine.moving?.join('|') === 'No alerting of any kind', JSON.stringify(perLine.moving));
check('the neighbouring bullet is untouched',
  perLine.staying?.join('|') === 'No history beyond 24 hours', JSON.stringify(perLine.staying));
check('the checkbox does not travel into what the change does',
  !/- \[ \].*alerting/.test(perLine.text || ''));

check('a decimal is not a sentence boundary',
  verify.sentences('No alerting above 2.5 nodes. Both belong in monitoring.').length === 2);
check('a refusal comes back as data, not a throw',
  !!verify.driftPlan('# x\n\n## The problem\nA problem.\n', 'alerting', 's').error);

console.log(`\n${ failures === 0 ? 'ALL PASS' : `${ failures } FAILED` }`);
process.exit(failures ? 1 : 0);
