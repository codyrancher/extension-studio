<script>
// Screen 04 · Review changes before publishing (Figma node 14:285).
//
// The gate in front of publishing: a list of what changed, the diff of whichever file is
// selected, and a rail explaining it. Three panels and an action bar.
//
// Real: the file list (git status in the pod, with the same line counts screen 12 shows), each
// file's diff, Discard all (checkout plus clean), the tick box in front of every file, Keep and
// continue building (back to the workspace), Publish - which is the same publish the workspace's
// button runs - and the rail's reading of the diff.
//
// Two points, and the screen used to confuse them. The list is `changedFiles`, measured from the
// baseline - the last version handed over or published, and only HEAD when there has never been
// one - while a discard puts the *working tree* back to HEAD. On an extension that has been
// published, a file can differ from the baseline purely because somebody committed it, and no
// discard can undo a commit. So the discard controls are aimed at what they can actually reach
// (`discardable`), the rest is named as already committed, and the toast afterwards reports what
// is still listed rather than claiming the screen is empty. See `readStates`.
//
// The tick box decides what survives. Unticking a file marks it for reverting, and leaving the
// screen is what carries that out - which is what the design's caption under the list says in
// words (14:424), and why the caption is not decoration: it is the whole warning. The intent is
// kept in sessionStorage so a reload does not silently forget it, and every exit goes through
// one route guard so the back arrow, the rail and the action bar all mean the same thing.
//
// The rail is worth being exact about. The design has the assistant explain each change in prose
// beside its diff (14:509, "What this change does": what was added, what was replaced, what was
// not touched). Nothing writes that prose, so the rail derives those three from the diff on
// screen - counts, hunks and the declarations the added and removed lines carry - and every
// sentence in it is a reading of the patch rather than a guess at intent. Why the change was
// made is not in a diff and the rail says so rather than inventing it: that question goes to the
// one claude this extension has, in the workspace terminal, where it can be argued with.
import {
  SButton, SBadge, SChip, SIcon, SEmpty, SBanner, SModal
} from '../components/ui';
import DiffView from '../components/DiffView.vue';
import { toastSuccess, toastError } from '../toast';
import {
  ensureRepo,
  changedFiles, fileDiff, discardChanges, listBranches, askAssistant,
  baselineRef, changeProvenance, fileProvenance, DEFAULT_EXTENSION
} from '../extensions';
import { sameCommit } from '../review';
import { EDITOR_ROUTE, STUDIO_ROUTE } from '../editor-product';
import '../design/tokens';
import fullBleed from '../design/full-bleed';

// Where the unticked paths are remembered between renders of this screen.
//
// sessionStorage rather than the pod, because losing it is safe in the only direction that
// matters: the files are still there and still listed, and the worst case is that somebody has
// to untick a box again. Persisting it at all is what stops a reload quietly re-ticking every
// box while the action bar's promise ("2 of 3 files will be kept") is still on the screen.
const UNKEPT_KEY = 'barn.review.unkept';

/**
 * What a line of a diff declares, in words, or '' for a line that declares nothing.
 *
 * Read off the text of the added and removed lines themselves, which is the only honest source
 * a page has: it is what is in the patch, not what the patch was for. Two dialects, because a
 * `#` opens a heading in markdown and a comment nearly everywhere else.
 */
const CODE_DECLARATIONS = [
  [/^\s*export\s+default\b/, () => 'the default export'],
  [/^\s*(?:export\s+)?(?:async\s+)?function\s+([\w$]+)/, (m) => `${ m[1] }()`],
  [/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([\w$]+)/, (m) => `class ${ m[1] }`],
  [/^\s*(?:export\s+)?interface\s+([\w$]+)/, (m) => `interface ${ m[1] }`],
  [/^\s*(?:export\s+)?type\s+([\w$]+)\s*=/, (m) => `type ${ m[1] }`],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=/, (m) => m[1]],
  [/^\s*import\s+.*\sfrom\s+['"]([^'"]+)['"]/, (m) => `an import of ${ m[1] }`],
  [/^\s*<(template|script|style)\b/, (m) => `the <${ m[1] }> block`],
];

