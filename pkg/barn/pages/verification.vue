<script>
// Screen 13 · Verification - does it actually do the job? (Figma node 39:1109).
//
// The last screen in the review sequence, and the one that closes the loop the brief opened:
// the brief's acceptance criteria on the left, the running extension on the right, and a
// decision per criterion taken while looking at both.
//
// Real. The criteria are read out of BRIEF.md - the same file screen 10 wrote - so this is
// literally the checklist the author agreed to before any code existed. The preview is the
// extension's own dev server. The result is written back into the brief as ticked checkboxes
// and a verification block, so it lands in the repository next to the code rather than in a
// database this product does not have.
//
// Real, and worth being exact about, because both of these could be faked convincingly.
// "Show me" drives the preview on the right to the route the verdict was taken against - a real
// navigation of the real dev server, and the route is recorded in the brief beside the verdict
// so it survives a reload. "Ask the assistant to check" puts the outstanding criteria to the
// claude in this extension's pod; it answers in that conversation, in the workspace's terminal,
// and this screen says so rather than drawing an answer it does not have.
//
// The verdict itself is still a person's. Nothing here marks a criterion met on the assistant's
// say-so: it is asked, a person reads the answer, and a person presses the button.
import {
  SButton, SChip, SIcon, SEmpty, SBanner, SLabel, SBadge
} from '../components/ui';
import PreviewPanel from '../components/studio/PreviewPanel.vue';
import { toastSuccess, toastError } from '../toast';
import {
  ensureRepo,
  readExtensionFile, writeExtensionFile, extensionUrl, extensionReady, changedFiles, workingDiff,
  askAssistant, DEFAULT_EXTENSION
} from '../extensions';
import { REVIEW_QUEUE_ROUTE, BRIEF_ROUTE, EDITOR_ROUTE } from '../editor-product';
import '../design/tokens';
import fullBleed from '../design/full-bleed';

// The three segments of the verdict control (39:1232), in the order the design draws them.
//
// Four states, not three. "Can't tell" is an answer somebody gives, so it is a verdict of its
// own; the fourth state is the one before any of them, where nothing is pressed. Folding the
// two together - which is what an empty "Can't tell" did - loses the distinction the sign-off
// bar exists to make, and tells a screen reader that every criterion nobody has read yet is
// answered "Can't tell, pressed".
//
// The design draws three of the four: 39:1233 and 39:1287 are the saturated status fill a
// chosen segment gets, and 39:1330 is the weak wash on the row nobody has looked at. A
// deliberate "Can't tell" is that same selection rule in the hue this token set already keeps
// for "we do not know" - warning.
const VERDICTS = [
  { id: 'pass', label: 'Yes' },
  { id: 'fail', label: 'No' },
  { id: 'unsure', label: `Can't tell` },
];

/**
 * How a verdict is written into the `## Verification` block, and read back out of it.
 *
 * The checkbox line stays what it has always been: the human-readable record of met / not met,
 * in the syntax every other tool that opens a markdown checklist understands. It cannot carry
 * four states though - "No" and "Can't tell" are both an unticked box - so the block underneath
 * carries the full verdict, keyed by the criterion's own text, and `criteriaFrom` reconciles the
 * two on load. That is also what removes the index the old save walked, and with it the bug
 * where a checkbox anywhere else in the brief moved every verdict onto the wrong line.
 *
 * `- [?]` was the other way to do this and is not markdown: every renderer, linter and editor
 * that reads the file would either drop the line or draw it as literal text.
 */
const VERDICT_WORDS = {
  pass:   'Met',
  fail:   'Not met',
  unsure: 'Could not tell',
  '':     'Not looked at',
};

const WORD_VERDICTS = Object.fromEntries(
  Object.entries(VERDICT_WORDS).map(([id, word]) => [word.toLowerCase(), id])
);

/**
 * `- **Met** at `/c/local/explorer`: the dashboard lists every node`, as written by
 * `verificationBlock`.
 *
 * The route is optional in the pattern because it is optional in the fact: a verdict taken
 * before the preview was up has none, and a block written by the version of this screen that
 * did not record routes has none either. Everything between the verdict and the colon is the
 * route, so the criterion's own text - the key everything here reconciles on - is unchanged
 * either way.
 */
const VERDICT_LINE = /^-\s+\*\*(.+?)\*\*(?:\s+at\s+`([^`]*)`)?:\s*(.+)$/;

/**
 * Words too common to be evidence of anything.
 *
 * The scope check below looks for the brief's non-goals in the added lines of the diff, and a
 * diff of Vue components contains "return", "class" and "value" whatever it is about. Matching
 * on those would make the card fire on every change, which is the failure mode a warning has:
 * one that is always on is one nobody reads.
 */
const SCOPE_STOP = new Set([
  'about', 'after', 'again', 'against', 'anything', 'because', 'before', 'being', 'between',
  'class', 'const', 'could', 'every', 'first', 'function', 'import', 'inside', 'into', 'never',
  'other', 'return', 'should', 'still', 'their', 'there', 'these', 'thing', 'things', 'those',
  'value', 'where', 'which', 'while', 'without', 'would', 'yet',
  'rancher', 'extension', 'extensions', 'cluster', 'clusters', 'dashboard', 'screen', 'screens',
  'page', 'pages', 'user', 'users', 'anyone', 'nobody', 'doing', 'going',
]);

/** The heading the verdict list sits under, inside `## Verification`. */
const CRITERIA_HEADING = '### criteria';

