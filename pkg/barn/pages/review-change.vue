<script>
// Screen 12 · Review a change - intent, diff and rendered result together (Figma node 38:1030).
//
// The screen the design is named after: three columns so a reviewer never has to hold two of
// them in their head at once. The packet on the left is what the change is for, the diff is in
// the middle, and the rendered result is on the right - the same live preview the author was
// looking at, so "does the diff do what the brief says" is one glance rather than two tabs.
//
// Real: the packet (the brief, read from the pod), the file list - grouped by directory, the
// way the design has it (38:1177, 38:1190, 38:1203) - and every diff, the preview, the pull
// request chip, and Request changes / Approve, which are a commit of the working tree either
// way, because on a single-reviewer Studio "approve" means "this is worth keeping" and that is
// a commit.
//
// The PR chip is a real reading. With a token and a repository it asks GitHub whether an open
// pull request has this extension's branch as its head, and says so either way; without one of
// them it names the one that is missing rather than showing a number nobody can click. There is
// still no second reviewer, so the sign-off line says that in words instead of drawing avatars
// for people who do not exist.
import {
  SButton, SChip, SIcon, SEmpty, SBanner, SLabel, SModal, SField
} from '../components/ui';
import DiffView from '../components/DiffView.vue';
import EditorSettingsModal from '../components/EditorSettingsModal.vue';
import PreviewPanel from '../components/studio/PreviewPanel.vue';
import { toastSuccess, toastError } from '../toast';
import {
  ensureRepo,
  changedFiles, fileDiff, readExtensionFile, commitExtension, extensionUrl, extensionReady,
  listBranches, readSettings, extensionSource, parseGithubSource, findOpenPullRequest,
  deferReview, clearDeferral, changeProvenance, publishedVersion, askAssistant, DEFAULT_EXTENSION
} from '../extensions';
import { readReview, signCodeReview, gateFrom } from '../review';
import { REVIEW_QUEUE_ROUTE, EDITOR_ROUTE } from '../editor-product';
import '../design/tokens';
import fullBleed from '../design/full-bleed';