const TEXT_DECLARATIONS = [
  [/^\s*(#{1,6})\s+(.{1,60})$/, (m) => `the heading "${ m[2].trim() }"`],
  [/^\s*-\s+\[[ xX]\]\s+(.{1,60})$/, (m) => `the checklist item "${ m[1].trim() }"`],
];

function declarationsIn(lines, path) {
  const rules = /\.(md|markdown|txt)$/i.test(path) ? TEXT_DECLARATIONS : CODE_DECLARATIONS;
  const out = [];

  lines.forEach((line) => {
    for (const [pattern, say] of rules) {
      const m = pattern.exec(line);

      if (m) {
        const said = say(m);

        if (said && !out.includes(said)) {
          out.push(said);
        }

        return;
      }
    }
  });

  return out;
}

/** `a`, `a and b`, `a, b and c`, `a, b, c and 4 more`. */
function list(items, cap = 3) {
  const shown = items.slice(0, cap);
  const rest = items.length - shown.length;

  if (rest > 0) {
    shown.push(`${ rest } more`);
  }

  if (shown.length < 2) {
    return shown[0] || '';
  }

  return `${ shown.slice(0, -1).join(', ') } and ${ shown[shown.length - 1] }`;
}

const plural = (n, word) => `${ n } ${ word }${ n === 1 ? '' : 's' }`;

export default {
  name: 'BarnReview',

  components: {
    SButton, SBadge, SChip, SIcon, SEmpty, SBanner, SModal, DiffView
  },

  mixins: [fullBleed],

  data() {
    return {
      files:    [],
      selected: '',
      patch:    '',
      branch:   '',
      loading:  true,
      diffing:  false,
      discarding: false,
      asking:   false,
      // The paths still ticked in the file list (14:395). Everything is kept until somebody
      // says otherwise, which is what makes the default row of the action bar honest.
      kept:     [],
      // Which point the list is measured from, and where HEAD is. The two are the same thing on
      // an extension nobody has published, and that is the case where a discard does empty the
      // screen. See the note at the top of this file.
      baseline: {
        kind: '', ref: '', sha: '', label: '',
      },
      head:     '',
      // path -> `fileProvenance` state, read only when the baseline and HEAD are different
      // commits. Empty otherwise, which is the common case and means "every listed file is
      // uncommitted", because a diff from HEAD is exactly the working tree.
      states:   {},
      // Whether the "are you sure" in front of publishing is up. The action bar's label ends in
      // an ellipsis (14:548) and an ellipsis is a promise: this is the step it promises.
      confirmingPublish: false,
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
      return { STUDIO_ROUTE };
    },

    extension() {
      return this.$route.params.extension || DEFAULT_EXTENSION;
    },

    count() {
      return this.files.length;
    },

    summary() {
      if (!this.count) {
        return 'Nothing has changed since the last commit.';
      }

      return `These changes are running in your preview only. ${ this.kept.length } of ${ this.count } file${ this.count === 1 ? '' : 's' } will be kept.`;
    },

    /** The paths whose box has been cleared: the ones the discard is being aimed at. */
    unkept() {
      return this.files.map((f) => f.path).filter((p) => !this.kept.includes(p));
    },

    /**
     * The listed files a discard can actually reach.
     *
     * A discard restores the working tree to HEAD, so it reaches a file only if the copy on
     * disk differs from HEAD. `fileProvenance` reports exactly that: `committed` is a path git
     * status has nothing to say about, which means it is in this list because of a commit and
     * nothing this screen does can take it back out.
     *
     * `states` is empty whenever the baseline is HEAD, and then every listed file is reachable
     * by construction - that is the same reading twice.
     */
    discardable() {
      return this.files.map((f) => f.path).filter((p) => this.states[p] !== 'committed');
    },

    /** The other half: listed, and already committed, so a discard cannot touch it. */
    committed() {
      return this.files.map((f) => f.path).filter((p) => this.states[p] === 'committed');
    },

    /**
     * What Discard actually throws away.
     *
     * With boxes cleared it is those files and only those. With every box still ticked there is
     * no selection to honour, so it stays what it has always been - the whole working tree -
     * rather than becoming a button that cannot be pressed.
     *
     * Narrowed to what a discard can reach either way, so the button's count is the number of
     * files that will actually change rather than the number on the list.
     */
    discardTargets() {
      const aimed = this.unkept.length ? this.unkept : this.files.map((f) => f.path);

      return aimed.filter((p) => this.discardable.includes(p));
    },

    discardLabel() {
      const n = this.discardTargets.length;

      if (!n) {
        return 'Nothing to discard';
      }

      return n === this.count ? 'Discard all' : `Discard ${ n }`;
    },

    /**
     * Why the list will not empty, said before the button is pressed rather than after.
     *
     * The label alone ("Discard 1" over a list of three) raises the question without answering
     * it. This answers it in the terms the reader can check: which point the list is measured
     * from, and the fact that a discard aims at a different one.
     */
    committedNote() {
      const n = this.committed.length;

      if (!n) {
        return '';
      }

      return `${ n } of these ${ this.count } files ${ n === 1 ? 'is' : 'are' } already committed - this list is ${
        this.baseline.label || 'measured from the last published version' }, and discarding puts the working tree back to the last commit. A commit cannot be discarded, so ${
        n === 1 ? 'it stays' : 'they stay' } listed.`;
    },

    /**
     * The masthead badge.
     *
     * Unsaved means there is work on disk that no commit holds. A tree whose every listed file
     * is committed is not unsaved, it is unpublished, which is what Draft says - and it is the
     * state the screen is in the moment a discard succeeds on an extension with a baseline
     * behind HEAD.
     */
    badge() {
      if (!this.count) {
        return 'live';
      }

      return this.discardable.length ? 'unsaved' : 'draft';
    },

    /**
     * The size of the whole change: files, lines in, lines out (14:389, "3 changed files +128 -4").
     *
     * The same numbers the rows carry, added up, so the header and the list can never disagree.
     * Untracked files count too - `changedFiles` measures them against /dev/null - which is what
     * makes this the size of the change rather than the size of the tracked half of it.
     */
    totals() {
      return this.files.reduce(
        (sum, f) => ({ added: sum.added + (f.added || 0), removed: sum.removed + (f.removed || 0) }),
        { added: 0, removed: 0 }
      );
    },

    totalsLabel() {
      const parts = [];

      if (this.totals.added) {
        parts.push(`+${ this.totals.added }`);
      }

      if (this.totals.removed) {
        parts.push(`-${ this.totals.removed }`);
      }

      return parts.join(' ');
    },

    selectedFile() {
      return this.files.find((f) => f.path === this.selected) || null;
    },

    /**
     * What the patch on screen actually says, as numbers.
     *
     * Parsed from the unified diff rather than from `changedFiles`, so it describes the file
     * being looked at and stays right while the diff is being re-read.
     */
    patchFacts() {
      const facts = {
        added: 0, removed: 0, hunks: 0, isNew: false, isDeleted: false, addedLines: [], removedLines: [],
      };

      this.patch.split('\n').forEach((line) => {
        if (line.startsWith('@@')) {
          facts.hunks++;

          return;
        }

        if (line.startsWith('new file mode')) {
          facts.isNew = true;

          return;
        }

        if (line.startsWith('deleted file mode')) {
          facts.isDeleted = true;

          return;
        }

        // The header lines start with the same characters the content lines do, so they are
        // taken out before anything is counted.
        if (/^(diff |index |--- |\+\+\+ |similarity |rename |old mode|new mode|Binary )/.test(line)) {
          return;
        }

        if (line.startsWith('+')) {
          facts.added++;
          facts.addedLines.push(line.slice(1));
        } else if (line.startsWith('-')) {
          facts.removed++;
          facts.removedLines.push(line.slice(1));
        }
      });

      return facts;
    },

    /**
     * The three headed paragraphs the design asks for (14:518, 14:521, 14:524), derived.
     *
     * Every sentence here is a reading of the patch: how much arrived, how much went, what the
     * lines declare, and what the change does not reach. Nothing in it claims to know why, which
     * is the one thing a diff cannot tell anybody - see the banner above it.
     */
    explanation() {
      const file = this.selectedFile;

      if (!file || !this.patch.trim()) {
        return [];
      }

      const f = this.patchFacts;
      const path = file.path;
      const added = declarationsIn(f.addedLines, path);
      const removed = declarationsIn(f.removedLines, path).filter((d) => !added.includes(d));
      const others = this.files.filter((o) => o.path !== path).map((o) => o.path);

      const arrived = [];

      if (f.isNew) {
        arrived.push(`${ path } is new. The whole file is ${ plural(f.added, 'line') } of it.`);
      } else if (f.added) {
        arrived.push(`${ plural(f.added, 'line') } added, in ${ plural(f.hunks, 'place') } in the file.`);
      } else {
        arrived.push('Nothing was added. This change only takes lines out.');
      }

      if (added.length) {
        arrived.push(`The new lines bring in ${ list(added) }.`);
      }

      const replaced = [];

      if (f.isDeleted) {
        replaced.push(`${ path } is gone: all ${ plural(f.removed, 'line') } of it.`);
      } else if (!f.removed) {
        replaced.push('Nothing. Every line in this change is new, so no existing line was rewritten or dropped.');
      } else {
        replaced.push(`${ plural(f.removed, 'line') } taken out.`);

        if (f.added) {
          replaced.push('Git counts a rewritten line as one out and one in, so some of those are edits rather than deletions.');
        }
      }

      if (removed.length) {
        replaced.push(`What is no longer there: ${ list(removed) }.`);
      }

      const untouched = [];

      if (!f.isNew && !f.isDeleted) {
        untouched.push(`Outside those ${ plural(f.hunks, 'place') }, ${ path } is unchanged.`);
      }

      untouched.push(others.length
        ? `${ plural(others.length, 'other file') } changed in this working tree - ${ list(others) } - and this panel is about ${ path } only.`
        : 'Nothing else in the working tree has changed.');

      return [
        { title: 'What was added', body: arrived.join(' ') },
        { title: 'What was replaced', body: replaced.join(' ') },
        { title: 'What is not touched', body: untouched.join(' ') },
      ];
    },

    /**
     * What the rail asks about the file on screen.
     *
     * Named after the file rather than "explain the change", because the conversation in the pod
     * has been editing this tree all session and "the change" is ambiguous to it in a way a path
     * is not. The last clause is the one that matters: this is a review screen, and a question
     * that came back as an edit would change what is being reviewed underneath the reviewer.
     */
    explainPrompt() {
      const file = this.selectedFile;

      if (!file) {
        return '';
      }

      return `In the working tree of the ${ this.extension } extension, explain the ${ file.status } file ${ file.path }: what the change does, why it was made, and anything in it a reviewer should question. Explain it here in the terminal and do not edit any files.`;
    },
  },

  watch: {
    selected: 'loadDiff',
    extension: 'load',
  },

  mounted() {
    this.load();
  },

  /**
   * Leaving is what carries out the ticks.
   *
   * One guard rather than a handler per button, because "when you leave this screen" has to
   * mean every way out of it - the action bar, the back arrow, the nav rail, the browser's own
   * back button - or the caption under the list is only true some of the time.
   *
   * It never blocks the navigation. A discard that fails says so in a toast and the files stay;
   * refusing to let somebody off the screen because git had a bad moment would be worse than
   * the thing it was protecting.
   */
  async beforeRouteLeave(to, from, next) {
    await this.revertUnkept();
    next();
  },

  methods: {
    async load() {
      // A freshly created extension has no repository yet, and every reading on this screen
      // is a git reading - so without this the screen is simply empty, with nothing saying
      // why. Memoised and idempotent, so this costs one exec the first time and nothing after.
      await ensureRepo(this.extension).catch(() => {});

      this.loading = true;

      const [files, branches, baseline, provenance] = await Promise.all([
        changedFiles(this.extension).catch(() => []),
        listBranches(this.extension).catch(() => null),
        // Which point the list is measured from, and where HEAD is. Both are one exec and both
        // are needed before the screen can say what a discard would reach.
        baselineRef(this.extension).catch(() => ({
          kind: '', ref: '', sha: '', label: '',
        })),
        changeProvenance(this.extension).catch(() => ({ commit: { sha: '' } })),
      ]);

      this.files = files;
      this.branch = branches?.current || '';
      this.baseline = baseline;
      this.head = provenance.commit.sha || '';
      this.states = await this.readStates(files);
      this.loading = false;
      // Everything is kept except what somebody unticked and has not left the screen on yet.
      // Read back rather than reset, because a reload that silently re-ticks every box throws
      // away a decision while the caption explaining that decision is still on the screen.
      // Anything remembered that is no longer in the tree is dropped: it was acted on, and a
      // path that turns out to be committed is dropped too - its box cannot be cleared, so a
      // remembered clearance is an instruction nothing could ever carry out.
      const remembered = this.readUnkept().filter((p) => this.states[p] !== 'committed');

      this.kept = files.map((f) => f.path).filter((p) => !remembered.includes(p));
      this.writeUnkept();

      if (files.length && !files.find((f) => f.path === this.selected)) {
        this.selected = files[0].path;
      } else if (!files.length) {
        this.selected = '';
        this.patch = '';
      }
    },

    /**
     * Which listed files a discard could reach, when that is not simply all of them.
     *
     * Skipped entirely - and it is the reason `baselineRef` and `changeProvenance` are read at
     * all - when the baseline and HEAD are the same commit. `git diff HEAD` is the working
     * tree, so every file the list holds is uncommitted and one reading answers for all of
     * them, without a shell into the pod per file on the screen's hottest path.
     *
     * `sameCommit` rather than `===`: `changeProvenance` reports `%h` and `baselineRef` reports
     * what `rev-parse` printed, so the two are the same commit in different lengths.
     */
    async readStates(files) {
      if (!this.baseline.sha || !this.head || sameCommit(this.baseline.sha, this.head)) {
        return {};
      }

      const states = {};

      await Promise.all(files.map(async(file) => {
        const prov = await fileProvenance(this.extension, file.path).catch(() => ({ state: '' }));

        states[file.path] = prov.state;
      }));

      return states;
    },

    async loadDiff() {
      if (!this.selected) {
        this.patch = '';

        return;
      }

      this.diffing = true;
      this.patch = await fileDiff(this.extension, this.selected).catch(() => '');
      this.diffing = false;
    },

    /** Tick or clear one file's box. Clearing it is what marks the file for reverting. */
    toggleKeep(file) {
      this.kept = this.kept.includes(file.path) ? this.kept.filter((p) => p !== file.path) : [...this.kept, file.path];
      this.writeUnkept();
    },

    /** The unticked paths this screen was left with last time, for this extension. */
    readUnkept() {
      try {
        const stored = JSON.parse(window.sessionStorage.getItem(`${ UNKEPT_KEY }.${ this.extension }`) || '[]');

        return Array.isArray(stored) ? stored.filter((p) => typeof p === 'string') : [];
      } catch {
        return [];
      }
    },

    writeUnkept() {
      try {
        const key = `${ UNKEPT_KEY }.${ this.extension }`;

        if (this.unkept.length) {
          window.sessionStorage.setItem(key, JSON.stringify(this.unkept));
        } else {
          window.sessionStorage.removeItem(key);
        }
      } catch {
        // A browser that refuses storage still gets the ticks, just not across a reload.
      }
    },

    /**
     * Carry out the ticks: revert everything whose box was cleared.
     *
     * The same `discardChanges` the Discard button runs, on the same paths, so unticking and
     * leaving is not a second way of throwing work away with different rules. It is announced
     * either way - this is somebody's work disappearing, and it should never be the case that
     * a file went and nothing said so.
     */
    async revertUnkept() {
      // Only what a revert can reach. A committed path cannot get here - its box is not
      // operable - but one could still be sitting in sessionStorage from before it was
      // committed, and running `discardChanges` on it would do nothing while the toast said it
      // had been put back.
      const paths = this.unkept.filter((p) => this.discardable.includes(p));

      if (!paths.length) {
        return;
      }

      try {
        await discardChanges(this.extension, paths);
        this.files = this.files.filter((f) => !paths.includes(f.path));
        this.kept = this.files.map((f) => f.path);
        this.writeUnkept();
        toastSuccess(
          this.$store,
          `${ paths.length === 1 ? paths[0] : `${ paths.length } unticked files` } put back to the last commit on the way out.`,
          { title: 'Unticked files reverted' }
        );
      } catch (e) {
        toastError(
          this.$store,
          `${ this.extension } still has ${ plural(paths.length, 'unticked file') }: ${ e?.message || String(e) }`,
          { title: 'Could not revert the unticked files' }
        );
      }
    },

    /**
     * Throw away what can be thrown away, and say what is left.
     *
     * Both halves of that sentence are the fix. The button used to aim at every listed file and
     * promise the list would empty; on an extension whose baseline is behind HEAD it cannot,
     * because most of the difference is commits. So the targets are narrowed to what a discard
     * reaches, the confirmation names the files it will not, and the result is reported from a
     * fresh reading rather than from what was asked for.
     */
    async discardSelected() {
      const paths = this.discardTargets;

      if (!paths.length) {
        return;
      }

      const all = paths.length === this.count;
      const what = all ? `all ${ this.count } changed files` : `${ paths.length } of the ${ this.count } changed files`;
      const rest = this.committed.length
        ? ` The other ${ plural(this.committed.length, 'file') } here ${ this.committed.length === 1 ? 'is' : 'are' } already committed and will still be listed afterwards.`
        : '';

      // eslint-disable-next-line no-alert
      if (!window.confirm(`Discard ${ what } in ${ this.extension }? This cannot be undone.${ rest }`)) {
        return;
      }

      this.discarding = true;

      try {
        await discardChanges(this.extension, all ? [] : paths);
        // The boxes have been acted on, so the intent they carried is spent. Without this the
        // route guard would discard the same paths again on the way out.
        this.files = all ? [] : this.files.filter((f) => !paths.includes(f.path));
        this.kept = this.files.map((f) => f.path);
        this.writeUnkept();
        // Re-read before saying what happened, because what is left is a fact about the tree
        // and not a subtraction anybody can do on paper: a file can be both edited and ahead of
        // the baseline, in which case the edit goes and the file stays on the list.
        await this.load();

        const left = this.count;
        // Only claimed when the fresh reading supports it: every file still listed is one git
        // status has nothing to say about. Anything else stays a plain count, because "because
        // of commits" would then be a guess at why a discard did not take.
        const why = left && this.committed.length === left
          ? `: ${ left === 1 ? 'it differs' : 'they differ' } from the point this list is measured from because of commits, which a discard cannot undo`
          : '';

        toastSuccess(
          this.$store,
          left
            ? `${ plural(paths.length, 'file') } put back to the last commit. ${ plural(left, 'file') } ${ left === 1 ? 'is' : 'are' } still listed${ why }.`
            : `${ this.extension } is back to its last commit.`,
          { title: 'Changes discarded' }
        );
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'Could not discard the changes' });
      } finally {
        this.discarding = false;
      }
    },

    backToAssistant() {
      this.$router.push({ name: EDITOR_ROUTE, params: { extension: this.extension } });
    },

    /**
     * Publish, after asking.
     *
     * The ellipsis on the action bar's label is the design's only signal that this opens
     * something (14:548), and a button whose label promises a step it does not take is the
     * class of defect this screen exists to catch. So both ways in - the masthead's and the
     * action bar's - stop here first, because publishing installs into the Rancher everybody
     * signed into this cluster is looking at, and because leaving reverts the unticked files.
     */
    publish() {
      this.confirmingPublish = true;
    },

    /**
     * Hand the publish to the workspace.
     *
     * `?publish=local` is the instruction, and `local` is the publish target the workspace's
     * own button uses - the same word `publishTo` takes, so the workspace does not need a
     * second vocabulary to understand a request from here. The publish flow itself lives over
     * there, which owns the split button and the status strip that reports progress; a second
     * implementation of the same three steps on this screen would be a second thing to keep
     * right.
     */
    startPublish() {
      this.confirmingPublish = false;
      this.$router.push({
        name:   EDITOR_ROUTE,
        params: { extension: this.extension },
        query:  { publish: 'local' },
      });
    },

    /**
     * Ask the pod's claude about the selected file, and go and watch it answer.
     *
     * The question goes into the one conversation this extension has - the workspace terminal's
     * - so it arrives with everything that session already knows, and the answer is somewhere a
     * person can read it and reply to it. Which means leaving this screen, so the toast says
     * which file was asked about before the route changes.
     */
    async askAboutFile() {
      if (!this.selectedFile || this.asking) {
        return;
      }

      const path = this.selected;

      this.asking = true;

      try {
        const how = await askAssistant(this.extension, this.explainPrompt);

        toastSuccess(
          this.$store,
          how === 'sent'
            ? `Asked about ${ path }. The answer appears in the workspace terminal.`
            : `The workspace session is not open yet, so ${ path } is the first thing it will be asked when it opens.`,
          { title: 'Asked the assistant' }
        );

        this.$router.push({
          name:   EDITOR_ROUTE,
          params: { extension: this.extension },
          query:  { tab: 'terminal' },
        });
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'Could not ask the assistant' });
      } finally {
        this.asking = false;
      }
    },

    /**
     * The line counts, in the words screen 12's rows use.
     *
     * Same reading, same shape, so a file that is `+21 -3` on the review-a-change screen is
     * `+21 -3` here. Empty for a file git cannot count lines for - an untracked one, which is
     * every file the assistant has just created - because "+0 -0" reads as "nothing changed"
     * about a file that is entirely new.
     */
    fileCounts(file) {
      const counts = [];

      if (file.added) {
        counts.push(`+${ file.added }`);
      }

      if (file.removed) {
        counts.push(`-${ file.removed }`);
      }

      return counts.join(' ');
    },

    statusTone(status) {
      return { added: 'success', deleted: 'error', modified: 'info' }[status] || 'default';
    },
  },
};
</script>