/** Just the clock, for the provenance line under a criterion (39:1225). */
function clock(at) {
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default {
  name: 'BarnVerification',

  components: {
    SButton, SChip, SIcon, SEmpty, SBanner, SLabel, SBadge, PreviewPanel
  },

  mixins: [fullBleed],

  data() {
    return {
      brief:      '',
      criteria:   [],
      previewUrl: '',
      problem:    '',
      loading:    true,
      saving:     false,
      notes:      '',
      // The path the preview is showing, reported by the panel on the right. It is the route a
      // verdict is taken against, which is the auditable half of a tick - so it is copied onto
      // the criterion when the verdict is pressed, and lives there rather than here.
      route:      '',
      asking:     false,
      // What the change actually touched, for the scope card. Read once with the brief.
      changed:    [],
      diff:       '',
      VERDICTS,
    };
  },

  computed: {
    /**
     * The route names, exposed to the template.
     *
     * A plain `<script>` block's module scope is not the render function's scope, so an
     * imported constant named directly in the template resolves to undefined and
     * `$router.push({ name: undefined })` is dropped without an error. That is a button that
     * looks live and does nothing, silently - which is exactly how these were found.
     */
    routes() {
      return { REVIEW_QUEUE_ROUTE, BRIEF_ROUTE, EDITOR_ROUTE };
    },

    extension() {
      return this.$route.params.extension || DEFAULT_EXTENSION;
    },

    passed() {
      return this.criteria.filter((c) => c.verdict === 'pass').length;
    },

    failed() {
      return this.criteria.filter((c) => c.verdict === 'fail').length;
    },

    /** Looked at and could not be judged - which is not the same as not looked at. */
    unsure() {
      return this.criteria.filter((c) => c.verdict === 'unsure').length;
    },

    /** Nobody has answered these. Only the empty verdict counts here. */
    undecided() {
      return this.criteria.filter((c) => !c.verdict).length;
    },

    verdict() {
      if (!this.criteria.length) {
        return 'none';
      }

      if (this.failed) {
        return 'fail';
      }

      if (this.undecided) {
        return 'partial';
      }

      return this.unsure ? 'unsure' : 'pass';
    },

    verdictBadge() {
      return {
        pass: 'live', fail: 'failed', partial: 'building', unsure: 'unsaved', none: 'draft',
      }[this.verdict];
    },

    verdictLabel() {
      return {
        pass:    'Every criterion checked',
        fail:    `${ this.failed } not met`,
        partial: `${ this.undecided } still to check`,
        unsure:  `${ this.unsure } could not be judged`,
        none:    'No criteria',
      }[this.verdict];
    },

    /**
     * The sign-off sentence, which is where the four states have to be told apart: a criterion
     * somebody looked at and could not judge is a decision, and one nobody has opened yet is
     * an outstanding job, so they are counted separately and said separately.
     */
    signoffText() {
      if (!this.criteria.length) {
        return 'Nothing to sign off - this extension has no acceptance criteria.';
      }

      if (!this.failed && !this.unsure && !this.undecided) {
        return 'Every criterion met. Recording this ticks them off in the brief.';
      }

      // Every state that is true gets said, rather than the first branch that matches winning.
      // Ordered branches hid the failures behind the unlooked-at ones: one "No" and three
      // untouched read "0 of 4 met, 3 still to look at" here while the badge an inch away in
      // the same masthead read "1 not met".
      const parts = [`${ this.passed } of ${ this.criteria.length } met`];

      if (this.failed) {
        parts.push(`${ this.failed } not met`);
      }

      if (this.unsure) {
        parts.push(`${ this.unsure } could not be judged`);
      }

      if (this.undecided) {
        parts.push(`${ this.undecided } still to look at`);
      }

      // Only once there is nothing left to look at is a failure the thing being signed off.
      const tail = this.failed && !this.undecided ? ' Recording this says so in the brief.' : '';

      return `${ parts.join(', ') }.${ tail }`;
    },

    /** What the brief says this change is deliberately not doing, as written. */
    nonGoals() {
      const body = this.sectionOf(this.brief, 'What we are deliberately not doing');

      return body === '_not stated_' ? '' : body;
    },

    /**
     * The things the brief ruled out, as terms to look for.
     *
     * Backticked spans first, because a person who wrote `metrics-server` in a brief meant that
     * exact string; then the longest ordinary words, which are the ones carrying the meaning of
     * the sentence. Six at most - this is a search for evidence, not a dragnet.
     */
    nonGoalTerms() {
      const body = this.nonGoals;

      if (!body) {
        return [];
      }

      const spans = [...body.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim().toLowerCase());
      const words = (body.toLowerCase().match(/[a-z][a-z0-9-]{4,}/g) || [])
        .filter((w) => !SCOPE_STOP.has(w))
        .sort((a, b) => b.length - a.length);
      const seen = new Set();

      return [...spans, ...words]
        .filter((t) => t.length >= 4 && !seen.has(t) && seen.add(t))
        .slice(0, 6);
    },

    /**
     * The lines this change adds, with the file each one is in.
     *
     * Added lines only. A removed line mentioning something the brief ruled out is the change
     * getting *smaller*, which is the opposite of drift, and counting it would have the card
     * warn about work being taken out of scope.
     *
     * BRIEF.md is skipped, and skipping it is the difference between a check and a joke. The
     * brief is usually itself a new file in this working tree, so its own "we are not doing X"
     * sentence is an added line containing X - and every scope check would flag every brief for
     * saying what it says.
     */
    addedLines() {
      const out = [];
      let file = '';

      this.diff.split('\n').forEach((line) => {
        const header = /^\+\+\+ b\/(.+)$/.exec(line);

        if (header) {
          file = header[1].trim();
        } else if (line.startsWith('+') && !line.startsWith('+++') && file && file !== 'BRIEF.md') {
          out.push({ file, text: line.slice(1) });
        }
      });

      return out;
    },

    /**
     * Where the change touches something the brief said it would not.
     *
     * This is the only scope question this screen can answer honestly. "Files no criterion
     * mentions" was the other candidate and is not one: briefs are written about behaviour and
     * name no files at all, so every file would be flagged on every change and the card would
     * say the same thing forever. The non-goals section is different - it is the author's own
     * list of what is out of scope, in their own words, and a term from it turning up in the
     * lines this change adds is a real coincidence worth looking at.
     *
     * It is a word match and the card says so. It is evidence, not a verdict.
     */
    scopeDrift() {
      return this.nonGoalTerms
        .map((term) => {
          const files = [...new Set(this.addedLines
            .filter((l) => l.text.toLowerCase().includes(term))
            .map((l) => l.file))];

          return { term, files };
        })
        .filter((hit) => hit.files.length);
    },

    /** Which of the four things the scope card has to say. */
    scopeState() {
      if (!this.nonGoals) {
        return 'unstated';
      }

      if (!this.addedLines.length) {
        return 'nothing-changed';
      }

      return this.scopeDrift.length ? 'drifted' : 'clear';
    },

    changedLabel() {
      const n = this.changed.length;

      return `${ n } file${ n === 1 ? '' : 's' } changed`;
    },

    /**
     * Whoever is signed in, for the provenance line. Same getters the assistant panel uses -
     * the shell has no `auth/principal`, and the named user is not always fetched yet.
     */
    signedInAs() {
      const g = this.$store?.getters || {};
      const user = g['auth/user'] || g['auth/selfUser'];
      const named = user?.loginName || user?.username || user?.name;

      if (named) {
        return named;
      }

      const id = g['auth/principalId'] || '';
      const tail = String(id).split('://').pop();

      return tail && tail !== id ? tail : '';
    },
  },

  mounted() {
    this.load();
  },

  methods: {
    async load() {
      // A freshly created extension has no repository yet, and every reading on this screen
      // is a git reading - so without this the screen is simply empty, with nothing saying
      // why. Memoised and idempotent, so this costs one exec the first time and nothing after.
      await ensureRepo(this.extension).catch(() => {});

      this.loading = true;

      const [brief, changed, diff] = await Promise.all([
        readExtensionFile(this.extension, 'BRIEF.md').catch(() => ''),
        changedFiles(this.extension).catch(() => []),
        workingDiff(this.extension).catch(() => ''),
      ]);

      this.brief = brief;
      this.criteria = this.criteriaFrom(this.brief);
      this.problem = this.sectionOf(this.brief, 'The problem');
      this.changed = changed;
      this.diff = diff;
      this.loading = false;

      if (await extensionReady(this.extension).catch(() => false)) {
        this.previewUrl = extensionUrl(this.extension);
      }
    },

    /**
     * The criteria, with the verdicts the last save recorded already back on them.
     *
     * Two sources, reconciled on the criterion's own text: the checkbox says met or not met,
     * and the `## Verification` block says which kind of not-met it was. Without the second
     * half a "No" and a "Can't tell" both come back as an unticked box, which is why they used
     * to disappear the moment the save that recorded them reloaded the file.
     */
    criteriaFrom(brief) {
      const recorded = this.recordedVerdicts(brief);

      return this.criteriaLines(brief).map(({ text, ticked }) => {
        const queue = recorded.get(text) || [];
        const wrote = queue.length ? queue.shift() : { verdict: '', route: '' };

        return {
          text,
          // The box wins on "met", because the box is the half a person edits by hand. An
          // unticked box takes whatever the block recorded - unless the block said met, in
          // which case somebody has since unticked it and the record is stale.
          verdict: ticked ? 'pass' : (wrote.verdict === 'pass' ? '' : wrote.verdict),
          // Provenance for a verdict taken in this session (39:1225). The brief records the
          // verdict and the route, not who took it or when, so a criterion read back off the
          // file has no name and no clock - and the line says nothing rather than making
          // something up.
          taken:   '',
          // Where it was checked. Recorded in the file beside the verdict, so "Show me" still
          // knows where to point the preview a week later.
          route:   wrote.route || '',
        };
      });
    },

    /** Every `- [ ]` line under "How we will know it worked", in file order. */
    criteriaLines(brief) {
      return this.sectionOf(brief, 'How we will know it worked').split('\n')
        .map((l) => l.trim())
        .filter((l) => /^- \[[ xX]\]/.test(l))
        .map((l) => ({
          text:   l.replace(/^- \[[ xX]\]\s*/, '').trim(),
          ticked: /^- \[[xX]\]/.test(l),
        }));
    },

    /**
     * The verdicts the last save wrote, as criterion text to a queue of `{ verdict, route }`.
     *
     * A queue rather than a single value so two criteria worded identically still come back in
     * the order they appear, which is the only ordering left once the index is gone.
     */
    recordedVerdicts(brief) {
      const lines = brief.split('\n');
      const range = this.sectionRange(lines, 'Verification');
      const out = new Map();

      if (!range) {
        return out;
      }

      // Only under `### Criteria`. Notes are free text in the same section and a person is
      // perfectly entitled to write a bulleted list in them.
      let inList = false;

      for (let i = range.at; i < range.end; i++) {
        const line = lines[i].trim();

        if (/^#{3,}\s/.test(line)) {
          inList = line.toLowerCase() === CRITERIA_HEADING;
          continue;
        }

        const m = inList && VERDICT_LINE.exec(line);
        const verdict = m && WORD_VERDICTS[m[1].trim().toLowerCase()];

        if (!m || verdict === undefined) {
          continue;
        }

        const text = m[3].trim();

        out.set(text, [...(out.get(text) || []), { verdict, route: (m[2] || '').trim() }]);
      }

      return out;
    },

    /** A `##` heading, or the horizontal rule the brief template ends a block with. */
    closesSection(line) {
      const t = line.trim();

      return /^##\s/.test(t) || t === '---';
    },

    /**
     * Where one `## ` section lives in the file: its heading, and the half-open range of the
     * body under it.
     *
     * `###` is deliberately not a boundary - the verdict list lives under one - which is also
     * the difference between rewriting the Verification block and eating whatever a person
     * chose to put inside it.
     */
    sectionRange(lines, title) {
      const head = lines.findIndex((l) => l.trim().toLowerCase() === `## ${ title.toLowerCase() }`);

      if (head < 0) {
        return null;
      }

      const rest = lines.slice(head + 1);
      const next = rest.findIndex((l) => this.closesSection(l));

      return { head, at: head + 1, end: next < 0 ? lines.length : head + 1 + next };
    },

    sectionOf(brief, title) {
      const lines = brief.split('\n');
      const range = this.sectionRange(lines, title);

      return range ? lines.slice(range.at, range.end).join('\n').trim() : '';
    },

    /**
     * Answer a criterion, or take the answer back.
     *
     * Pressing the segment that is already pressed clears it, which is the toggle button's own
     * behaviour and the only way back to "nobody has looked at this" after a misclick.
     */
    set(criterion, verdict) {
      const off = criterion.verdict === verdict;

      criterion.verdict = off ? '' : verdict;
      criterion.taken = off ? '' : this.provenance();
      // The route the preview is on at the moment of the answer, which is the thing "Show me"
      // takes you back to. Taking the answer back takes the route with it: a route recorded
      // against no verdict is a claim that somebody checked something.
      criterion.route = off ? '' : this.route;
    },

    /** "Checked 12:41 · admin", or just the time when the shell has no name for the user. */
    provenance() {
      const at = `Checked ${ clock(new Date()) }`;

      return this.signedInAs ? `${ at } · ${ this.signedInAs }` : at;
    },

    /**
     * Write the verdict back into the brief.
     *
     * The boxes go back into the same `- [ ]` lines they came out of, and a Verification section
     * is written underneath. That means the record of whether this thing did its job lives in
     * the repository, in the file that said what the job was.
     */
    async save() {
      this.saving = true;

      try {
        await writeExtensionFile(this.extension, 'BRIEF.md', this.record(this.brief));
        toastSuccess(this.$store, 'Verification recorded', 'Written into BRIEF.md.');
        await this.load();
      } catch (e) {
        toastError(this.$store, 'Could not record the verification', e?.message || String(e));
      } finally {
        this.saving = false;
      }
    },

    /**
     * The brief with this pass recorded in it.
     *
     * Both writes are keyed on the criterion's own text and neither on its position. The version
     * this replaces walked every `- [ ]` in the whole file by index and ticked them in the order
     * it found them, which is only correct while the criteria section happens to hold the first
     * checkbox in the brief. "What we are deliberately not doing" is a list people write as
     * checkboxes, and one of those above the criteria moved every verdict onto somebody else's
     * line - silently, in a file that lives in git and is meant to be hand-edited.
     */
    record(brief) {
      const out = brief.split('\n');
      const criteria = this.sectionRange(out, 'How we will know it worked');
      const queued = new Map();

      this.criteria.forEach((c) => {
        queued.set(c.text, [...(queued.get(c.text) || []), c.verdict]);
      });

      // The boxes, inside the criteria section and nowhere else.
      for (let i = criteria?.at ?? 0; i < (criteria?.end ?? 0); i++) {
        const m = /^(\s*- )\[[ xX]\](\s*)(.*)$/.exec(out[i]);
        const queue = m && queued.get(m[3].trim());

        // A line this screen never showed - one added to the file since it loaded - keeps
        // whatever it says rather than being given some other criterion's answer.
        if (!m || !queue || !queue.length) {
          continue;
        }

        out[i] = `${ m[1] }[${ queue.shift() === 'pass' ? 'x' : ' ' }]${ m[2] }${ m[3] }`;
      }

      // The block, replaced in place where there is one already, so a section somebody wrote
      // after it survives - the previous version deleted everything from `## Verification` to
      // the end of the file.
      const block = this.verificationBlock();
      const previous = this.sectionRange(out, 'Verification');

      if (previous) {
        // The blank line the old block ended on belonged to its range, so put one back when
        // there is a section under it to be separated from.
        const gap = previous.end < out.length && out[previous.end].trim() ? [''] : [];

        out.splice(previous.head, previous.end - previous.head, ...block, ...gap);
      } else {
        while (out.length && !out[out.length - 1].trim()) {
          out.pop();
        }

        out.push('', ...block);
      }

      return `${ out.join('\n').replace(/\n+$/, '') }\n`;
    },

    /**
     * The `## Verification` section, as lines.
     *
     * Blank lines between the sentences because they are separate statements, not a wrapped
     * paragraph: run together they are one run-on line wherever the brief is rendered. The
     * verdict list under `### Criteria` is the structured half - one line per criterion, keyed
     * by its text - and it is what `criteriaFrom` reads back.
     */
    verificationBlock() {
      const counts = [`Passed ${ this.passed } of ${ this.criteria.length }.`];

      if (this.unsure) {
        counts.push(`Looked at and could not judge ${ this.unsure }.`);
      }

      if (this.undecided) {
        counts.push(`Not looked at: ${ this.undecided }.`);
      }

      const block = [
        '## Verification',
        '',
        `Verdict: **${ this.verdictLabel }**`,
        '',
        counts.join(' '),
        '',
        '### Criteria',
        '',
        ...this.criteria.map((c) => {
          const word = VERDICT_WORDS[c.verdict] ?? VERDICT_WORDS[''];
          const where = c.route ? ` at \`${ c.route }\`` : '';

          return `- **${ word }**${ where }: ${ c.text }`;
        }),
      ];

      if (this.notes.trim()) {
        block.push('', '### Notes', '', ...this.notes.trim().split('\n'));
      }

      return block;
    },

    /**
     * Put the criterion on the screen: drive the preview to the route it was checked against.
     *
     * Through the panel's own address field rather than by changing the `url` prop, because the
     * prop is the iframe's `src` and re-assigning the same value does not navigate - so the
     * second press, after you had wandered off somewhere else in the preview, would silently do
     * nothing. This is the same navigation typing the path into that field performs.
     *
     * With no route recorded there is nowhere specific to go, and the honest version of that is
     * to take the preview back to the extension's own start page and say why - not to disable
     * the button and leave somebody wondering which of the two of them is broken.
     */
    showMe(criterion) {
      const panel = this.$refs.preview;

      if (!this.previewUrl || !panel) {
        toastError(
          this.$store,
          'The dev server is still compiling, so there is nothing to drive yet.',
          { title: 'The preview is not up' }
        );

        return;
      }

      panel.address = criterion.route || '/';
      panel.go();

      if (!criterion.route) {
        toastSuccess(
          this.$store,
          'No route was recorded for this one, so the preview is back at the start. Answering a criterion records where you were when you answered it.',
          { title: 'Nowhere in particular to go' }
        );
      }
    },

    /**
     * Ask the assistant to check the criteria that are still open.
     *
     * The outstanding ones, because those are the question; if there are none left it is a
     * second opinion on all of them, which is a thing people ask for. Each one goes with the
     * route it was checked at, when there is one, because that is the difference between "check
     * the trend renders" and "check the trend renders on /c/local/barn".
     *
     * The screen does not move and nothing is ticked here. There are unsaved verdicts and notes
     * on this page, and an answer is not a verdict: it arrives in the extension's terminal, a
     * person reads it, and a person presses the button.
     */
    async askAssistantToCheck() {
      if (this.asking || !this.criteria.length) {
        return;
      }

      const open = this.criteria.filter((c) => !c.verdict);
      const asking = open.length ? open : this.criteria;
      const list = asking
        .map((c, i) => `(${ i + 1 }) ${ c.text }${ c.route ? ` [checked at ${ c.route }]` : '' }`)
        .join('; ');

      this.asking = true;

      try {
        const how = await askAssistant(this.extension, [
          `Check the ${ this.extension } extension against ${ open.length ? 'these outstanding acceptance criteria' : 'its acceptance criteria' }`,
          'and tell me, for each one, whether it is met and how you established that:',
          `${ list }.`,
          'The dev server for this extension is the one already running. Do not change any code',
          'and do not edit BRIEF.md - I record the verdicts myself.',
        ].join(' '));

        toastSuccess(
          this.$store,
          how === 'sent'
            ? `Asked about ${ asking.length } criteri${ asking.length === 1 ? 'on' : 'a' }. The answer arrives in the workspace terminal.`
            : 'The workspace session is not open yet, so this is the first thing it will be asked when it opens.',
          { title: 'Asked the assistant' }
        );
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'Could not ask the assistant' });
      } finally {
        this.asking = false;
      }
    },
  },
};
</script>

