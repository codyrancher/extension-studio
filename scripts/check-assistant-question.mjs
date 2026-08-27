// The question parser, checked against real captures.
//
// A plain script rather than a jest spec: jest does not run in this repo (its babel config is
// missing a plugin), and a spec that cannot be run is worse than none. Node 24 strips the types
// off the import, so this runs the shipped file rather than a copy of it.
//
//   node scripts/check-assistant-question.mjs
//
// Both fixtures came out of a pod through the same `tr -cd` the reader uses, which is why there
// is no selection caret and no box drawing in them.
import { parseQuestion } from '../pkg/extension-studio/assistant-question.ts';

const SURVEY = `
  Read 1 file, listed 1 directory, ran 1 shell command

● How is Claude doing this session? (optional)
  1: Bad    2: Fine   3: Good   0: Dismiss
   Auto-update failed: no write permission to npm prefix
`;
const MODEL = `
 /clear

   Select model
   Switch between Claude models. Your pick becomes the default for new
   sessions. For other/previous model names, specify with --model.

    1. Default (recommended)   Opus 5 with 1M context  Best for everyday,
                                 complex tasks
     2. Opus (1M context)        Opus 5 with 1M context  Best for everyday,
                                 complex tasks
    3. Fable                    Fable 5  Most capable for your hardest and
                                 longest-running tasks
       +2 models

   Enter to set as default  s to use this session only  Esc to cancel
`;
const PROSE = `
● Here is what I am about to do:

  1. Read pages/Home.vue
  2. Change the heading
  3. Commit it

  Working on it now.
`;
const IDLE = `
   Claude Code v2.1.246
  Opus 5 (1M context)  Claude Max

   bypass permissions on (shift+tab to cycle)   for agents
`;

let pass = 0, fail = 0;
const check = (name, cond, got) => { if (cond) { pass++; console.log('  ok   ', name); } else { fail++; console.log('  FAIL ', name, '->', JSON.stringify(got)); } };

const s = parseQuestion(SURVEY);
check('survey detected', !!s, s);
check('survey title', s?.title === 'How is Claude doing this session? (optional)', s?.title);
check('survey keys', JSON.stringify(s?.options.map(o => o.key)) === '["1","2","3","0"]', s?.options);
check('survey labels', JSON.stringify(s?.options.map(o => o.label)) === '["Bad","Fine","Good","Dismiss"]', s?.options?.map(o=>o.label));

const m = parseQuestion(MODEL);
check('model menu detected', !!m, m);
check('model title', m?.title === 'Select model', m?.title);
check('model label is the name only', m?.options?.[0]?.label === 'Default (recommended)', m?.options?.[0]);
check('model hint keeps the rest', (m?.options?.[0]?.hint || '').includes('Opus 5 with 1M context'), m?.options?.[0]?.hint);
check('model keys', JSON.stringify(m?.options.map(o => o.key)) === '["1","2","3"]', m?.options?.map(o=>o.key));
check('model footer', (m?.keys || []).join(' ').includes('Esc to cancel'), m?.keys);

check('prose is not a menu', parseQuestion(PROSE) === null, parseQuestion(PROSE));
check('idle pane is not a menu', parseQuestion(IDLE) === null, parseQuestion(IDLE));
check('empty pane', parseQuestion('') === null, parseQuestion(''));
check('scrolled-away menu ignored', parseQuestion(MODEL + '\n' + 'output\n'.repeat(20)) === null, 'detected');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