// A markdown block as the paragraphs it is, rather than the lines it was typed as.
//
// Markdown's rule, and the one every editor that wrote one of these briefs assumes: a single
// newline inside a paragraph is whitespace, a blank line ends it. A list item is its own
// paragraph too, so a checklist stays a checklist instead of collapsing into one line.
//
// Joining takes two decisions, not one, and this used to take only the first. Asking whether a
// line *opens* a block says whether it may be joined *onto* something; whether the line before
// it *closed* one says whether there is anything to join onto. Without the second question a
// heading swallowed the line under it, a `###` subheading was absorbed into the list item above
// it, the four sentences of a verification block ran together, and a fenced code block or a
// table came out as one line with its rows spliced end to end.
//
// A heading, a table row and a fence line all close: whatever follows starts fresh. Prose does
// not, which is what keeps a hard-wrapped sentence one sentence.
const OPENS = /^([-*+]\s|\d+\.\s|>|#{1,6}\s|\|)/;
const CLOSES = /^(#{1,6}\s|\|)/;
const FENCE = /^(```|~~~)/;

function paragraphs(body) {
  const out = [];
  // The marker of the fence we are inside, '' when we are not. Inside one, every line is its
  // own line: it is code, and joining two lines of code changes what it says.
  let fence = '';
  let closed = true;
  let hardBreak = false;

  body.split('\n').forEach((raw) => {
    // trimEnd, not trim. Leading whitespace is a nested list's indentation and the indentation
    // is what says it is nested; the trailing whitespace is read for the hard break below and
    // then dropped, because a paragraph break carries it from here on.
    const line = raw.trimEnd();
    const bare = line.trim();
    const fenced = FENCE.test(bare);

    if (fence) {
      out.push(line);
      fence = fenced && bare.startsWith(fence) ? '' : fence;

      return;
    }

    if (fenced) {
      fence = FENCE.exec(bare)[1];
      out.push(line);
      closed = true;

      return;
    }

    if (!bare) {
      closed = true;
      hardBreak = false;

      return;
    }

    if (OPENS.test(bare) || closed || !out.length) {
      out.push(line);
    } else {
      // Two trailing spaces are markdown's hard line break, so the wrap was deliberate and the
      // two lines join with the newline they were written with rather than a space.
      out[out.length - 1] += `${ hardBreak ? '\n' : ' ' }${ bare }`;
    }

    closed = CLOSES.test(bare);
    hardBreak = /\s{2}$/.test(raw);
  });

  return out;
}

/**
 * Markdown's inline syntax, taken out for a reader.
 *
 * The packet used to print the brief's source: `Verdict: **2 still to check**`, backticks around
 * routes, `###` in front of subheadings. A reviewer is being shown a document, not a file, and
 * the asterisks were the loudest thing on the panel.
 */
function plain(text) {
  return text
    .replace(/^#{1,6}\s+/, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|\W)_(.+?)_(?=\W|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1');
}

/**
 * Which pile a file belongs in, and why in one line (38:1177, 38:1190, 38:1203).
 *
 * The design ranks the diff by how much attention each file needs, which is the one ordering a
 * reviewer cannot produce for themselves without opening everything. Directory order - what this
 * screen grouped by before - answers a different question.
 *
 * The test is the path, and only the path. That is honest: a lock file is generated because of
 * what it is, not because of what its diff contains, and guessing "this looks risky" from the
 * text of a hunk would be exactly the invention this product does not ship. Everything the rules
 * do not recognise is worth attention, which is the safe direction to be wrong in.
 */
const GENERATED = [
  [/(^|\/)(yarn\.lock|package-lock\.json|pnpm-lock\.yaml)$/, 'a lock file, written by the package manager'],
  [/(^|\/)(dist|dist-pkg|coverage|node_modules)\//, 'build output, not source'],
  [/\.generated\.[jt]sx?$/, 'generated from a seed by a script'],
  [/\.min\.(js|css)$/, 'minified output'],
  [/(^|\/)[\w.-]*\.snap$/, 'a test snapshot'],
];

// One file the rules below would file as documentation and which is not. Changing the brief
// changes what the change is being measured against, which is the single most review-worthy
// edit in the tree.
const ATTENTION = [
  [/(^|\/)BRIEF\.md$/, 'the brief itself, so what this change is measured against moved'],
];

const CONFIG = [
  [/(^|\/)package\.json$/, 'the package manifest'],
  [/(^|\/)tsconfig[\w.]*\.json$/, 'TypeScript configuration'],
  [/(^|\/)\.[\w.-]+(rc|ignore)(\.\w+)?$/, 'tool configuration'],
  [/\.config\.[jt]s$/, 'tool configuration'],
  [/\.(json|ya?ml|toml|ini)$/, 'configuration or data'],
  [/\.(md|markdown|txt)$/, 'documentation'],
];

const GROUPS = [
  { id: 'attention', label: 'Worth your attention', icon: 'alert' },
  { id: 'config', label: 'Config', icon: 'gear' },
  { id: 'generated', label: 'Generated, low risk', icon: 'file' },
];

function rank(path) {
  for (const [pattern, why] of GENERATED) {
    if (pattern.test(path)) {
      return { group: 'generated', why };
    }
  }

  for (const [pattern, why] of ATTENTION) {
    if (pattern.test(path)) {
      return { group: 'attention', why };
    }
  }

  for (const [pattern, why] of CONFIG) {
    if (pattern.test(path)) {
      return { group: 'config', why };
    }
  }

  return { group: 'attention', why: '' };
}

/** `2 hours ago`, from an ISO timestamp. '' for anything that is not one. */
function ago(iso) {
  const then = Date.parse(iso || '');

  if (!Number.isFinite(then)) {
    return '';
  }

  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  // Each pair is "how many of the unit below make one of these", and the unit it makes.
  const scales = [
    [60, 'minute'], [60, 'hour'], [24, 'day'], [7, 'week'], [4.35, 'month'], [12, 'year'],
  ];

  let value = seconds;
  let unit = 'second';

  for (const [size, next] of scales) {
    if (value < size) {
      break;
    }

    value = Math.floor(value / size);
    unit = next;
  }

  if (unit === 'second' && value < 45) {
    return 'just now';
  }

  return `${ value } ${ unit }${ value === 1 ? '' : 's' } ago`;
}

export default {
  name: 'BarnReviewChange',

  components: {
    SButton, SChip, SIcon, SEmpty, SBanner, SLabel, SModal, SField, DiffView, PreviewPanel, EditorSettingsModal
  },

  mixins: [fullBleed],

  data() {
    return {
      files:    [],
      selected: '',
      patch:    '',
      brief:    '',
      previewUrl: '',
      loading:  true,
      diffing:  false,
      deciding:  false,
      deferring: false,
      // What the masthead's GitHub chip knows. `state` is the whole of it:
      //   checking  - the question is out
      //   open      - there is one, and `pr` is it
      //   none      - asked and answered: no open PR has this branch as its head
      //   no-token  - nothing was asked, because there is no token to ask with
      //   no-repo   - nothing was asked, because no repository is known for this extension
      //   error     - the question failed, and `prError` says how
      pr:       null,
      prState:  'checking',
      prError:  '',
      repo:     '',
      branch:   '',
      showSettings: false,
      // What is installed in this Rancher right now, for the masthead's version. '' means
      // nothing is, which the line says rather than showing a version that is not deployed.
      version:  '',
      // The last commit and the newest edit in the working tree - the honest half of "who
      // authored this and when". See `provenanceLine`.
      provenance: { edited: '', commit: { sha: '', author: '', when: '', subject: '' } },
      // The two sign-offs, read from the review record (`review.ts`) rather than inferred.
      review:   { signoffs: {} },
      // Whether the "what needs to change" box is open, and what is in it.
      requesting: false,
      requestNote: '',
      sending:  false,
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
      return { REVIEW_QUEUE_ROUTE };
    },

    extension() {
      return this.$route.params.extension || DEFAULT_EXTENSION;
    },

    count() {
      return this.files.length;
    },

    risk() {
      if (!this.count) {
        return 'none';
      }

      return this.count > 8 ? 'high' : (this.count > 3 ? 'medium' : 'low');
    },

    riskTone() {
      return {
        high: 'error', medium: 'warning', low: 'success', none: 'default',
      }[this.risk];
    },

    /**
     * The masthead's second line (38:1107): which review this is, and what is known about when
     * the change was made.
     *
     * "Code review" is not decoration. There are two reviews of every change in this product and
     * they ask different questions - this screen asks whether the code is right, screen 13 asks
     * whether it did the job - and a masthead that does not say which one it is leaves the
     * decision bar's two gates unexplained.
     *
     * Who authored it is the half that has no data behind it and is therefore not claimed. Git
     * records an author for a commit and nothing at all for a working tree, and the pod's one
     * conversation is shared, so naming somebody here would be a guess. The commit's author is
     * named when there is a commit to name it from.
     */
    provenanceLine() {
      const parts = ['Code review'];
      const edited = ago(this.provenance.edited);

      if (this.count) {
        parts.push(`${ this.count } uncommitted file${ this.count === 1 ? '' : 's' }`);
        parts.push(edited ? `last edited ${ edited }` : 'edited in the pod');
      } else if (this.provenance.commit.sha) {
        parts.push(`nothing uncommitted, at ${ this.provenance.commit.sha }`);
        parts.push(`committed by ${ this.provenance.commit.author || 'somebody git did not name' } ${ ago(this.provenance.commit.when) }`);
      }

      if (this.branch) {
        parts.push(`on ${ this.branch }`);
      }

      return parts.join(' · ');
    },

    /** The hover text for the line above: the exact times it renders as "2 hours ago". */
    provenanceTitle() {
      const bits = [];

      if (this.provenance.edited) {
        bits.push(`Working tree last edited ${ new Date(this.provenance.edited).toLocaleString() }.`);
      }

      if (this.provenance.commit.sha) {
        bits.push(`Last commit ${ this.provenance.commit.sha } by ${ this.provenance.commit.author } on ${ new Date(this.provenance.commit.when).toLocaleString() }: ${ this.provenance.commit.subject }`);
      }

      bits.push('Git records no author for an uncommitted working tree, so nobody is named for the change itself.');

      return bits.join(' ');
    },

    versionLabel() {
      return this.version ? `v${ this.version.replace(/^v/, '') }` : 'not published yet';
    },

    /**
     * Where the two questions stand, read from the review record.
     *
     * Against the current commit, so a sign-off given before the branch moved is shown as what
     * it is: still on record, still named, and no longer about this change.
     */
    gate() {
      return gateFrom(this.review, this.provenance.commit.sha);
    },

    /** The two gates the decision bar draws, in the order the design puts them. */
    gates() {
      const say = (signoff, stale, waiting) => {
        if (!signoff) {
          return { done: false, text: waiting };
        }

        const who = signoff.name || signoff.principal || 'somebody Rancher did not name';
        const when = ago(signoff.at);

        if (signoff.verdict === 'changes-requested') {
          return { done: false, text: `changes requested by ${ who } ${ when }` };
        }

        return {
          done:  !stale,
          text:  stale ? `${ who } approved an earlier commit, so it no longer covers this one` : `${ who }, ${ when }`,
        };
      };

      return [
        {
          id: 'code', label: 'Code review', ...say(this.gate.code, this.gate.codeStale, 'not signed off'),
        },
        {
          id:    'outcome',
          label: 'Outcome sign-off',
          ...say(this.gate.outcome, this.gate.outcomeStale, this.criteria.length
            ? `not signed off - ${ this.criteriaSummary }`
            : 'not signed off'),
        },
      ];
    },

    /** The label on Request changes, counting what is already outstanding. */
    openRequests() {
      return [this.gate.code, this.gate.outcome].filter((s) => s?.verdict === 'changes-requested').length;
    },

    /** The brief split into its `##` sections, so the packet can show them as fields. */
    briefSections() {
      if (!this.brief.trim()) {
        return [];
      }

      const out = [];
      let current = null;

      this.brief.split('\n').forEach((raw) => {
        const line = raw.trimEnd();
        const m = /^##\s+(.*)$/.exec(line.trim());

        if (m) {
          current = { title: m[1], body: [] };
          out.push(current);
        } else if (current && line.trim() !== '---') {
          // Blank lines are kept, because they are the only thing that says where one
          // paragraph ends and the next begins.
          current.body.push(line);
        }
      });

      return out
        .map((s) => ({ title: s.title, body: s.body.join('\n').trim() }))
        .filter((s) => s.body && s.body !== '_not stated_')
        // The body is a column of paragraphs (38:1136), not a column of source lines. A
        // sentence hard-wrapped in the file is one sentence; only a blank line, or the start
        // of a list item, begins a new one - otherwise a wrapped sentence renders as two
        // paragraphs with a gap down the middle of it.
        //
        // `plain` is the other half of "a document, not a file": the brief is markdown, and a
        // reviewer should not be reading its asterisks.
        .map((s) => ({ title: s.title, lines: paragraphs(s.body).map(plain) }));
    },

    /**
     * The first thing the packet says: what the change is for (38:1131).
     *
     * The brief's opening section, whatever the author called it, given the design's framing
     * rather than its own heading. It is the sentence the whole review is measured against, and
     * it reads differently under "What this is for" than under "The problem".
     */
    purpose() {
      return this.briefSections[0] || null;
    },

    /**
     * The rest of the brief.
     *
     * Two sections are taken out because this screen renders them properly rather than as prose:
     * the acceptance criteria (below, with the evidence state screen 13 recorded against each)
     * and the verification block, which is the machine-readable half of the same thing and was
     * being dumped into the packet as raw markdown.
     */
    otherSections() {
      const spoken = ['how we will know it worked', 'verification'];

      return this.briefSections
        .slice(1)
        .filter((s) => !spoken.includes(s.title.trim().toLowerCase()));
    },

    /**
     * The acceptance criteria, each with whether anybody has looked (38:1141).
     *
     * The read-only mirror of screen 13's list, off the same two sources and reconciled the same
     * way: the `- [ ]` lines under "How we will know it worked" say met or not met, and the
     * `## Verification` block screen 13 writes says which kind of not-met it was, keyed by the
     * criterion's own text. Nothing here is inferred from the diff - a criterion nobody has
     * checked says exactly that.
     */
    criteria() {
      const brief = this.brief;
      const recorded = new Map();

      // `- **Met** at `/c/local/explorer`: the dashboard lists every node`, as screen 13 writes
      // it. A queue per criterion text, so two identically worded criteria keep their order.
      let inCriteria = false;
      let inVerification = false;

      brief.split('\n').forEach((raw) => {
        const line = raw.trim();

        if (/^##\s/.test(line)) {
          inVerification = /^##\s+verification\s*$/i.test(line);
          inCriteria = false;

          return;
        }

        if (/^#{3,}\s/.test(line)) {
          inCriteria = inVerification && /^#{3,}\s+criteria\s*$/i.test(line);

          return;
        }

        const m = inCriteria && /^-\s+\*\*(.+?)\*\*(?:\s+at\s+`([^`]*)`)?:\s*(.+)$/.exec(line);

        if (m) {
          const text = m[3].trim();

          recorded.set(text, [...(recorded.get(text) || []), { word: m[1].trim().toLowerCase(), route: (m[2] || '').trim() }]);
        }
      });

      const section = this.briefSections.find((s) => s.title.trim().toLowerCase() === 'how we will know it worked');

      if (!section) {
        return [];
      }

      // Scoped to that one section, which is the bug screen 13 had and fixed: a checkbox
      // anywhere else in the brief used to move every verdict onto the wrong line.
      const lines = section.lines
        .map((l) => l.trim())
        .filter((l) => /^- \[[ xX]\]/.test(l));

      return lines.map((line) => {
        const text = line.replace(/^- \[[ xX]\]\s*/, '').trim();
        const ticked = /^- \[[xX]\]/.test(line);
        const queue = recorded.get(text) || [];
        const wrote = queue.length ? queue.shift() : null;
        const word = ticked ? 'met' : (wrote?.word === 'met' ? '' : wrote?.word || '');

        const state = {
          met:               { icon: 'check', tone: 'success', label: 'evidence captured' },
          'not met':         { icon: 'alert', tone: 'error', label: 'checked and not met' },
          'could not tell':  { icon: 'alert', tone: 'warning', label: 'looked at, no verdict' },
          'not looked at':   { icon: 'clock', tone: 'subtle', label: 'not measured' },
        }[word] || { icon: 'clock', tone: 'subtle', label: 'not measured' };

        return {
          text:  plain(text),
          route: wrote?.route || '',
          ...state,
        };
      });
    },

    criteriaSummary() {
      const met = this.criteria.filter((c) => c.label === 'evidence captured').length;

      return `${ met } of ${ this.criteria.length } criteria met`;
    },

    /**
     * The changed files ranked by how much of the reviewer they are worth (38:1177, 38:1190,
     * 38:1203).
     *
     * Grouped by directory before, which reads well and answers the wrong question: a reviewer
     * with twenty files does not want to know where they are, they want to know which four to
     * read. So the three headings the design draws, in the order it draws them, with a count
     * each and a one-line reason under every row.
     *
     * The reason is derived and is never a guess about the code. It says which pile the file is
     * in and why, and then what git measured. Anything the rules do not recognise is worth
     * attention, because the safe direction to be wrong in is towards being read.
     */
    fileGroups() {
      const ranked = this.files.map((file) => ({ ...file, ...rank(file.path) }));

      return GROUPS
        .map((group) => ({
          ...group,
          files: ranked
            .filter((f) => f.group === group.id)
            .sort((a, b) => a.path.localeCompare(b.path)),
        }))
        .filter((group) => group.files.length);
    },

    /**
     * What the masthead's GitHub chip says, and what pressing it does.
     *
     * One computed rather than six conditionals in the template, because the states differ in
     * all three of label, tone and action, and the point of the chip is that it never says the
     * same thing for two different reasons.
     */
    prChip() {
      const chips = {
        checking: { label: 'Checking GitHub…', tone: 'subtle', action: '' },
        open:     {
          label: `PR #${ this.pr?.number } open`, tone: 'success', action: 'open',
        },
        none: {
          label: `No open PR for ${ this.branch || 'this branch' }`, tone: 'default', action: 'list',
        },
        'no-token': { label: 'No GitHub token', tone: 'warning', action: 'settings' },
        'no-repo':  { label: 'No GitHub repository', tone: 'warning', action: '' },
        error:      { label: 'Could not ask GitHub', tone: 'error', action: 'retry' },
      };

      return chips[this.prState] || chips.checking;
    },

    /** The hover text: the whole fact, where the chip only has room for the headline. */
    prTitle() {
      return {
        checking: `Asking GitHub whether ${ this.repo } has an open pull request for ${ this.branch }`,
        open:     `${ this.pr?.title } - opens on GitHub`,
        none:     `${ this.repo } has no open pull request whose head branch is ${ this.branch }. Opens the repository's pull requests.`,
        'no-token': 'No GitHub token is configured, so nothing can be asked. Opens the editor settings.',
        'no-repo':  `No GitHub repository is remembered for ${ this.extension }. Publishing it to GitHub records one.`,
        error:      this.prError,
      }[this.prState] || '';
    },
  },

  watch: {
    selected: 'loadDiff',
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

      const [files, brief, provenance, version, review] = await Promise.all([
        changedFiles(this.extension).catch(() => []),
        readExtensionFile(this.extension, 'BRIEF.md').catch(() => ''),
        changeProvenance(this.extension).catch(() => this.provenance),
        publishedVersion(this.extension).catch(() => ''),
        readReview(this.extension).catch(() => ({ signoffs: {} })),
      ]);

      this.files = files;
      this.brief = brief;
      this.provenance = provenance;
      this.version = version;
      this.review = review;
      this.loading = false;

      if (files.length) {
        this.selected = files[0].path;
      }

      this.checkPullRequest();

      // The preview is the same dev server the workspace frames. It may still be compiling,
      // which is why this waits rather than framing a connection-refused page.
      if (await extensionReady(this.extension).catch(() => false)) {
        this.previewUrl = extensionUrl(this.extension);
      }
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

    /**
     * Approving the code: a commit, and a record of who approved it.
     *
     * The commit is what moves the change out of "waiting on you" and gives it a message
     * somebody can read later. It is not the decision though, which is what this screen used to
     * get wrong: a commit says the tree changed, not that a named person answered the code
     * question, and nothing downstream could tell an approved change from an unapproved one.
     *
     * So the sign-off goes into the review record (`review.ts`), against the commit that was
     * just made, carrying the principal the apiserver attributes this session to. It is
     * explicitly the code gate and nothing else - the outcome gate is screen 13's question, it
     * stays open, and the decision bar says so.
     */
    async approve() {
      this.deciding = true;

      try {
        const out = await commitExtension(
          this.extension,
          `Reviewed: ${ this.count } file${ this.count === 1 ? '' : 's' }`
        );
        const sha = out.trim().split('\n').pop();

        // Signed against the commit that was just made, so the record answers "approved what"
        // and not only "approved". A later commit leaves this sign-off on record and no longer
        // covering the change, which is what the decision bar reads back as stale.
        const signoff = await signCodeReview(this.extension, { verdict: 'approved', sha });

        // Answering is the end of the deferral, and the toast on "Come back to it" promises
        // exactly that. Failing to clear it would leave a permanent "Deferred" mark on a
        // change that has been decided.
        await clearDeferral(this.extension).catch(() => {});

        // Stay here rather than bouncing to the queue, which is what this used to do. The
        // thing worth seeing after signing off half a gate is the other half: the decision bar
        // now reads one filled and one outstanding, which is the fact the reviewer needs and
        // the queue cannot show them.
        await this.load();

        toastSuccess(
          this.$store,
          `Committed as ${ sha }, and the code review is recorded against it in ${ signoff.name || signoff.principal }'s name. The outcome sign-off is still outstanding.`,
          { title: 'Code approved' }
        );
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'Could not record the approval' });
      } finally {
        this.deciding = false;
      }
    },

    /**
     * Send it back, with the reason attached.
     *
     * "Request changes" used to be a route push: it landed on the workspace with the assistant
     * open on whatever conversation was already there, having recorded nothing. Two things were
     * missing and both are here now - the decision is written into the review record so the
     * queue and this screen can see that somebody said no, and the reason is put to the pod's
     * assistant through `askAssistant`, which is the transport screens 04 and 10 already use, so
     * the reviewer's sentence becomes the instruction and the reviewer never writes the fix.
     *
     * The note is required. A rejection with no reason is the thing this control was already
     * doing.
     */
    async sendRequest() {
      const note = this.requestNote.trim();

      if (!note || this.sending) {
        return;
      }

      this.sending = true;

      try {
        await signCodeReview(this.extension, {
          verdict: 'changes-requested',
          sha:     this.provenance.commit.sha,
          note,
        });

        const how = await askAssistant(
          this.extension,
          `A reviewer looked at the working tree of the ${ this.extension } extension and asked for a change: ${ note }. Make that change in the working tree and explain what you did.`
        );

        await clearDeferral(this.extension).catch(() => {});
        this.requesting = false;
        this.requestNote = '';

        toastSuccess(
          this.$store,
          how === 'sent'
            ? 'The assistant has the comment and is working in the workspace terminal.'
            : 'The workspace session is not open yet, so the comment is the first thing it will be asked when it opens.',
          { title: 'Changes requested' }
        );

        this.$router.push({
          name:   EDITOR_ROUTE,
          params: { extension: this.extension },
          query:  { tab: 'terminal' },
        });
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'Could not request changes' });
      } finally {
        this.sending = false;
      }
    },

    /**
     * Whether an open pull request already exists for what is being reviewed.
     *
     * Three readings, in the order that lets it stop early: the branch (the head a PR would have
     * to point at), the token (there is no anonymous way to ask about a private repository), and
     * the repository - the one remembered when this extension was last published, or the one it
     * was imported from, because an imported extension knows where it came from before anybody
     * has published it anywhere.
     */
    async checkPullRequest() {
      this.prState = 'checking';
      this.pr = null;
      this.prError = '';

      const [branches, settings, source] = await Promise.all([
        listBranches(this.extension).catch(() => null),
        readSettings(this.extension).catch(() => ({ hasToken: false, repo: '' })),
        extensionSource(this.extension).catch(() => ''),
      ]);

      this.branch = branches?.current || '';
      this.repo = settings.repo || parseGithubSource(source)?.repo || '';

      if (!settings.hasToken) {
        this.prState = 'no-token';

        return;
      }

      if (!this.repo) {
        this.prState = 'no-repo';

        return;
      }

      try {
        this.pr = await findOpenPullRequest(this.extension, this.repo, this.branch);
        this.prState = this.pr ? 'open' : 'none';
      } catch (e) {
        this.prError = e?.message || String(e);
        this.prState = 'error';
      }
    },

    /** The chip's press, which is a different thing in each state - see `prChip`. */
    onPrChip() {
      const action = this.prChip.action;

      if (action === 'open' && this.pr) {
        window.open(this.pr.url, '_blank', 'noopener');
      } else if (action === 'list') {
        window.open(`https://github.com/${ this.repo }/pulls`, '_blank', 'noopener');
      } else if (action === 'settings') {
        this.showSettings = true;
      } else if (action === 'retry') {
        toastError(this.$store, this.prError, { title: 'GitHub did not answer' });
        this.checkPullRequest();
      }
    },

    /**
     * The one-line reason under a row (38:1184): why this file is in this pile, then its size.
     *
     * A file the ranking rules recognised carries their reason. Everything else is in "worth
     * your attention" because nothing said otherwise, and the line says that in the words of
     * what git knows about it rather than inventing a risk.
     */
    fileReason(file) {
      const why = file.why || {
        added:    'new code, nothing to compare it against',
        deleted:  'a file being taken away',
        modified: 'changed code',
      }[file.status] || 'changed';

      return `${ why } · ${ this.fileStats(file) }`;
    },

    /** The line under the path (38:1184): what the change is, in the size it is. */
    fileStats(file) {
      const counts = [];

      if (file.added) {
        counts.push(`+${ file.added }`);
      }

      if (file.removed) {
        counts.push(`-${ file.removed }`);
      }

      return counts.length ? `${ file.status } · ${ counts.join(' ') }` : file.status;
    },

    /**
     * Defer the review, and say so on the queue.
     *
     * Not the same as the back button, which is what this used to be worth. Deferring records
     * that somebody has looked and chosen not to decide, so the queue can mark the row and
     * stop it reading as untouched - the difference between "nobody has been here" and "I am
     * not ready", which is the distinction the queue exists to make.
     */
    async comeBackToIt() {
      this.deferring = true;

      try {
        await deferReview(this.extension, `${ this.count } file${ this.count === 1 ? '' : 's' } unreviewed`);
        toastSuccess(
          this.$store,
          'Come back to it',
          `${ this.extension } is marked as deferred on the review queue. Answering it clears the mark.`
        );
        this.$router.push({ name: this.routes.REVIEW_QUEUE_ROUTE });
      } catch (e) {
        toastError(this.$store, 'Could not defer this review', e?.message || String(e));
      } finally {
        this.deferring = false;
      }
    },

  },
};
</script>