<template>
  <div class="verify">
    <!-- masthead -->
    <div class="verify__masthead">
      <SButton
        variant="ghost"
        size="sm"
        icon="chevronLeft"
        icon-only
        aria-label="Back to the queue"
        @click="$router.push({ name: routes.REVIEW_QUEUE_ROUTE })"
      />

      <div class="verify__name">
        <div class="verify__title">
          {{ extension }}
        </div>
        <div class="verify__eyebrow">
          Verification · does it actually do the job?
        </div>
      </div>

      <SBadge :status="verdictBadge" :label="verdictLabel" />

      <span class="verify__grow" />

      <SButton
        variant="ghost"
        size="sm"
        icon="book"
        @click="$router.push({ name: routes.BRIEF_ROUTE, params: { extension } })"
      >
        Open the brief
      </SButton>
    </div>

    <div class="verify__body">
      <!-- the checklist -->
      <div class="verify__list">
        <div class="verify__panel-head">
          <SIcon name="list" :size="14" />
          <span class="verify__panel-title">How we said we would know</span>
          <span class="verify__grow" />
          <SChip :label="`${ passed }/${ criteria.length }`" tone="subtle" />
        </div>

        <div class="verify__list-body">
          <SEmpty
            v-if="!loading && !criteria.length"
            icon="book"
            title="No acceptance criteria"
            message="This extension's brief has no checklist, or has no brief at all. Verification is checking a thing against what somebody said it should do - without that, there is nothing to check against."
          >
            <SButton
              variant="secondary"
              icon="book"
              @click="$router.push({ name: routes.BRIEF_ROUTE, params: { extension } })"
            >
              Write the brief
            </SButton>
          </SEmpty>

          <template v-else>
            <!-- what this pass is for, and what it is not (39:1212) -->
            <SBanner v-if="problem" type="success" class="verify__framing">
              <span class="verify__framing-lead">The problem this was for</span>
              <p class="verify__framing-text">
                {{ problem }}
              </p>
            </SBanner>

            <!-- one card, one row per criterion (39:1217) -->
            <div class="verify__criteria">
              <div
                v-for="(c, i) in criteria"
                :key="i"
                class="verify__criterion"
                :class="{
                  'verify__criterion--pass': c.verdict === 'pass',
                  'verify__criterion--fail': c.verdict === 'fail',
                }"
              >
                <span
                  class="verify__badge"
                  :class="`verify__badge--${ c.verdict || 'unanswered' }`"
                >
                  <SIcon v-if="c.verdict === 'pass'" name="check" :size="13" />
                  <SIcon v-else-if="c.verdict === 'fail'" name="close" :size="13" />
                  <template v-else>{{ i + 1 }}</template>
                </span>

                <div class="verify__criterion-main">
                  <p class="verify__criterion-text">
                    {{ c.text }}
                  </p>

                  <!-- where the verdict was taken, and by whom (39:1225) -->
                  <!--
                    `c.taken` alone, not `c.taken || route`. A running preview is not evidence
                    that anybody looked at this criterion, and the old test put the eye icon and
                    the route on all four rows the moment the preview came up - which invents
                    the one thing a provenance line exists to record.
                  -->
                  <div
                    v-if="c.taken || c.route"
                    class="verify__meta"
                  >
                    <SIcon name="eye" :size="12" />
                    <span v-if="c.taken">{{ c.taken }}</span>
                    <span
                      v-if="c.taken && c.route"
                      class="verify__meta-sep"
                    >·</span>
                    <span
                      v-if="c.route"
                      class="verify__meta-route"
                    >{{ c.route }}</span>
                  </div>
                </div>

                <div
                  class="verify__verdicts"
                  :class="{ 'verify__verdicts--unanswered': !c.verdict }"
                  role="group"
                  :aria-label="`Verdict for criterion ${ i + 1 }`"
                >
                  <button
                    v-for="v in VERDICTS"
                    :key="v.id"
                    type="button"
                    class="verify__verdict"
                    :class="c.verdict === v.id ? `verify__verdict--on-${ v.id }` : ''"
                    :aria-pressed="c.verdict === v.id"
                    @click="set(c, v.id)"
                  >
                    {{ v.label }}
                  </button>
                </div>

                <!-- 39:1239: the neutral button that puts the criterion on the screen -->
                <SButton
                  class="verify__show"
                  variant="neutral"
                  size="sm"
                  icon="play"
                  :title="c.route
                    ? `Drive the preview to ${ c.route }`
                    : 'No route recorded yet - takes the preview back to the start'"
                  @click="showMe(c)"
                >
                  Show me
                </SButton>
              </div>
            </div>

            <!-- has this grown past what it was for? (39:1336) -->
            <div class="verify__scope">
              <div class="verify__scope-head">
                <SIcon name="compare" :size="13" />
                <span class="verify__scope-title">Scope</span>
                <span class="verify__grow" />
                <SChip :label="changedLabel" tone="subtle" />
              </div>

              <SBanner v-if="scopeState === 'unstated'" type="info">
                The brief does not say what this was deliberately <em>not</em> doing, so there is
                nothing to measure the change against. Filling that section in is what makes this
                check possible on the next one.
              </SBanner>

              <SBanner v-else-if="scopeState === 'nothing-changed'" type="info">
                This change adds no lines outside the brief itself, so there is nothing to
                compare with what the brief ruled out.
              </SBanner>

              <SBanner v-else-if="scopeState === 'clear'" type="success">
                Nothing this change adds mentions
                <code v-for="t in nonGoalTerms" :key="t" class="verify__term">{{ t }}</code> -
                the words the brief used to say what it was not doing.
              </SBanner>

              <template v-else>
                <SBanner type="warning">
                  This change adds lines that mention what the brief said it was deliberately not
                  doing. A word match is not proof of anything - it is a place to look.
                </SBanner>

                <div class="verify__drift">
                  <div v-for="hit in scopeDrift" :key="hit.term" class="verify__drift-row">
                    <code class="verify__term">{{ hit.term }}</code>
                    <span class="verify__drift-files">{{ hit.files.join(', ') }}</span>
                  </div>
                </div>
              </template>
            </div>

            <div class="verify__notes">
              <SLabel text="Notes" />
              <textarea
                v-model="notes"
                class="verify__notes-input"
                rows="3"
                placeholder="Anything the checklist does not cover - what you tried, what surprised you."
              />
            </div>

            <SBanner type="info">
              Recording the result ticks these boxes in <strong>BRIEF.md</strong> and appends a
              verification block, so the record lives in the repository next to the code.
            </SBanner>
          </template>
        </div>
      </div>

      <!-- the thing being verified -->
      <div class="verify__preview">
        <div class="verify__panel-head">
          <SIcon name="eye" :size="14" />
          <span class="verify__panel-title">The extension, running</span>
          <span class="verify__grow" />
          <SButton
            variant="ghost"
            size="sm"
            icon="sparkle"
            @click="$router.push({ name: routes.EDITOR_ROUTE, params: { extension } })"
          >
            Back to the workspace
          </SButton>
        </div>

        <PreviewPanel
          v-if="previewUrl"
          ref="preview"
          class="verify__frame"
          :url="previewUrl"
          :extension="extension"
          @route="route = $event"
        />
        <SEmpty
          v-else
          icon="monitor"
          title="The preview is not up"
          message="The dev server is still compiling. You cannot verify what you cannot look at, so this waits for it."
        />
      </div>
    </div>

    <!-- sign-off bar (39:1391) -->
    <div class="verify__signoff">
      <SIcon name="user" :size="15" />
      <span class="verify__signoff-text">{{ signoffText }}</span>

      <span class="verify__grow" />

      <SButton
        variant="ghost"
        icon="sparkle"
        :loading="asking"
        :disabled="!criteria.length"
        @click="askAssistantToCheck"
      >
        Ask the assistant to check
      </SButton>
      <SButton
        variant="primary"
        icon="check"
        :loading="saving"
        :disabled="!criteria.length"
        @click="save"
      >
        Record the result
      </SButton>
    </div>
  </div>