<template>
  <div class="review">
    <!-- workspace masthead (14:356) -->
    <div class="review__masthead">
      <SButton
        variant="ghost"
        size="sm"
        icon="chevronLeft"
        icon-only
        aria-label="Back"
        @click="$router.push({ name: routes.STUDIO_ROUTE })"
      />

      <div class="review__name">
        <div class="review__title">
          {{ extension }}
        </div>
        <div class="review__eyebrow">
          Review changes
        </div>
      </div>

      <SBadge
        :status="badge"
        data-testid="review-badge"
        :title="badge === 'draft'
          ? `Everything listed is already committed. It is not published, which is what Draft means here.`
          : ''"
      />
      <SChip v-if="branch" :label="branch" icon="branch" />

      <span class="review__grow" />

      <SButton variant="ghost" size="sm" icon="sparkle" @click="backToAssistant">
        Back to assistant
      </SButton>
      <SButton
        variant="primary"
        size="sm"
        icon="rocket"
        data-testid="review-publish-masthead"
        :disabled="!count"
        @click="publish"
      >
        Publish
      </SButton>
    </div>

    <!-- body (14:387) -->
    <div class="review__body">
      <!-- changed files (14:388) -->
      <div class="review__files">
        <!-- 14:389: the count and the size of the whole change, side by side -->
        <div class="review__panel-head">
          <SIcon name="compare" :size="14" />
          <span class="review__panel-title">Changed files</span>
          <span class="review__count" data-testid="review-file-count">{{ count }}</span>
          <span class="review__grow" />
          <span
            v-if="totalsLabel"
            class="review__totals"
            data-testid="review-totals"
            :title="`${ totals.added } lines added and ${ totals.removed } removed across ${ count } file${ count === 1 ? '' : 's' }`"
          >{{ totalsLabel }}</span>
        </div>

        <div class="review__file-list">
          <!--
            Two controls per row (14:395), so the row is a div rather than a button: a checkbox
            inside a button is neither valid nor operable. The box says whether the file is kept,
            the rest of the row opens its diff.
          -->
          <div
            v-for="file in files"
            :key="file.path"
            class="review__file"
            :class="{ 'review__file--selected': file.path === selected }"
          >
            <!--
              A committed file's box is not operable, because clearing it would be an
              instruction nothing can carry out: reverting puts the working tree back to the
              last commit and this file is already there. The title says so rather than leaving
              a dead control on the row.
            -->
            <input
              type="checkbox"
              class="review__file-box"
              data-testid="review-keep-box"
              :data-path="file.path"
              :checked="kept.includes(file.path)"
              :disabled="states[file.path] === 'committed'"
              :title="states[file.path] === 'committed'
                ? `${ file.path } is already committed. Unticking reverts a file to the last commit, and this file is at it - it is on this list because the commit itself has not been published.`
                : `Untick to revert ${ file.path } when you leave this screen.`"
              :aria-label="`Keep ${ file.path }`"
              @change="toggleKeep(file)"
            >
            <button
              type="button"
              class="review__file-open"
              @click="selected = file.path"
            >
              <SIcon name="file" :size="13" />
              <span class="review__file-path">{{ file.path }}</span>
              <span v-if="fileCounts(file)" class="review__file-stats">{{ fileCounts(file) }}</span>
              <SChip :label="file.status" :tone="statusTone(file.status)" />
            </button>
          </div>

          <div v-if="!loading && !files.length" class="review__file-empty">
            Nothing has changed.
          </div>
        </div>

        <!--
          14:424. This caption is the whole warning on the tick boxes, so it says what unticking
          does rather than describing the working tree in general.
        -->
        <div class="review__note">
          <span class="review__note-text" data-testid="review-unticked-note">
            Unticked files are reverted when you leave this screen. Nothing here has reached the
            repository yet.
          </span>
          <span class="review__note-text">
            Everything here is in the pod's working tree. Publishing builds from it; discarding
            puts it back to the last commit.
          </span>
          <!--
            Why the list will not empty, before the button is pressed rather than after it. Only
            drawn when the two points this screen works with have come apart - see the note at
            the top of the file.
          -->
          <span
            v-if="committedNote"
            class="review__note-text review__note-text--warn"
            data-testid="review-committed-note"
          >
            {{ committedNote }}
          </span>
        </div>
      </div>

      <!-- diff (14:425) -->
      <div class="review__diff">
        <div class="review__diff-head">
          <SIcon name="code" :size="14" />
          <span class="review__panel-title">{{ selected || 'No file selected' }}</span>
          <span class="review__grow" />
          <SButton
            variant="ghost"
            size="sm"
            icon="refresh"
            icon-only
            title="Re-read this file"
            @click="loadDiff"
          />
        </div>

        <div class="review__code">
          <SEmpty
            v-if="!count && !loading"
            icon="check"
            title="Nothing to review"
            message="The working tree matches the last commit."
          >
            <SButton variant="secondary" icon="sparkle" @click="backToAssistant">
              Back to assistant
            </SButton>
          </SEmpty>

          <div v-else-if="diffing" class="review__loading">
            <SIcon name="spinner" :size="20" class="review__spin" />
            Reading {{ selected }}
          </div>

          <DiffView v-else :patch="patch" />
        </div>
      </div>

      <!-- explanation (14:509) -->
      <div class="review__explain">
        <div class="review__panel-head">
          <SIcon name="sparkle" :size="14" />
          <span class="review__panel-title">What this change does</span>
        </div>

        <div class="review__explain-body">
          <!-- 14:517, three times: a heading and the paragraph under it (14:518 / 14:519) -->
          <div
            v-for="part in explanation"
            :key="part.title"
            class="review__fact"
            data-testid="review-explain-part"
          >
            <span class="review__fact-label">{{ part.title }}</span>
            <span class="review__fact-value">{{ part.body }}</span>
          </div>

          <div v-if="!explanation.length" class="review__fact">
            <span class="review__fact-label">Nothing selected</span>
            <span class="review__fact-value">
              Open a file in the list and this reads its diff back to you.
            </span>
          </div>

          <SBanner type="info">
            All of that is read off the diff. <strong>Why</strong> it was made is not in a diff,
            so this rail does not guess at it: that question goes to the one assistant this
            extension has, in the workspace terminal, where you can argue with the answer.
          </SBanner>

          <SButton
            variant="ghost"
            size="sm"
            icon="book"
            data-testid="review-ask-assistant"
            :disabled="!selectedFile"
            :loading="asking"
            @click="askAboutFile"
          >
            Ask why {{ selected ? 'this file changed' : 'about this file' }}
          </SButton>
        </div>
      </div>
    </div>

    <!-- review action bar (14:534) -->
    <div class="review__actions">
      <SIcon name="eye" :size="15" />
      <span class="review__summary">{{ summary }}</span>
      <span class="review__grow" />

      <SButton
        variant="ghost"
        icon="trash"
        data-testid="review-discard"
        :disabled="!discardTargets.length"
        :loading="discarding"
        :title="discardTargets.length
          ? `Puts ${ discardTargets.length === count ? 'the working tree' : discardTargets.length + ' of these files' } back to the last commit.`
          : `Nothing here can be discarded: every file listed is already at the last commit.`"
        @click="discardSelected"
      >
        {{ discardLabel }}
      </SButton>
      <SButton variant="neutral" data-testid="review-keep-continue" @click="backToAssistant">
        Keep and continue building
      </SButton>
      <SButton
        variant="primary"
        icon="rocket"
        data-testid="review-publish-action-bar"
        :disabled="!count"
        @click="publish"
      >
        Publish…
      </SButton>
    </div>

    <!-- the step the ellipsis promises -->
    <SModal
      v-if="confirmingPublish"
      title="Publish this extension?"
      icon="rocket"
      :width="520"
      @close="confirmingPublish = false"
    >
      <p class="review__say">
        <strong>{{ extension }}</strong> is built in its pod from the working tree you have just
        been reading, and this Rancher is pointed at the result. Everybody signed into this
        cluster gets the new build the next time they load a page.
      </p>
      <p v-if="unkept.length" class="review__say">
        {{ unkept.length === 1 ? 'One file is unticked' : `${ unkept.length } files are unticked` }},
        so leaving this screen reverts {{ unkept.length === 1 ? 'it' : 'them' }} first and the
        build will not contain {{ unkept.length === 1 ? 'that change' : 'those changes' }}:
        <strong>{{ unkept.join(', ') }}</strong>.
      </p>
      <p class="review__say">
        Nothing is committed and nothing is pushed anywhere. The workspace runs it and reports
        each step on its status strip.
      </p>

      <template #footer>
        <SButton variant="neutral" @click="confirmingPublish = false">
          Cancel
        </SButton>
        <SButton
          variant="primary"
          icon="rocket"
          data-testid="review-publish-confirm"
          @click="startPublish"
        >
          Publish to this Rancher
        </SButton>
      </template>
    </SModal>
  </div>