<template>
  <div class="rc">
    <!-- review masthead (38:1101) -->
    <div class="rc__masthead">
      <SButton
        variant="ghost"
        size="sm"
        icon="chevronLeft"
        icon-only
        aria-label="Back to the queue"
        @click="$router.push({ name: routes.REVIEW_QUEUE_ROUTE })"
      />

      <!-- identity and provenance (38:1106, 38:1107) -->
      <div class="rc__name">
        <div class="rc__title">
          {{ extension }}
          <span class="rc__version" :title="version ? `Installed in this Rancher now` : `Nothing named ${ extension } is installed in this Rancher`">
            · {{ versionLabel }}
          </span>
        </div>
        <div class="rc__eyebrow" data-testid="rc-provenance" :title="provenanceTitle">
          {{ provenanceLine }}
        </div>
      </div>

      <SChip :label="`${ risk } risk`" :tone="riskTone" />
      <SChip
        :label="prChip.label"
        :tone="prChip.tone"
        :title="prTitle"
        icon="github"
        :clickable="!!prChip.action"
        @click="onPrChip"
      />

      <span class="rc__grow" />

      <SChip :label="`Reviewing all ${ count } file${ count === 1 ? '' : 's' }`" tone="subtle" />
      <SButton variant="ghost" size="sm" icon="refresh" @click="load">
        Refresh
      </SButton>
    </div>

    <!-- body (38:1130) -->
    <div class="rc__body">
      <!-- review packet (38:1131) -->
      <div class="rc__packet">
        <div class="rc__panel-head">
          <SIcon name="book" :size="14" />
          <span class="rc__panel-title">The packet</span>
        </div>

        <div class="rc__packet-body">
          <!-- what this is for (38:1131), and what is and is not recorded about it -->
          <div v-if="purpose" class="rc__section" data-testid="rc-purpose">
            <SLabel text="What this is for" />
            <div class="rc__section-body">
              <p v-for="(line, i) in purpose.lines" :key="i" class="rc__section-line">
                {{ line }}
              </p>
              <p class="rc__section-note">
                Written under "{{ purpose.title }}" in this extension's BRIEF.md. Nothing records
                who agreed it, when, or which ticket it came from - the brief has no field for
                any of that, so this screen does not invent one.
              </p>
            </div>
          </div>

          <div v-for="s in otherSections" :key="s.title" class="rc__section">
            <SLabel :text="s.title" />
            <div class="rc__section-body">
              <p v-for="(line, i) in s.lines" :key="i" class="rc__section-line">
                {{ line }}
              </p>
            </div>
          </div>

          <SBanner v-if="!briefSections.length" type="warning">
            This change has no brief. Nobody wrote down what it is for, so the only thing to
            review it against is the diff itself.
          </SBanner>

          <!-- does it do the job? (38:1141) - the read-only mirror of screen 13's list -->
          <div v-if="criteria.length" class="rc__section" data-testid="rc-criteria">
            <div class="rc__criteria-head">
              <SLabel text="Does it do the job?" />
              <span class="rc__group-count">{{ criteria.length }} criteria</span>
            </div>

            <div class="rc__section-body">
              <div v-for="(c, i) in criteria" :key="i" class="rc__criterion">
                <SIcon :name="c.icon" :size="13" :class="`rc__criterion-icon rc__criterion-icon--${ c.tone }`" />
                <span class="rc__criterion-text">
                  {{ c.text }}
                  <span class="rc__criterion-state">
                    {{ c.label }}<template v-if="c.route"> at {{ c.route }}</template>
                  </span>
                </span>
              </div>
            </div>
          </div>

          <div class="rc__files">
            <SLabel :text="`Changed files (${ count })`" />

            <!-- ranked by how much attention each file needs (38:1177, 38:1190, 38:1203) -->
            <div v-for="g in fileGroups" :key="g.id" class="rc__group">
              <div class="rc__group-head">
                <SIcon :name="g.icon" :size="12" />
                <span class="rc__group-path">{{ g.label }}</span>
                <span class="rc__group-count">{{ g.files.length }}</span>
              </div>

              <button
                v-for="f in g.files"
                :key="f.path"
                type="button"
                class="rc__file"
                :class="{ 'rc__file--selected': f.path === selected }"
                :title="f.path"
                @click="selected = f.path"
              >
                <span class="rc__file-row">
                  <SIcon name="file" :size="13" />
                  <span class="rc__file-path">{{ f.path }}</span>
                </span>
                <span class="rc__file-stats">{{ fileReason(f) }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- diff (38:1236) -->
      <div class="rc__diff">
        <div class="rc__panel-head rc__panel-head--wide">
          <SIcon name="code" :size="14" />
          <span class="rc__panel-title">{{ selected || 'No file selected' }}</span>
        </div>

        <div class="rc__code">
          <SEmpty
            v-if="!count && !loading"
            icon="check"
            title="Nothing to review"
            message="This extension matches its last commit."
          />
          <div v-else-if="diffing" class="rc__loading">
            <SIcon name="spinner" :size="20" class="rc__spin" />
            Reading {{ selected }}
          </div>
          <DiffView v-else :patch="patch" />
        </div>
      </div>

      <!-- visual diff (38:1347): the rendered result, beside the code that made it -->
      <div class="rc__visual">
        <div class="rc__panel-head">
          <SIcon name="eye" :size="14" />
          <span class="rc__panel-title">Rendered result</span>
        </div>

        <PreviewPanel
          v-if="previewUrl"
          class="rc__preview"
          :url="previewUrl"
          :extension="extension"
        />
        <SEmpty
          v-else
          icon="monitor"
          title="The preview is not up"
          message="The extension's dev server is still compiling. The rendered result appears here once it answers."
        />
      </div>
    </div>

    <!-- decision bar (38:1426): the two gates, and what each is waiting for -->
    <div class="rc__decision">
      <div
        class="rc__signoffs"
        data-testid="rc-signoffs"
        title="Two questions, and they are not the same question: whether the code is right, and whether it did the job. The outcome sign-off is taken on the verification screen. Each is recorded against the commit it was given for, with the Rancher principal who gave it - recorded, not attested: there is no server in this product to sign anything."
      >
        <div
          v-for="g in gates"
          :key="g.id"
          class="rc__gate"
          :data-testid="`rc-gate-${ g.id }`"
          :data-done="g.done ? 'yes' : 'no'"
        >
          <span class="rc__gate-dot" :class="{ 'rc__gate-dot--on': g.done }" />
          <span class="rc__signoff-text">{{ g.label }}</span>
          <span class="rc__gate-sub">{{ g.text }}</span>
        </div>
      </div>

      <span class="rc__grow" />

      <SButton
        variant="neutral"
        icon="undo"
        data-testid="rc-request-changes"
        :disabled="!count"
        @click="requesting = true"
      >
        Request changes<template v-if="openRequests"> ({{ openRequests }} open)</template>
      </SButton>
      <SButton
        variant="neutral"
        icon="clock"
        :loading="deferring"
        @click="comeBackToIt"
      >
        Come back to it
      </SButton>
      <SButton
        variant="primary"
        icon="check"
        data-testid="rc-approve"
        :disabled="!count"
        :loading="deciding"
        @click="approve"
      >
        Approve the code
      </SButton>
    </div>

    <!-- the reason, which is the thing that goes back to the author -->
    <SModal
      v-if="requesting"
      title="What needs to change?"
      icon="undo"
      :width="520"
      :busy="sending"
      @close="requesting = false"
    >
      <p class="rc__say">
        This is recorded against the code review, so the queue and this screen both show that
        somebody said no. It is also put straight to the assistant working in
        <strong>{{ extension }}</strong>'s pod, so the change is made by the thing that wrote it
        rather than by you.
      </p>

      <SField
        v-model="requestNote"
        label="The comment"
        multiline
        :rows="4"
        placeholder="The threshold is hardcoded. Read it from the PrometheusRule when there is one."
        hint="One paragraph. It goes to the assistant exactly as written."
      />

      <template #footer>
        <SButton variant="neutral" :disabled="sending" @click="requesting = false">
          Cancel
        </SButton>
        <SButton
          variant="primary"
          icon="sparkle"
          data-testid="rc-send-request"
          :disabled="!requestNote.trim()"
          :loading="sending"
          @click="sendRequest"
        >
          Send it back
        </SButton>
      </template>
    </SModal>

    <!-- the token the PR chip needs, asked for where it was found to be missing -->
    <EditorSettingsModal
      v-if="showSettings"
      @close="showSettings = false"
      @saved="checkPullRequest"
    />
  </div>
</template>

<style lang="scss" scoped>
.rc {
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

  // 38:1106: the version sits beside the name, quieter than it.
  &__version {
    font:  var(--studio-body-13);
    color: var(--studio-text-tertiary);
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

  &__packet {
    display:        flex;
    flex-direction: column;
    flex:           0 1 var(--studio-panel-rail);
    min-width:      var(--studio-panel-rail-min);
    border-right:   1px solid var(--studio-border);
    min-height:     0;
  }

  &__visual {
    display:        flex;
    flex-direction: column;
    flex:           0 1 var(--studio-panel-assistant);
    min-width:      var(--studio-panel-assistant-min);
    border-left:    1px solid var(--studio-border);
    background:     var(--studio-surface-subtle);
    min-height:     0;
  }

  &__preview { flex: 1 1 auto; min-height: 0; }

  // The floor the two rails shrink for. Without it they hold their drawn widths and the diff
  // - the whole point of the screen - is what gives way.
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

  &__panel-head {
    display:       flex;
    align-items:   center;
    gap:           var(--studio-space-8);
    padding:       var(--studio-space-12) 14px;
    background:    var(--studio-surface-subtle);
    border-bottom: 1px solid var(--studio-border-subtle);
    color:         var(--studio-text-secondary);
    flex:          0 0 auto;

    &--wide { padding: var(--studio-space-10) var(--studio-space-16); }

    // The preview rail's head is the wider one (38:1348); the packet's is not.
    .rc__visual & { padding: var(--studio-space-12) var(--studio-space-16); }
  }

  &__panel-title {
    font:          var(--studio-heading-14);
    color:         var(--studio-text);
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  // Figma has no wrapper here: under 38:1131 a section's head (38:1132, padding 12/16/8) and
  // its body (38:1136, padding 0/16/12) are siblings. Collapsing that into one padded column
  // means taking the head's 12 at the top, the body's 12 at the bottom, and the two of them
  // together - 24 - as the gap between sections.
  &__packet-body {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-24);
    padding:        var(--studio-space-12) var(--studio-space-16);
    overflow-y:     auto;
    min-height:     0;
  }

  // The 8px the head leaves under its label (38:1132 padding-bottom).
  &__section {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-8);
  }

  &__section-body {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-6);
  }

  &__section-line {
    font:        var(--studio-body-13);
    color:       var(--studio-text);
    margin:      0;
    white-space: pre-wrap;
  }

  // What the brief does not record, said in the place a reader would look for it.
  &__section-note {
    margin: 0;
    font:   var(--studio-caption-12);
    color:  var(--studio-text-tertiary);
  }

  &__criteria-head {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
  }

  // 38:1145: the icon says which state, the sub-label says it in words. Both, because the
  // difference between "not met" and "not measured" is the whole point of the list and a
  // colour cannot carry it.
  &__criterion {
    display: flex;
    gap:     var(--studio-space-8);
  }

  &__criterion-icon {
    margin-top: 2px;

    &--success { color: var(--studio-green-500); }
    &--error   { color: var(--studio-error); }
    &--warning { color: var(--studio-warning); }
    &--subtle  { color: var(--studio-text-tertiary); }
  }

  &__criterion-text {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-2);
    font:           var(--studio-body-13);
    color:          var(--studio-text);
  }

  &__criterion-state {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  &__files {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-4);
    border-top:     1px solid var(--studio-border-subtle);
    padding-top:    var(--studio-space-12);
  }

  // The directory heading and the rows under it (38:1177). Indented rather than boxed: the
  // heading is what says where these files are, so the indent is the only thing that has to
  // keep saying it.
  &__group {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-2);
  }

  &__group-head {
    display:     flex;
    align-items: center;
    gap:         6px;
    padding:     var(--studio-space-6) var(--studio-space-10) var(--studio-space-2);
    color:       var(--studio-text-tertiary);
  }

  &__group-path {
    flex:          1 1 auto;
    min-width:     0;
    font:          var(--studio-caption-12-semi);
    color:         var(--studio-text-secondary);
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
    direction:     rtl;
    text-align:    left;
  }

  &__group-count {
    flex:          0 0 auto;
    padding:       0 var(--studio-space-6);
    border-radius: var(--studio-radius-pill);
    background:    var(--studio-neutral-bg);
    font:          var(--studio-caption-12);
    color:         var(--studio-text-secondary);
  }

  &__file {
    display:        flex;
    flex-direction: column;
    // Explicit, because the shell centres every button's contents and in a column that
    // centres them horizontally - a left-aligned path drawn down the middle of the row.
    align-items:    stretch;
    gap:            var(--studio-space-2);
    padding:        7px var(--studio-space-10);
    background:    none;
    border:        1px solid transparent;
    border-radius: var(--studio-radius-control);
    color:         var(--studio-text-secondary);
    cursor:        pointer;
    text-align:    left;

    &:hover { background: var(--studio-surface-subtle); }

    &--selected,
    &--selected:hover {
      background:   var(--studio-blue-050);
      border-color: var(--studio-info);
      color:        var(--studio-text);
    }

    // Under a heading the row is a file name, so it is indented to the heading's icon.
    .rc__group & { margin-left: var(--studio-space-10); }
  }

  &__file-row {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
    min-width:   0;
  }

  &__file-path {
    flex:          1 1 auto;
    min-width:     0;
    font:          var(--studio-body-13-semi);
    color:         var(--studio-text);
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  &__file-stats {
    font:  var(--studio-caption-12);
    color: var(--studio-text-secondary);
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

  &__spin { animation: rc-spin 0.9s linear infinite; }

  &__decision {
    display:     flex;
    align-items: center;
    gap:         10px;
    padding:     var(--studio-space-12) var(--studio-space-20);
    border-top:  1px solid var(--studio-border);
    flex:        0 0 auto;
  }

  &__signoffs {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-16);
    color:       var(--studio-text-tertiary);
  }

  &__signoff-text {
    font:  var(--studio-body-13);
    color: var(--studio-text-secondary);
  }

  // One gate: a dot that is filled or not, the question it answers, and who answered it.
  &__gate {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-6);
  }

  &__gate-dot {
    flex:          0 0 auto;
    width:         9px;
    height:        9px;
    border-radius: var(--studio-radius-pill);
    border:        1px solid var(--studio-border-strong);
    background:    var(--studio-surface);

    &--on {
      background:   var(--studio-green-500);
      border-color: var(--studio-green-500);
    }
  }

  &__gate-sub {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  &__say {
    margin: 0 0 var(--studio-space-12);
    font:   var(--studio-body-13);
    color:  var(--studio-text-secondary);
  }
}

@keyframes rc-spin {
  to { transform: rotate(360deg); }
}
</style>