</template>

<style lang="scss" scoped>
// 39:1232: the control's own box, and the numbers the segments below are cut from. Figma
// draws a stroke over a frame rather than inside its layout, so its three segments each fill
// the whole 216x30 - which in CSS means they overlap the border rather than sit inside it.
$verdicts-width:  216px;
$verdicts-height: 30px;
$verdicts-edge:   1px;

.verify {
  display:        flex;
  flex-direction: column;
  height:         100%;
  min-height:     0;
  background:     var(--studio-surface);

  &__masthead {
    display:       flex;
    align-items:   center;
    gap:           10px;
    padding:       10px var(--studio-space-16);
    border-bottom: 1px solid var(--studio-border);
    flex:          0 0 auto;
  }

  &__name { display: flex; flex-direction: column; gap: 1px; }
  &__title { font: var(--studio-heading-16); color: var(--studio-text); }

  &__eyebrow {
    font:           var(--studio-caption-11-caps);
    letter-spacing: var(--studio-tracking-caps);
    text-transform: uppercase;
    color:          var(--studio-text-tertiary);
  }

  &__grow { flex: 1 1 auto; }

  &__body {
    display:    flex;
    flex:       1 1 auto;
    min-height: 0;
  }

  // The criteria fill and the preview is the fixed one (39:1211 fill, 39:1355 fixed) - the
  // way round the design has it, and the way round the screen needs: pinning the criteria
  // wrapped every one of them onto two lines while the preview sat on spare width.
  &__list {
    display:        flex;
    flex-direction: column;
    // Basis 0, not auto: on auto the column asks for its content width and the pinned
    // preview next to it spends its whole shrink budget answering.
    flex:           1 1 0;
    min-width:      var(--studio-panel-main-min);
    min-height:     0;
  }

  &__preview {
    display:        flex;
    flex-direction: column;
    flex:           0 1 var(--studio-panel-assistant);
    min-width:      var(--studio-panel-assistant-min);
    border-left:    1px solid var(--studio-border);
    background:     var(--studio-surface-subtle);
    min-height:     0;
  }

  &__frame { flex: 1 1 auto; min-height: 0; }

  &__panel-head {
    display:       flex;
    align-items:   center;
    gap:           var(--studio-space-8);
    padding:       var(--studio-space-8) 14px;
    background:    var(--studio-surface-subtle);
    border-bottom: 1px solid var(--studio-border-subtle);
    color:         var(--studio-text-secondary);
    flex:          0 0 auto;
  }

  &__panel-title { font: var(--studio-heading-14); color: var(--studio-text); }

  &__list-body {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-12);
    // 39:1211. The app puts a panel head above this body that the design's frame does not
    // have, so the frame's top padding lands under that head.
    padding:        var(--studio-space-16) var(--studio-space-20) var(--studio-space-20);
    overflow-y:     auto;
    min-height:     0;
    flex:           1 1 auto;
  }

  // 39:1212: the green block that says what this pass is and is not. It is the Banner
  // component - a status wash behind a 4px bar - so it is drawn with one rather than
  // re-cut here.
  &__framing {
    :deep(.s-banner__body) {
      display:        flex;
      flex-direction: column;
      gap:            3px;
    }
  }

  &__framing-lead {
    font:  var(--studio-body-13-semi);
    color: var(--studio-text);
  }

  &__framing-text {
    font:   var(--studio-caption-12);
    color:  var(--studio-text-secondary);
    margin: 0;
  }

  // One card, its rows divided (39:1217) - not four cards. A checklist is one list.
  &__criteria {
    display:        flex;
    flex-direction: column;
    background:     var(--studio-surface);
    border:         1px solid var(--studio-border);
    border-radius:  var(--studio-radius);
    overflow:       hidden;
  }

  &__criterion {
    display:        flex;
    align-items:    flex-start;
    gap:            var(--studio-space-12);
    padding:        13px var(--studio-space-16);
    border-bottom:  1px solid var(--studio-border-subtle);

    &:last-child { border-bottom: none; }

    // Only the failing row is washed. A met criterion is marked by its badge going green;
    // tinting it as well makes a checklist that is mostly done unreadably loud.
    &--fail { background: var(--studio-error-bg); }
  }

  // 39:1220: the criterion's number, and where the answer shows up.
  &__badge {
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    width:           22px;
    height:          22px;
    flex:            0 0 22px;
    border-radius:   var(--studio-radius-pill);
    background:      var(--studio-surface-nav);
    color:           var(--studio-neutral);
    font:            var(--studio-caption-12-semi);

    // One hue per state, the same hue the chosen segment takes, so the badge and the control
    // never disagree about what was answered.
    // --studio-success, not --studio-green-500: the two are the same #3E8C4F in light, but
    // only the status token is lifted for dark, and a pass badge that stayed at the brand
    // value would sit a tier below the fail and unsure badges beside it.
    &--pass { background: var(--studio-success); color: var(--studio-on-success); }
    &--fail { background: var(--studio-error); color: var(--studio-on-error); }
    &--unsure { background: var(--studio-warning); color: var(--studio-on-warning); }
  }

  // The criterion and its provenance line - a column between the badge and the controls, so
  // the meta line sits under the text rather than beside the number.
  &__criterion-main {
    display:        flex;
    flex-direction: column;
    flex:           1 1 auto;
    gap:            var(--studio-space-4);
    min-width:      0;
  }

  // 39:1239, and the shell's 40px button minimum once more: on a row whose other control is
  // 30 tall, it is the button that has to give.
  &__show {
    flex:       0 0 auto;
    min-height: 0;
  }

  &__criterion-text {
    flex:   1 1 auto;
    font:   var(--studio-body-14);
    color:  var(--studio-text);
    margin: 0;
  }

  // 39:1225: how this criterion can be checked again - where it was looked at, and by whom
  // when we know. A tick nobody can retrace is not evidence of anything.
  &__meta {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-6);
    font:        var(--studio-caption-12);
    color:       var(--studio-text-tertiary);
    min-width:   0;
  }

  &__meta-sep { color: var(--studio-border-strong); }

  &__meta-route {
    font:          var(--studio-mono-11);
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  // 39:1232: one joined control, not two buttons. Three segments, because "I looked and I
  // cannot tell" is an answer and the screen has to let somebody give it.
  &__verdicts {
    display:       flex;
    width:         $verdicts-width;
    height:        $verdicts-height;
    flex:          0 0 auto;
    background:    var(--studio-surface);
    border:        $verdicts-edge solid var(--studio-border);
    border-radius: var(--studio-radius);
    // `clip`, with `hidden` under it for anything that does not know the keyword. They trim
    // identically - both at the padding box - but `hidden` makes the element a scroll
    // container that merely refuses a scrollbar, and `clip` makes it one that cannot scroll
    // at all. That distinction is the whole bug: it was focus scrolling, not painting, that
    // clipped a segment and ate the right border when the third one was clicked. The segments
    // no longer overflow, and now nothing they might do could scroll this either.
    overflow:      hidden;
    overflow:      clip;

    // 39:1330: the row nobody has answered wears the wash across the whole control, rather
    // than one segment looking chosen. Fill, edge and label all come from the empty-control
    // tokens, which is what makes the state survive the dark theme - see studio.css: the
    // frame's three light values leave it reading as a disabled control on a dark panel.
    &--unanswered {
      background:   var(--studio-control-empty);
      border-color: var(--studio-control-empty-border);

      .verify__verdict { color: var(--studio-control-empty-text); }
    }
  }

  &__verdict {
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    // 39:1233: the segment is layoutSizing FILL on both axes, so it is a share of what the
    // control has rather than a number of its own.
    //
    // `1 1 0`, not `0 0 216/3`. The control is border-box 216 wide with a 1px stroke, so its
    // content box is 214 and three 72s overflow it by 2. That made the control a scroll
    // container: clicking the third segment scrolled it 2px to bring focus into view, which
    // clipped "Yes" and ate the right border, on that row, permanently. A share divides what
    // is actually there - 71.33 each - and cannot be wrong about the border.
    //
    // The negative margins stay, and they are the vertical half of the same problem: the
    // segment is full height (30) inside a 28px content box, so without them it overflows the
    // other axis by the same 2px it used to overflow this one. Pulling it over the horizontal
    // border makes its margin box 28 and the control scrolls in neither direction.
    flex:            1 1 0;
    height:          $verdicts-height;
    margin:          (-$verdicts-edge) 0;
    padding:         0;
    border:          none;
    // The shell's 40px minimum for touch targets, again: on a 30px control it pushes 5px of
    // segment out through the top and bottom of the border.
    min-height:      0;
    background:      transparent;
    color:           var(--studio-text-secondary);
    font:            var(--studio-caption-12-semi);
    cursor:          pointer;

    &:hover { background: var(--studio-surface-subtle); }

    // A chosen segment is the status fill with the ink that fill can carry (39:1233, 39:1287)
    // - one rule, three hues, including the one the design never had a sample of. The frame
    // draws white on all three and none of the three clears 4.5:1 at 12px/600; see
    // --studio-on-status for the arithmetic.
    &--on-pass,
    &--on-pass:hover { background: var(--studio-success); color: var(--studio-on-success); }

    &--on-fail,
    &--on-fail:hover { background: var(--studio-error); color: var(--studio-on-error); }

    &--on-unsure,
    &--on-unsure:hover { background: var(--studio-warning); color: var(--studio-on-warning); }
  }

  // 39:1336: the card that asks whether the change is still the change the brief describes.
  &__scope {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-8);
    padding:        var(--studio-space-12) 14px 14px;
    background:     var(--studio-surface);
    border:         1px solid var(--studio-border);
    border-radius:  var(--studio-radius);
  }

  &__scope-head {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
    color:       var(--studio-text-tertiary);
  }

  &__scope-title {
    font:  var(--studio-heading-14);
    color: var(--studio-text);
  }

  &__term {
    font:          var(--studio-mono-12);
    background:    var(--studio-surface-subtle);
    border:        1px solid var(--studio-border-subtle);
    border-radius: var(--studio-radius-control);
    padding:       1px 4px;
    margin:        0 2px;
  }

  &__drift {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-6);
  }

  &__drift-row {
    display:     flex;
    align-items: baseline;
    gap:         var(--studio-space-8);
    min-width:   0;
  }

  &__drift-files {
    flex:      1 1 auto;
    min-width: 0;
    font:      var(--studio-body-13);
    color:     var(--studio-text-secondary);
    word-break: break-word;
  }

  &__notes {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-4);
  }

  &__signoff {
    display:     flex;
    align-items: center;
    gap:         10px;
    padding:     var(--studio-space-12) var(--studio-space-20);
    border-top:  1px solid var(--studio-border);
    color:       var(--studio-text-tertiary);
    flex:        0 0 auto;
  }

  &__signoff-text {
    font:  var(--studio-body-13);
    color: var(--studio-text-secondary);
  }

  &__notes-input {
    padding:       10px var(--studio-space-12);
    background:    var(--studio-surface);
    border:        1px solid var(--studio-border);
    border-radius: var(--studio-radius);
    outline:       none;
    resize:        vertical;
    font:          var(--studio-body-14);
    color:         var(--studio-text);

    &:focus { border-color: var(--studio-border-focus); }
    &::placeholder { color: var(--studio-text-tertiary); }
  }
}
</style>