</template>

<style lang="scss" scoped>
.review {
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

  &__name {
    display:        flex;
    flex-direction: column;
    gap:            1px;
  }

  &__title {
    font:  var(--studio-heading-16);
    color: var(--studio-text);
  }

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

  // The file tree and the explain rail are the widths Foundations names: 288 and 340.
  &__files {
    display:        flex;
    flex-direction: column;
    flex:           0 1 var(--studio-panel-tree);
    min-width:      var(--studio-panel-tree-min);
    border-right:   1px solid var(--studio-border);
    min-height:     0;
  }

  &__explain {
    display:        flex;
    flex-direction: column;
    flex:           0 1 var(--studio-panel-rail);
    min-width:      var(--studio-panel-rail-min);
    border-left:    1px solid var(--studio-border);
    background:     var(--studio-surface-subtle);
    min-height:     0;
    overflow-y:     auto;
  }

  &__panel-head {
    display:       flex;
    align-items:   center;
    gap:           var(--studio-space-8);
    padding:       var(--studio-space-12) 14px;
    background:    var(--studio-surface-subtle);
    border-bottom: 1px solid var(--studio-border-subtle);
    color:         var(--studio-text-secondary);
    flex:          0 0 auto;

    // The explanation rail's head is the wider one (14:510); the file list's is 12/14.
    .review__explain & { padding: var(--studio-space-12) var(--studio-space-16); }
  }

  &__panel-title {
    font:          var(--studio-heading-14);
    color:         var(--studio-text);
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  &__count {
    padding:       0 6px;
    border-radius: var(--studio-radius-pill);
    background:    var(--studio-neutral-bg);
    font:          var(--studio-caption-12);
    color:         var(--studio-text-secondary);
  }

  &__file-list {
    flex:       1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }

  &__file {
    display:       flex;
    align-items:   center;
    gap:           9px;
    width:         100%;
    padding:       10px 14px;
    text-align:    left;
    background:    none;
    border:        none;
    border-bottom: 1px solid var(--studio-border-subtle);
    color:         var(--studio-text-secondary);

    &:hover { background: var(--studio-surface-subtle); }

    &--selected,
    &--selected:hover { background: var(--studio-blue-050); }
  }

  // 14:395: whether this file is kept. Drawn rather than left native, because a native
  // checkbox is a different shape and a different blue in every browser and the row is 3px
  // radius everywhere else.
  &__file-box {
    appearance:      none;
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    flex:            0 0 14px;
    width:           14px;
    height:          14px;
    margin:          0;
    background:      var(--studio-surface);
    border:          1px solid var(--studio-border-strong);
    border-radius:   var(--studio-radius-control);
    cursor:          pointer;

    &:checked {
      background:   var(--studio-green-500);
      border-color: var(--studio-green-500);
    }

    // The tick, as two borders of a rotated box. 4.14:1 against the green, which is a
    // graphical object rather than text and so wants 3:1.
    &:checked::after {
      content:       '';
      width:         3px;
      height:        7px;
      margin-top:    -2px;
      border:        solid var(--studio-text-inverse);
      border-width:  0 2px 2px 0;
      transform:     rotate(45deg);
    }

    &:focus-visible {
      outline:        2px solid var(--studio-border-focus);
      outline-offset: 1px;
    }
  }

  // The rest of the row: the part that opens the diff.
  &__file-open {
    display:     flex;
    align-items: center;
    gap:         9px;
    flex:        1 1 auto;
    min-width:   0;
    padding:     0;
    text-align:  left;
    background:  none;
    border:      none;
    color:       inherit;
    cursor:      pointer;
    // The shell gives every button a 40px minimum for touch targets, which on a row that is
    // 44 tall including its own padding would make it 60. Same escape as the file tree's rows.
    min-height:  0;
  }

  &__file-path {
    flex:          1 1 auto;
    min-width:     0;
    font:          var(--studio-body-13-semi);
    color:         var(--studio-text);
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
    direction:     rtl;
    text-align:    left;
  }

  // The same reading screen 12 puts under its rows (38:1184), on a row that has no second line
  // to put it on.
  &__file-stats {
    flex:            0 0 auto;
    font:            var(--studio-caption-12);
    color:           var(--studio-text-tertiary);
    font-variant-numeric: tabular-nums;
    white-space:     nowrap;
  }

  &__file-empty {
    padding: 14px;
    font:    var(--studio-caption-12);
    color:   var(--studio-text-tertiary);
  }

  &__note {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-4);
    padding:        var(--studio-space-12) 14px;
    border-top:     1px solid var(--studio-border-subtle);
    flex:           0 0 auto;
  }

  &__note-text {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);

    // The one line here that is about this extension rather than about the screen, so it is
    // the one that has to be read.
    &--warn { color: var(--studio-warning); }
  }

  &__diff {
    display:        flex;
    flex-direction: column;
    // Basis 0, not auto: on auto the column asks for its content width - a diff's longest
    // line, a log's longest line - and the rails next to it spend their whole shrink budget
    // answering, so they never sit at their drawn width even on a wide screen. Basis 0 makes
    // it take the space left over, and min-width is what stops that going to nothing.
    flex:           1 1 0;
    min-width:      var(--studio-panel-main-min);
    min-height:     0;
  }

  &__diff-head {
    display:       flex;
    align-items:   center;
    gap:           10px;
    padding:       10px var(--studio-space-16);
    background:    var(--studio-surface-subtle);
    border-bottom: 1px solid var(--studio-border-subtle);
    color:         var(--studio-text-secondary);
    flex:          0 0 auto;
  }

  &__code {
    display:    flex;
    flex:       1 1 auto;
    min-height: 0;
    overflow:   auto;
    padding:    6px 0;

    :deep(> *) { flex: 1 1 auto; min-width: 0; }
  }

  &__loading {
    display:         flex;
    align-items:     center;
    justify-content: center;
    gap:             var(--studio-space-8);
    flex:            1 1 auto;
    color:           var(--studio-text-secondary);
    font:            var(--studio-body-14);
  }

  &__spin { animation: review-spin 0.9s linear infinite; }

  &__explain-body {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-12);
    padding:        14px var(--studio-space-16);
  }

  &__fact {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-4);
  }

  // 14:518: the paragraph's heading. Sentence case at Body/13 SemiBold rather than the caps
  // label the facts used to be, because these are sentences about the change now and a caps
  // label over a paragraph reads as a form field.
  &__fact-label {
    font:  var(--studio-body-13-semi);
    color: var(--studio-text);
  }

  &__fact-value {
    font:  var(--studio-body-13);
    color: var(--studio-text-secondary);
    // Not break-all: these are sentences, and break-all hyphenates them mid-word. Long paths
    // inside them still have to give way somewhere, which is what anywhere does.
    overflow-wrap: anywhere;
  }

  &__totals {
    flex:                 0 0 auto;
    font:                 var(--studio-caption-12);
    color:                var(--studio-text-tertiary);
    font-variant-numeric: tabular-nums;
    white-space:          nowrap;
  }

  &__say {
    margin: 0 0 var(--studio-space-12);
    font:   var(--studio-body-13);
    color:  var(--studio-text-secondary);

    &:last-child { margin-bottom: 0; }
  }

  &__actions {
    display:     flex;
    align-items: center;
    gap:         10px;
    padding:     var(--studio-space-12) var(--studio-space-20);
    border-top:  1px solid var(--studio-border);
    color:       var(--studio-text-tertiary);
    flex:        0 0 auto;
  }

  &__summary {
    font:  var(--studio-body-13);
    color: var(--studio-text-secondary);
  }
}

@keyframes review-spin {
  to { transform: rotate(360deg); }
}
</style>
