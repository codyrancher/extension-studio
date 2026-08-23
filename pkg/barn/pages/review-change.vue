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
// Every hunk carries what produced it (38:1256), read from the pod's own provenance record
// through `provenanceFor`. It answers with the set of turns behind the hunk's lines rather
// than with "the prompt that produced this hunk", because per-hunk-per-prompt is not
// achievable and pretending otherwise would be the invention this product does not ship; and
// lines nobody watched say "changed in the pod, no prompt recorded" rather than being pinned
// on the nearest prompt. That last sentence is what most hunks say today, and it is the truth.
//
// Two controls narrow what is being read and neither narrows what is being decided. The scope
// chip (38:1117) picks one of the ranked piles, "Hide generated lines" (38:1244) takes the
// generated pile out, and "Since my last look" (38:1249) measures the list and the diff from
// the commit this reviewer last read instead of from the last published version - the same
// point the queue's "Show only what changed since then" link means, which arrives here as
// `?scope=since&from=<sha>`. All three move the file list and the patch together. Approve still
// commits the whole change, and every banner and title on them says so.
//
// A comment can be left on any hunk and either sent to the assistant or left on the record.
// Sending routes through the workspace with `?comment=<id>`, which is where the answer arrives:
// `editor.vue` loads the comment into the pod's session with its origin stamped and marks it
// sent only when it was.
//
// The PR chip is a real reading. With a token and a repository it asks GitHub whether an open
// pull request has this extension's branch as its head, and says so either way; without one of
// them it names the one that is missing rather than showing a number nobody can click. There is
// still no second reviewer, so the sign-off line says that in words instead of drawing avatars
// for people who do not exist.
import {
  SButton, SChip, SIcon, SEmpty, SBanner, SLabel, SModal, SField, SMenu
} from '../components/ui';
import DiffView from '../components/DiffView.vue';
import EditorSettingsModal from '../components/EditorSettingsModal.vue';
import PreviewPanel from '../components/studio/PreviewPanel.vue';
import { toastSuccess, toastError } from '../toast';
import {
  ensureRepo,
  changedFiles, fileDiff, changedFilesSince, fileDiffSince,
  readExtensionFile, commitExtension, extensionUrl, extensionReady,
  listBranches, readSettings, extensionSource, parseGithubSource, findOpenPullRequest,
  deferReview, clearDeferral, changeProvenance, publishedVersion, askAssistant, provenanceFor,
  DEFAULT_EXTENSION
} from '../extensions';
import {
  readReview, signCodeReview, gateFrom, addComment, markLook, sinceLastLook
} from '../review';
import { REVIEW_QUEUE_ROUTE, EDITOR_ROUTE, BRIEF_ROUTE } from '../editor-product';
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
/**
 * Where the reading scope is remembered, per extension.
 *
 * sessionStorage, and that is the right amount of persistence for it: it is a reading position,
 * not a decision, and losing it costs one click while nothing about the change has moved. The
 * decisions on this screen - the sign-offs, the comments, the deferral - all live in the pod
 * where everybody can see them, and a view filter would be noise in that record.
 */
const SCOPE_KEY = 'barn.review.scope';

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

/**
 * The hunks of the patch on screen, as ranges in the new file.
 *
 * The same `@@` headers `DiffView` parses, read a second time here for two things the diff
 * component cannot answer: which lines of the provenance report belong to the hunk a reviewer
 * is looking at, and which line a comment on that hunk is anchored to. Parsed from the same
 * string in the same order, so index `n` here is index `n` there.
 *
 * `fileDiff` asks git for one path, so the patch is one file and an index is unambiguous.
 */
function hunkRanges(patch) {
  const out = [];

  (patch || '').split('\n').forEach((line) => {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);

    if (!m) {
      return;
    }

    const from = parseInt(m[1], 10);
    const count = m[2] === undefined ? 1 : parseInt(m[2], 10);

    out.push({ from, to: count ? from + count - 1 : from });
  });

  return out;
}

/** Initials for the little avatar on a comment (38:1287). '?' when nobody was named. */
function initials(name) {
  const words = (name || '').trim().split(/[\s._-]+/).filter(Boolean);

  if (!words.length) {
    return '?';
  }

  return words.slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

export default {
  name: 'BarnReviewChange',

  components: {
    SButton, SChip, SIcon, SEmpty, SBanner, SLabel, SModal, SField, SMenu, DiffView, PreviewPanel, EditorSettingsModal
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
      // What produced the lines of this change, hunk by hunk (`provenanceFor`). `available`
      // false is the normal state of a pod that predates the hooks and carries the reason.
      prov:     {
        available: false, reason: '', base: '', baseRef: '', files: [],
      },
      // Which hunk's composer is open, as `<file>:<line>`, and what has been typed into it.
      composing: '',
      commentText: '',
      posting:  false,
      // What has landed since this reviewer last opened this change, read before the look
      // below is recorded - reading it afterwards would always answer "nothing".
      since:    null,
      // The two narrowing controls the design draws over the file list (38:1117, 38:1244).
      // `all` or one of the ranked piles, and whether the generated pile is out. Both are a
      // reading position rather than a decision, and both are remembered - see `readScope`.
      fileScope:     'all',
      hideGenerated: false,
      // 38:1249. Whether the pane is measured from the commit this reviewer last read instead
      // of from the last published version, the files that reading gives, and why it could not
      // be done when it could not. Not remembered across a visit: it is a question about what
      // has moved since last time, and arriving is what makes "last time" mean something else.
      sinceOn:       false,
      sinceFiles:    [],
      sinceError:    '',
      sinceLoading:  false,
      // Which read of the diff is the current one. Two can be in flight at once - the selection
      // watcher and an explicit re-read after the measuring point moved - and without this the
      // slower one wins whichever it is, which puts the whole change on screen under a banner
      // saying it has been narrowed.
      diffToken:     0,
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

        // Two different reasons a sign-off does not cover this commit, and they are not the
        // same fact. The branch moving past an answer is the ordinary one. A record that names
        // no commit at all is the other: `gateFrom` now reads those as stale too, and calling
        // it "approved an earlier commit" would invent an earlier commit that never existed.
        // `signCodeReview` refuses to write another one, so this is only ever a record made
        // before that check - which is exactly why it has to be described as what it is.
        if (stale) {
          // Tested for being a commit id rather than for being non-empty: the failure that
          // produced these records signed against the last line of `commitExtension`'s output,
          // so the bad ones hold either '' or git's "nothing to commit, working tree clean".
          // Both mean the same thing here and neither is an earlier commit.
          const named = /^[0-9a-f]{7,40}$/.test((signoff.sha || '').trim());

          return {
            done: false,
            text: named
              ? `${ who } approved an earlier commit, so it no longer covers this one`
              : `${ who } approved this ${ when }, but the record does not say which commit, so it covers none of them`,
          };
        }

        return { done: true, text: `${ who }, ${ when }` };
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
     * What the pane is covering before it is ranked: the whole change, or only what has landed
     * since the commit the "Since my last look" chip is measured from.
     *
     * `files` stays the whole change either way, because everything that is a fact about the
     * change rather than about the reading - the risk chip, the masthead's counts, what Approve
     * commits - has to go on answering for all of it.
     */
    paneFiles() {
      return this.sinceOn ? this.sinceFiles : this.files;
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
    allGroups() {
      const ranked = this.paneFiles.map((file) => ({ ...file, ...rank(file.path) }));

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
     * The same ranking, after the two narrowing controls (38:1117 and 38:1244).
     *
     * Both narrow by pile rather than by line, and that is the honest limit of what the ranking
     * knows: a file is generated because of what it is, and no rule in this screen can tell a
     * generated line from a hand-written one inside a file. So "hide generated lines" takes the
     * generated pile out, which is every generated line this change has, and says so in the
     * chip's title rather than implying a per-line reading nothing performs.
     */
    fileGroups() {
      return this.allGroups
        .filter((g) => this.fileScope === 'all' || g.id === this.fileScope)
        .filter((g) => !(this.hideGenerated && g.id === 'generated'));
    },

    /** The files the pane is covering, which is what the scope chip counts. */
    scopedFiles() {
      return this.fileGroups.flatMap((g) => g.files);
    },

    /**
     * 38:1117, as a readout that is true after it has been narrowed.
     *
     * "Reviewing all 3 files" is only the label of one of its states. Once a scope is on it says
     * how many of how many, because a chip that goes on claiming "all" over a narrowed list is
     * the lie this control was in danger of becoming.
     */
    scopeLabel() {
      const shown = this.scopedFiles.length;
      const of = this.paneFiles.length;

      if (shown === of) {
        return `Reviewing all ${ of } file${ of === 1 ? '' : 's' }`;
      }

      return `Reviewing ${ shown } of ${ of } files`;
    },

    /** The scopes on offer: everything, or one pile - only the piles this change has. */
    scopeItems() {
      return [
        {
          id: 'all', label: 'All files', icon: 'file', note: String(this.paneFiles.length),
        },
        ...this.allGroups.map((g) => ({
          id: g.id, label: g.label, icon: g.icon, note: String(g.files.length),
        })),
      ];
    },

    scopeTitle() {
      return `Which files the packet list and the diff cover. It narrows what you are reading and nothing else - Approve still commits the whole change, all ${ this.count } file${ this.count === 1 ? '' : 's' } of it.`;
    },

    /** The generated pile, which is what "Hide generated lines" is aimed at. */
    generatedFiles() {
      return (this.allGroups.find((g) => g.id === 'generated')?.files || []).map((f) => f.path);
    },

    generatedChip() {
      const n = this.generatedFiles.length;

      if (!n) {
        return {
          label: 'Hide generated lines',
          tone:  this.hideGenerated ? 'info' : 'subtle',
          title: 'Nothing in this change is generated - no lock file, no build output, no snapshot - so there are no generated lines to hide. The toggle still records the preference for the next change that has some.',
        };
      }

      return {
        label: this.hideGenerated ? `${ n } generated file${ n === 1 ? '' : 's' } hidden` : 'Hide generated lines',
        tone:  this.hideGenerated ? 'info' : 'subtle',
        title: `${ this.generatedFiles.join(', ') }. Generated files are recognised by their path, which is the only honest test: a lock file is generated because of what it is. Hiding takes the whole file out, because no rule here can tell a generated line from a hand-written one inside a file.`,
      };
    },

    /**
     * The hunks of the patch on screen, as ranges in the new file.
     *
     * The anchor for everything hung off a hunk: a comment records the hunk's first line, and
     * the provenance report's own hunks are matched into these by overlap.
     */
    hunks() {
      return hunkRanges(this.patch);
    },

    /**
     * The provenance of every hunk on screen, in the order they are drawn.
     *
     * Computed once per patch rather than per row: the strip asks four questions of the same
     * answer, and a method call in a template is re-run on every one of them.
     */
    hunkProv() {
      return this.hunks.map((_, i) => this.hunkProvenance(i));
    },

    /**
     * `?scope=since`: the queue's "Show only what changed since then" (36:1116), arriving here.
     *
     * `scope` is the instruction and `from` is the commit it means. The queue's banner counts
     * from the commit an approval was given against; this screen's own chip counts from the
     * commit the reviewer last read. They are two different points, so the link carries its
     * own rather than being silently re-measured against the other one.
     */
    scope() {
      return String(this.$route.query.scope || '');
    },

    /**
     * The commit "since" means, and which fact it is.
     *
     * The URL's, when the queue sent one and it looks like a commit id - an approval names one
     * commit for ever, so it is not a copy of a moving answer. Otherwise the commit this
     * reviewer's own last look recorded. `''` when nothing recorded either, which is a state
     * the chip has to be able to say rather than guess its way out of.
     *
     * Validated here and again in the pod: `changedFilesSince` refuses anything that is not a
     * commit in this repository rather than falling back to the whole change.
     */
    sinceFrom() {
      const asked = String(this.$route.query.from || '').trim().toLowerCase();

      if (/^[0-9a-f]{7,40}$/.test(asked)) {
        return { sha: asked, why: 'approved' };
      }

      return this.since?.sha ? { sha: this.since.sha, why: 'look' } : { sha: '', why: '' };
    },

    /** 38:1249, in each of the four states it can honestly be in. */
    sinceChip() {
      const { sha, why } = this.sinceFrom;
      const label = why === 'approved' ? 'Since you approved it' : 'Since my last look';

      if (!sha) {
        return {
          label,
          tone:     'subtle',
          disabled: true,
          title:    'Nothing recorded which commit you last read of this change, so there is no point to measure from. Opening this screen records one, so this works from your next visit.',
        };
      }

      if (this.sinceError) {
        return {
          label, tone: 'error', disabled: false, title: this.sinceError,
        };
      }

      return {
        label,
        tone:     this.sinceOn ? 'info' : 'subtle',
        disabled: false,
        title:    `Measures the list and the diff from ${ sha.slice(0, 7) }, the commit ${ why === 'approved' ? 'your approval was given against' : 'you last read' }, instead of from the last published version. It changes what you are reading and nothing else - Approve still commits the whole change.`,
      };
    },

    /**
     * What the screen says about the narrowing, in the state it is actually in.
     *
     * Four states and each is a different sentence, because this control used to have one: a
     * refusal, printed whether or not the reviewer had asked for anything the product could
     * not do. The refusal is still here for the two cases that earn it - no recorded point, and
     * a point that has left the branch - and the other two say what was done.
     */
    sinceNotice() {
      const { sha, why } = this.sinceFrom;
      const asked = this.scope === 'since';

      if (this.sinceError) {
        return {
          tone: 'warning',
          testid: 'rc-scope-refused',
          text: `Only what has landed since ${ sha.slice(0, 7) } was asked for, and it could not be measured: ${ this.sinceError } The whole change is shown instead, and nothing has been hidden from you.`,
        };
      }

      if (asked && !sha) {
        return {
          tone: 'warning',
          testid: 'rc-scope-refused',
          text: 'Only what has landed since your last look was asked for, and nothing recorded which commit that was, so there is no point to measure from. The whole change is shown instead, and nothing has been hidden from you.',
        };
      }

      if (this.sinceOn) {
        const shown = this.sinceFiles.length;
        // Deliberately not "N of M": the point being measured from can be older than the last
        // published version, in which case the narrowed reading has *more* files in it than
        // the change does. Both counts are stated instead, so neither can be read as a share
        // of the other.
        const point = why === 'approved' ? 'your approval was given against' : 'you last read';

        return {
          tone: 'info',
          testid: 'rc-scope-applied',
          text: shown
            ? `Showing what has landed since ${ sha.slice(0, 7) }, the commit ${ point }: ${ shown } file${ shown === 1 ? '' : 's' }. The whole change, measured from the last published version, is ${ this.count } file${ this.count === 1 ? '' : 's' }. Approve still commits all of it.`
            : `Nothing has landed since ${ sha.slice(0, 7) }, the commit ${ point }. The whole change is the same ${ this.count } file${ this.count === 1 ? '' : 's' } it was then.`,
        };
      }

      if (this.since?.behind) {
        return {
          tone: 'info',
          testid: 'rc-since',
          text: `${ this.since.banner } The diff below is the whole change; "${ this.sinceChip.label }" above the diff narrows it to what has landed since.`,
        };
      }

      return null;
    },

    /** The provenance report's entry for the file being read, if it has one. */
    provFile() {
      return this.prov.files.find((f) => f.path === this.selected) || null;
    },

    /**
     * Every turn behind this change, numbered oldest first.
     *
     * The design labels a hunk "Prompt 3 of 5" (38:1256), which needs an ordering across the
     * whole change rather than within one hunk - the same turn touching two files has to carry
     * the same number in both.
     */
    turnOrder() {
      const seen = new Map();

      this.prov.files.forEach((file) => (file.hunks || []).forEach((hunk) => (hunk.turns || []).forEach((turn) => {
        if (!seen.has(turn.turn)) {
          seen.set(turn.turn, turn);
        }
      })));

      const ordered = [...seen.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
      const index = new Map();

      ordered.forEach((turn, i) => index.set(turn.turn, i + 1));

      return { index, total: ordered.length };
    },

    /**
     * The one-line summary above the diff: how much of this change has a prompt behind it.
     *
     * Worth saying at the top because the honest answer is usually "none of it". The Studio
     * records a prompt when the assistant works through it, and everything else - a hand edit,
     * a `Bash` heredoc, a pod whose claude is signed out - arrives with nothing recorded. A
     * reviewer should learn that from one line rather than from every hunk in turn.
     */
    provSummary() {
      if (!this.prov.available) {
        return { text: this.prov.reason, tone: 'subtle' };
      }

      let unrecorded = 0;

      this.prov.files.forEach((file) => (file.hunks || []).forEach((hunk) => {
        unrecorded += hunk.unrecorded || 0;
      }));

      const turns = this.turnOrder.total;

      if (!turns && !unrecorded) {
        return { text: '', tone: 'subtle' };
      }

      // Scoped to the whole change, not to the file on screen, and worded so it cannot be
      // read as being about the file whose name it sits beside.
      if (!turns) {
        return { text: `No prompt recorded for any of this change's ${ unrecorded } line${ unrecorded === 1 ? '' : 's' }`, tone: 'subtle' };
      }

      const prompts = `${ turns } prompt${ turns === 1 ? '' : 's' } behind this change`;

      return {
        text: unrecorded ? `${ prompts }, ${ unrecorded } line${ unrecorded === 1 ? '' : 's' } with none recorded` : prompts,
        tone: 'success',
      };
    },

    /** Every comment left on the file being read, oldest first. */
    fileComments() {
      return (this.review.comments || [])
        .filter((c) => c.file === this.selected)
        .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    },

    /**
     * Comments on this file that no hunk on screen is anchored to.
     *
     * A comment is anchored to a line, and the tree moves under it: the hunk it was written
     * against can merge into another one or stop being a hunk at all. Those comments are shown
     * under the diff rather than dropped, because a reviewer's sentence disappearing because
     * somebody edited the file is the worst thing this could do.
     */
    strayComments() {
      const anchors = new Set(this.hunks.map((h) => h.from));

      return this.fileComments.filter((c) => !anchors.has(c.hunk));
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

      const [files, brief, provenance, version, review, prov] = await Promise.all([
        changedFiles(this.extension).catch(() => []),
        readExtensionFile(this.extension, 'BRIEF.md').catch(() => ''),
        changeProvenance(this.extension).catch(() => this.provenance),
        publishedVersion(this.extension).catch(() => ''),
        readReview(this.extension).catch(() => ({ signoffs: {} })),
        // What produced these lines. One exec, read once for the whole change rather than
        // once per file, because the report is a blame of the whole collapsed diff.
        provenanceFor(this.extension).catch((e) => ({
          available: false, reason: e?.message || 'the pod could not be asked what produced these lines', base: '', baseRef: '', files: [],
        })),
      ]);

      this.files = files;
      this.brief = brief;
      this.provenance = provenance;
      this.version = version;
      this.review = review;
      this.prov = prov;
      this.loading = false;

      // Read after the files, because a remembered pile that this change has nothing in would
      // leave the pane empty with no way back to it.
      this.readScope();

      if (files.length) {
        this.selected = (this.scopedFiles[0] || files[0]).path;
      }

      this.checkPullRequest();
      // Awaited, unlike the pull-request check, because the "since" chip cannot know which
      // commit it measures from until the look has been read - and `?scope=since` is applied
      // straight afterwards.
      await this.recordLook();

      if (this.scope === 'since') {
        await this.applySince();
      }

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

      const token = ++this.diffToken;

      this.diffing = true;
      // The same file, measured from whichever point the pane is on. Both are one git diff, so
      // the counts in the list and the patch under it stay two readings of one thing.
      const patch = await (this.sinceOn
        ? fileDiffSince(this.extension, this.sinceFrom.sha, this.selected)
        : fileDiff(this.extension, this.selected)).catch(() => '');

      // A newer read started while this one was out, so this answer is about a file or a
      // measuring point the screen has already left. Dropped rather than drawn.
      if (token !== this.diffToken) {
        return;
      }

      this.patch = patch;
      this.diffing = false;
    },

    /**
     * Measure the pane from the commit "since" means (38:1249, and 36:1116 arriving as a link).
     *
     * The list and the diff move together, because a file list taken from one point over a
     * patch taken from another is the defect that made the file-scope chip worth fixing.
     *
     * A commit that is no longer in the branch is refused rather than fallen back from. A
     * reviewer who asked for "what landed since I approved" and is silently given the whole
     * change has been told something false about a change they are about to sign for.
     */
    async applySince() {
      const { sha } = this.sinceFrom;

      if (!sha || this.sinceLoading) {
        return;
      }

      this.sinceLoading = true;

      try {
        this.sinceFiles = await changedFilesSince(this.extension, sha);
        this.sinceError = '';
        this.sinceOn = true;
      } catch (e) {
        this.sinceFiles = [];
        this.sinceOn = false;
        this.sinceError = e?.message || String(e);
      } finally {
        this.sinceLoading = false;
      }

      this.followScope();
      await this.loadDiff();
    },

    /** The chip's press: on, or back to the whole change. */
    async toggleSince() {
      if (this.sinceChip.disabled) {
        return;
      }

      if (!this.sinceOn) {
        await this.applySince();

        return;
      }

      this.sinceOn = false;
      this.sinceError = '';
      this.followScope();
      await this.loadDiff();
    },

    /**
     * The remembered reading position, dropped rather than honoured when it does not fit.
     *
     * A pile this change has nothing in is not a scope, it is an empty pane, and a reviewer who
     * arrives at one has no way of knowing a filter they set on a different change is why. So
     * an unrecognised or empty pile falls back to all files.
     */
    readScope() {
      let stored = {};

      try {
        stored = JSON.parse(window.sessionStorage.getItem(`${ SCOPE_KEY }.${ this.extension }`) || '{}') || {};
      } catch {
        stored = {};
      }

      const has = this.allGroups.some((g) => g.id === stored.scope);

      this.fileScope = has ? stored.scope : 'all';
      this.hideGenerated = !!stored.hideGenerated;
    },

    writeScope() {
      try {
        const key = `${ SCOPE_KEY }.${ this.extension }`;

        if (this.fileScope === 'all' && !this.hideGenerated) {
          window.sessionStorage.removeItem(key);
        } else {
          window.sessionStorage.setItem(key, JSON.stringify({ scope: this.fileScope, hideGenerated: this.hideGenerated }));
        }
      } catch {
        // A browser that refuses storage still gets the filter, just not across a reload.
      }
    },

    /**
     * Narrow the pane to one pile, or open it back up (38:1117).
     *
     * The selection follows, because the alternative is a diff of a file the list no longer
     * shows - the pane would keep drawing the old patch under a heading nothing on screen
     * points at. Choosing a scope the current file is already in leaves it alone.
     */
    setScope(id) {
      this.fileScope = id;
      this.writeScope();
      this.followScope();
    },

    /** 38:1244. The generated pile in or out, with the selection following it the same way. */
    toggleGenerated() {
      this.hideGenerated = !this.hideGenerated;
      this.writeScope();
      this.followScope();
    },

    /**
     * Every filter off, for the way out of an empty pane.
     *
     * All three of them, including the measuring point: "Since my last look" over a change
     * nothing has landed on leaves the pane empty too, and a button labelled "review all N
     * files" that left it empty would be the worst control on the screen.
     */
    async showAllFiles() {
      this.fileScope = 'all';
      this.hideGenerated = false;
      this.sinceOn = false;
      this.sinceError = '';
      this.writeScope();
      this.followScope();
      await this.loadDiff();
    },

    followScope() {
      if (this.scopedFiles.some((f) => f.path === this.selected)) {
        return;
      }

      this.selected = this.scopedFiles[0]?.path || '';
    },

    /**
     * Record that this reviewer has opened this change, and read what landed since last time.
     *
     * `markLook` is what makes re-review incremental: the queue's "since your last look" line
     * is the difference between the packet somebody last opened and the current one, and until
     * something wrote a look it could never fire, because no screen had ever recorded one.
     * Opening the change is the moment, so this is called from `load`.
     *
     * The order is not incidental. `sinceLastLook` is read first and kept, because recording
     * the look is what makes the answer "nothing" - reading it afterwards would show a banner
     * that had already been cancelled by the act of arriving.
     *
     * Both halves are allowed to fail quietly. A reviewer Rancher will not name cannot have a
     * look recorded (`currentSigner` throws, correctly), and that is not a reason to take a
     * read-only screen down.
     */
    async recordLook() {
      const since = await sinceLastLook(this.extension).catch(() => null);

      this.since = since;

      await markLook(this.extension, since?.packet || 0, this.provenance.commit.sha).catch(() => null);
    },

    /**
     * What produced the lines of one hunk (38:1256), or null when nothing was captured.
     *
     * Two things this deliberately does not do, both of them refusals `REVIEW-SYSTEM.md` makes
     * out loud and both of them easy to "improve" into a lie:
     *
     *   - It answers with the *set of turns* that produced the hunk's lines, never with "the
     *     prompt that produced this hunk". Per-hunk-per-prompt is not achievable: a `Write`
     *     rewrites a whole file, the assistant edits through `Bash` where no file hook fires,
     *     and a person typing in the Terminal tab is seen by nothing.
     *   - Lines nobody watched are reported as unrecorded and are never attributed to the
     *     nearest turn. That is the state this screen is in most of the time.
     *
     * The report is taken at `-U0` and the diff on screen has three lines of context, so the
     * report's hunks are matched into the displayed one by overlap rather than by equality:
     * every `-U0` hunk inside a `-U3` hunk's range belongs to it, by construction.
     */
    hunkProvenance(index) {
      const range = this.hunks[index];

      if (!this.prov.available || !range) {
        return null;
      }

      const file = this.provFile;
      const matched = (file?.hunks || []).filter((h) => Math.max(h.to, h.from) >= range.from && h.from <= Math.max(range.to, range.from));
      const byTurn = new Map();
      let unrecorded = 0;
      let deletions = 0;

      matched.forEach((hunk) => {
        unrecorded += hunk.unrecorded || 0;

        if (hunk.deletion) {
          deletions += 1;
        }

        (hunk.turns || []).forEach((turn) => {
          const existing = byTurn.get(turn.turn) || { ...turn, lines: 0 };

          existing.lines += turn.lines || 0;
          // Swept only if it was swept everywhere. One tool record naming this file is enough
          // to say the turn edited it rather than carried it along.
          existing.swept = existing.swept && turn.swept;
          byTurn.set(turn.turn, existing);
        });
      });

      const turns = [...byTurn.values()]
        .sort((a, b) => b.lines - a.lines)
        .map((turn) => ({
          id:      turn.turn,
          label:   `Prompt ${ this.turnOrder.index.get(turn.turn) || '?' } of ${ this.turnOrder.total }`,
          prompt:  (turn.prompt || '').trim(),
          when:    ago(turn.at),
          at:      turn.at,
          lines:   turn.lines,
          who:     turn.who || turn.principal || '',
          screen:  turn.screen || '',
          swept:   !!turn.swept,
          subject: turn.subject || '',
        }));

      const deletion = !turns.length && !unrecorded && !!matched.length && deletions === matched.length;
      const missing = !matched.length && !!this.selected;

      return {
        turns,
        unrecorded,
        // Whether there is anything to draw. A strip with nothing in it is a border across the
        // diff that says nothing, which is worse than no strip.
        say: !!(turns.length || unrecorded || deletion || missing),
        // Nothing to attribute rather than nothing recorded: a hunk that only takes lines away
        // has no new line to blame, and the lines it removed were written by whatever wrote
        // them, which is not what this change did.
        deletion,
        // The file is not in the report at all. Said as itself rather than as "no prompt".
        missing,
      };
    },

    /** The hover text on a turn: everything the strip has no room for. */
    turnTitle(turn) {
      const bits = [];

      if (turn.at) {
        bits.push(`Asked ${ new Date(turn.at).toLocaleString() }.`);
      }

      bits.push(`${ turn.lines } line${ turn.lines === 1 ? '' : 's' } of this hunk came from that turn, resolved by blaming each line to the commit the turn ended in.`);

      if (turn.screen) {
        bits.push(`Sent from the ${ turn.screen } screen${ turn.who ? ` by ${ turn.who }` : '' }.`);
      } else {
        bits.push('Typed into the pod\'s terminal, so nobody is named for it: the pod has one conversation and no idea which Rancher user is looking at it.');
      }

      if (turn.swept) {
        bits.push('No file-editing tool in that turn named this file, so it was swept into the turn rather than caused by it - a Bash edit, or somebody typing in the pane.');
      }

      return bits.join(' ');
    },

    /** The line a comment on this hunk is anchored to: the hunk's first line in the new file. */
    hunkAnchor(index) {
      return this.hunks[index]?.from || 0;
    },

    /** The comments already left on one hunk. */
    commentsFor(index) {
      return this.fileComments.filter((c) => c.hunk === this.hunkAnchor(index));
    },

    /** `you · 2 minutes ago · on line 43` (38:1293). */
    commentByline(comment) {
      const who = comment.name || comment.principal || 'somebody Rancher did not name';
      const where = comment.hunk ? ` · on line ${ comment.hunk }` : '';

      return `${ who } · ${ ago(comment.at) }${ where }`;
    },

    /** What became of a comment: the delivery, said out loud rather than assumed. */
    commentState(comment) {
      if (comment.sentAt) {
        return comment.sentHow === 'queued'
          ? { icon: 'clock', tone: 'subtle', text: `queued for the assistant ${ ago(comment.sentAt) } - it is the first thing the next session is asked` }
          : { icon: 'sparkle', tone: 'success', text: `given to the assistant ${ ago(comment.sentAt) }` };
      }

      return { icon: 'user', tone: 'subtle', text: 'on the record, not sent to the assistant' };
    },

    initials,

    composerKey(index) {
      return `${ this.selected }:${ this.hunkAnchor(index) }`;
    },

    openComposer(index) {
      this.composing = this.composerKey(index);
      this.commentText = '';
    },

    closeComposer() {
      this.composing = '';
      this.commentText = '';
    },

    /**
     * A reviewer's sentence about one hunk, recorded and then routed.
     *
     * Recorded first and separately from being delivered, which is `addComment`'s whole reason
     * for existing: the two fail independently, and a comment that reached the record and not
     * the assistant is still a comment the author can read.
     *
     * `send` is the design's "Send to the assistant" (38:1296). It hands off through the
     * workspace rather than typing into the pod from here, because the workspace is where the
     * answer arrives: `?comment=<id>` is read by `editor.vue`, which loads the comment into the
     * session with its origin stamped, and marks it sent only when it was. Passing the id and
     * not the words is deliberate - a review comment is a record with an author and a time, and
     * a URL carrying the text would be a second copy of it that nothing could reconcile.
     *
     * Not sending is a real answer, not a lesser one. It leaves the sentence on the change with
     * a name and a time against it, which is what a reviewer wants when the point is a question
     * rather than an instruction. This screen does not offer to send it to "the author": git
     * records no author for an uncommitted working tree, and the masthead already declines to
     * name one rather than guessing.
     */
    async postComment(index, send) {
      const text = this.commentText.trim();

      if (!text || this.posting) {
        return;
      }

      this.posting = true;

      try {
        const comment = await addComment(this.extension, {
          packet: this.since?.packet || 0,
          file:   this.selected,
          hunk:   this.hunkAnchor(index),
          text,
        });

        this.review = await readReview(this.extension).catch(() => this.review);
        this.closeComposer();

        if (!send) {
          toastSuccess(
            this.$store,
            `Recorded on ${ this.selected } at line ${ comment.hunk }, in ${ comment.name || comment.principal }'s name. Nothing has been sent to the pod.`,
            { title: 'Comment left on the change' }
          );

          return;
        }

        this.$router.push({
          name:   EDITOR_ROUTE,
          params: { extension: this.extension },
          query:  { tab: 'terminal', comment: comment.id },
        });
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'Could not leave the comment' });
      } finally {
        this.posting = false;
      }
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
        const sha = (out.trim().split('\n').pop() || '').trim();

        // No commit, no sign-off. This is not defensive tidying: `commitExtension` returns the
        // empty string whenever the pod cannot be found or the exec comes back with nothing,
        // and it was observed doing exactly that - HEAD unmoved, the masthead still listing
        // uncommitted files, and an approval written with `sha: ''`. An empty sha is the worst
        // possible value to store, because `gateFrom` reads a sign-off as stale by comparing
        // shas and treats a blank one as "not about a particular commit": the approval would
        // silently cover every commit made after it, for ever. So the sign-off is refused and
        // the reviewer is told the commit is what failed.
        if (!/^[0-9a-f]{7,40}$/.test(sha)) {
          throw new Error(
            `The commit did not happen, so nothing has been signed - an approval with no commit behind it would cover every later commit instead of this one. git answered: ${ out.trim().slice(-300) || 'nothing at all' }`
          );
        }

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
        // The message is the second argument and the options the third (`toast.ts`). Passing
        // the sentence third put it where nothing reads it: the toast said "Done / Come back
        // to it" and dropped the half that tells you what happened.
        toastSuccess(
          this.$store,
          `${ this.extension } is marked as deferred on the review queue. Answering it clears the mark.`,
          { title: 'Come back to it' }
        );
        this.$router.push({ name: this.routes.REVIEW_QUEUE_ROUTE });
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'Could not defer this review' });
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

      <!-- 38:1117: the scope, as a readout that can be changed. See `scopeLabel`. -->
      <SMenu
        :items="scopeItems"
        align="right"
        aria-label="Choose which files to review"
        @select="setScope"
      >
        <template #trigger>
          <SChip
            :label="scopeLabel"
            :tone="fileScope === 'all' && !hideGenerated ? 'subtle' : 'info'"
            icon="compare"
            data-testid="rc-scope"
            :title="scopeTitle"
          />
        </template>
      </SMenu>
      <SButton variant="ghost" size="sm" icon="refresh" @click="load">
        Refresh
      </SButton>
    </div>

    <!-- What the narrowing is doing, or why it is not. One banner, four sentences - see
         `sinceNotice`. The testid changes with the state, so a refusal and an applied scope are
         never mistaken for each other. -->
    <SBanner
      v-if="sinceNotice"
      :type="sinceNotice.tone"
      class="rc__since"
      :data-testid="sinceNotice.testid"
    >
      {{ sinceNotice.text }}
    </SBanner>

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
            <div class="rc__criteria-head">
              <SLabel text="What this is for" />
              <!-- 38:1135. The packet quotes the brief; this opens the document it quotes, with
                   its open questions and its history, which no quote can carry. -->
              <button
                type="button"
                class="rc__link"
                data-testid="rc-open-brief"
                title="Opens this extension's brief: the whole document, its open questions and what has been agreed against it."
                @click="$router.push({ name: routes.BRIEF_ROUTE, params: { extension } })"
              >
                Open the brief
              </button>
            </div>
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
            <!-- The heading counts what is on the list, which is what the scope has left on it. -->
            <SLabel :text="scopedFiles.length === count
              ? `Changed files (${ count })`
              : `Changed files (${ scopedFiles.length } of ${ count })`" />

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
          <span class="rc__grow" />
          <!-- 38:1249. Measures the list and the diff from the commit "since" means. -->
          <SChip
            :label="sinceChip.label"
            :tone="sinceChip.tone"
            icon="undo"
            clickable
            data-testid="rc-since-last-look"
            :title="sinceChip.title"
            :class="{ 'rc__chip--off': sinceChip.disabled }"
            @click="toggleSince"
          />
          <!-- 38:1244. Takes the generated pile out of the list and the pane. -->
          <SChip
            :label="generatedChip.label"
            :tone="generatedChip.tone"
            icon="eye"
            clickable
            data-testid="rc-hide-generated"
            :title="generatedChip.title"
            @click="toggleGenerated"
          />
          <!-- how much of this change has a prompt behind it, before a reviewer reads a hunk -->
          <SChip
            v-if="provSummary.text"
            :label="provSummary.text"
            :tone="provSummary.tone"
            icon="sparkle"
            data-testid="rc-prov-summary"
            :title="prov.available
              ? 'The Studio records the prompt behind a line when the assistant works through it: each turn ends in a commit carrying its own id, and every line is blamed back to one. Lines with no turn behind them are reported as such and are never attributed to the nearest prompt.'
              : prov.reason"
          />
        </div>

        <div class="rc__code">
          <!--
            `paneFiles` as well as `count`: a change with nothing uncommitted can still have
            commits on it since the reviewer last looked, and "nothing to review" over a diff
            the "since" chip has just produced would be the screen contradicting itself.
          -->
          <SEmpty
            v-if="!count && !paneFiles.length && !loading"
            icon="check"
            title="Nothing to review"
            message="This extension matches its last commit."
          />
          <div v-else-if="diffing" class="rc__loading">
            <SIcon name="spinner" :size="20" class="rc__spin" />
            Reading {{ selected }}
          </div>
          <!--
            The scope is on and it covers nothing. Said as itself, with the way out on it: an
            empty pane over a change that has files in it is the one state a filter must never
            leave a reader in without explaining.
          -->
          <SEmpty
            v-else-if="!scopedFiles.length"
            icon="compare"
            title="Nothing in this scope"
            :message="`The filters above the diff leave nothing to read. This change has ${ count } file${ count === 1 ? '' : 's' } in it and none of them has gone anywhere.`"
            data-testid="rc-scope-empty"
          >
            <SButton variant="secondary" icon="file" data-testid="rc-scope-reset" @click="showAllFiles">
              Review all {{ count }} files
            </SButton>
          </SEmpty>
          <div v-else class="rc__code-inner">
            <DiffView :patch="patch">
              <!-- what produced this hunk (38:1256) -->
              <template #hunk-head="{ index }">
                <div v-if="hunkProv[index] && hunkProv[index].say" class="rc__prov" :data-testid="`rc-prov-${ index }`">
                  <template v-for="turn in hunkProv[index].turns" :key="turn.id">
                    <div class="rc__prov-row" :title="turnTitle(turn)">
                      <SIcon name="sparkle" :size="12" class="rc__prov-icon" />
                      <span class="rc__prov-what">{{ turn.label }}</span>
                      <span class="rc__prov-quote">{{ turn.prompt || 'the prompt for that turn was not kept' }}</span>
                      <span class="rc__prov-meta">
                        {{ turn.lines }} line{{ turn.lines === 1 ? '' : 's' }}<template v-if="turn.when"> · {{ turn.when }}</template>
                        <template v-if="turn.swept"> · swept in, not named</template>
                      </span>
                      <!-- 38:1264. The pod has one conversation and the workspace's pane is
                           attached to it, so this opens that, and the title says it cannot be
                           opened at a particular prompt because a terminal has no such address. -->
                      <button
                        type="button"
                        class="rc__link"
                        :data-testid="`rc-conversation-${ index }`"
                        title="Opens the workspace terminal, which is attached to the one conversation this pod has. A terminal cannot be opened at a particular prompt, so it opens where the conversation is now."
                        @click="$router.push({ name: routes.EDITOR_ROUTE, params: { extension }, query: { tab: 'terminal' } })"
                      >
                        See the conversation
                      </button>
                    </div>
                  </template>

                  <!-- the honest empty state, and the one a reviewer sees most often -->
                  <div
                    v-if="hunkProv[index].unrecorded"
                    class="rc__prov-row rc__prov-row--none"
                    :data-testid="`rc-unrecorded-${ index }`"
                    title="Every one of these lines is either still uncommitted or in a commit with no turn recorded against it. The nearest prompt is not the answer, so none is named."
                  >
                    <SIcon name="clock" :size="12" class="rc__prov-icon" />
                    <span class="rc__prov-what">
                      {{ hunkProv[index].unrecorded }} line{{ hunkProv[index].unrecorded === 1 ? '' : 's' }}
                      changed in the pod, no prompt recorded
                    </span>
                  </div>

                  <div v-else-if="hunkProv[index].deletion" class="rc__prov-row rc__prov-row--none">
                    <SIcon name="clock" :size="12" class="rc__prov-icon" />
                    <span class="rc__prov-what">
                      Lines taken away. There is no new line to attribute, so nothing is claimed
                      about what removed them.
                    </span>
                  </div>

                  <div v-else-if="hunkProv[index].missing" class="rc__prov-row rc__prov-row--none">
                    <SIcon name="clock" :size="12" class="rc__prov-icon" />
                    <span class="rc__prov-what">This file is not in the provenance report, so nothing is known about what produced it.</span>
                  </div>
                </div>
              </template>

              <!-- the thread on this hunk (38:1286), and the box that starts one -->
              <template #hunk-foot="{ index }">
                <div class="rc__thread">
                  <div
                    v-for="c in commentsFor(index)"
                    :key="c.id"
                    class="rc__comment"
                    :data-testid="`rc-comment-${ c.id }`"
                  >
                    <span class="rc__avatar" :title="c.principal">{{ initials(c.name || c.principal) }}</span>
                    <div class="rc__comment-body">
                      <div class="rc__comment-byline">{{ commentByline(c) }}</div>
                      <div class="rc__comment-text">{{ c.text }}</div>
                      <div class="rc__comment-state" :class="`rc__comment-state--${ commentState(c).tone }`">
                        <SIcon :name="commentState(c).icon" :size="11" />
                        {{ commentState(c).text }}
                      </div>
                    </div>
                  </div>

                  <div v-if="composing === composerKey(index)" class="rc__composer">
                    <SField
                      v-model="commentText"
                      multiline
                      :rows="3"
                      autofocus
                      :input-testid="`rc-comment-input-${ index }`"
                      :placeholder="`What should change about line ${ hunkAnchor(index) }?`"
                      hint="It is recorded against this line with your name on it either way. Sending it puts it to the assistant in this extension's pod as the instruction to work from, so you never write the fix."
                    />
                    <div class="rc__composer-actions">
                      <SButton variant="ghost" size="sm" :disabled="posting" @click="closeComposer">
                        Cancel
                      </SButton>
                      <span class="rc__grow" />
                      <SButton
                        variant="neutral"
                        size="sm"
                        icon="user"
                        :disabled="!commentText.trim() || posting"
                        :data-testid="`rc-comment-record-${ index }`"
                        title="Leaves it on the change with your name and the time against it, and sends nothing to the pod. Git records no author for an uncommitted working tree, so there is nobody to address it to by name - it waits here for whoever opens the review next."
                        @click="postComment(index, false)"
                      >
                        Just record it
                      </SButton>
                      <SButton
                        variant="primary"
                        size="sm"
                        icon="sparkle"
                        :loading="posting"
                        :disabled="!commentText.trim()"
                        :data-testid="`rc-comment-send-${ index }`"
                        @click="postComment(index, true)"
                      >
                        Send to the assistant
                      </SButton>
                    </div>
                  </div>

                  <button
                    v-else
                    type="button"
                    class="rc__comment-add"
                    :data-testid="`rc-comment-on-${ index }`"
                    @click="openComposer(index)"
                  >
                    <SIcon name="plus" :size="11" />
                    Comment on line {{ hunkAnchor(index) }}
                  </button>
                </div>
              </template>
            </DiffView>

            <!-- comments whose line is no longer a hunk. Shown rather than lost. -->
            <div v-if="strayComments.length" class="rc__thread rc__thread--stray">
              <SLabel :text="`Earlier comments on ${ selected }`" />
              <p class="rc__section-note">
                The lines these were written against are not part of the diff any more, so they
                have nowhere to sit. They are still on the record.
              </p>
              <div v-for="c in strayComments" :key="c.id" class="rc__comment">
                <span class="rc__avatar" :title="c.principal">{{ initials(c.name || c.principal) }}</span>
                <div class="rc__comment-body">
                  <div class="rc__comment-byline">{{ commentByline(c) }}</div>
                  <div class="rc__comment-text">{{ c.text }}</div>
                  <div class="rc__comment-state" :class="`rc__comment-state--${ commentState(c).tone }`">
                    <SIcon :name="commentState(c).icon" :size="11" />
                    {{ commentState(c).text }}
                  </div>
                </div>
              </div>
            </div>
          </div>
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

  // The "since your last look" line sits between the masthead and the body and must not be
  // squeezed by the body growing into it.
  &__since {
    flex:   0 0 auto;
    margin: var(--studio-space-8) var(--studio-space-16) 0;
  }

  // A chip whose control has nothing to act on. Still drawn, still says why in its title, but
  // dimmed so it does not read as a filter somebody forgot to turn on.
  &__chip--off {
    opacity: 0.55;
    cursor:  default;
  }

  // One flex child of __code, so the diff and anything under it stack instead of sitting
  // side by side (the pane is a flex row, which is what makes the diff fill it).
  &__code-inner {
    min-width: 0;
  }

  // A caption-weight link inside a heading row: the design's blue text (38:1135, 38:1264)
  // rather than a button, because it goes somewhere rather than doing something.
  &__link {
    background:  none;
    border:      none;
    padding:     0;
    font:        var(--studio-caption-12-semi);
    color:       var(--studio-text-link);
    cursor:      pointer;
    white-space: nowrap;

    &:hover { text-decoration: underline; }
  }

  // ------------------------------------------------------------------------
  // What produced a hunk (38:1256), and the thread on it (38:1286).
  //
  // Both sit inside the diff table, in a row of their own, so they are the width of the diff
  // and cannot be mistaken for a line of it: no code font, a tinted ground, and a rule above
  // the strip to separate it from the hunk before.
  // ------------------------------------------------------------------------
  &__prov {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-2);
    padding:        var(--studio-space-6) var(--studio-space-10);
    background:     var(--studio-surface-subtle);
    border-top:     1px solid var(--studio-border-subtle);
    border-bottom:  1px solid var(--studio-border-subtle);
  }

  &__prov-row {
    display:     flex;
    align-items: baseline;
    gap:         var(--studio-space-8);
    font:        var(--studio-caption-12);
    color:       var(--studio-text-secondary);

    &--none { color: var(--studio-text-tertiary); }
  }

  &__prov-icon {
    flex:      0 0 auto;
    align-self: center;
    color:     var(--studio-text-tertiary);
  }

  &__prov-what {
    font:  var(--studio-caption-12-semi);
    color: var(--studio-text);
    flex:  0 0 auto;

    .rc__prov-row--none & {
      font:  var(--studio-caption-12);
      color: var(--studio-text-tertiary);
    }
  }

  // The prompt, quoted verbatim. One line: the whole of it is in the hover text and a
  // four-paragraph prompt would push the diff off the screen.
  &__prov-quote {
    flex:          1 1 auto;
    min-width:     0;
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
    font-style:    italic;

    &::before { content: '\201C'; }
    &::after  { content: '\201D'; }
  }

  &__prov-meta {
    flex:        0 0 auto;
    color:       var(--studio-text-tertiary);
    white-space: nowrap;
  }

  &__thread {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-8);
    padding:        var(--studio-space-8) var(--studio-space-10);
    border-top:     1px solid var(--studio-border-subtle);

    &--stray {
      border:        1px solid var(--studio-border);
      border-radius: var(--studio-radius);
      margin:        var(--studio-space-12) 0;
    }
  }

  &__comment {
    display: flex;
    gap:     var(--studio-space-8);
  }

  &__avatar {
    flex:            0 0 auto;
    width:           22px;
    height:          22px;
    border-radius:   var(--studio-radius-pill);
    background:      var(--studio-surface-nav);
    border:          1px solid var(--studio-border);
    display:         flex;
    align-items:     center;
    justify-content: center;
    font:            var(--studio-caption-11-caps);
    color:           var(--studio-text-secondary);
  }

  &__comment-body {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-2);
    min-width:      0;
  }

  &__comment-byline {
    font:  var(--studio-caption-12-semi);
    color: var(--studio-text-secondary);
  }

  &__comment-text {
    font:        var(--studio-body-13);
    color:       var(--studio-text);
    white-space: pre-wrap;
  }

  &__comment-state {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-4);
    font:        var(--studio-caption-12);
    color:       var(--studio-text-tertiary);

    &--success { color: var(--studio-success); }
  }

  &__comment-add {
    align-self:    flex-start;
    display:       flex;
    align-items:   center;
    gap:           var(--studio-space-4);
    padding:       var(--studio-space-2) var(--studio-space-8);
    background:    none;
    border:        1px dashed var(--studio-border);
    border-radius: var(--studio-radius-control);
    font:          var(--studio-caption-12);
    color:         var(--studio-text-secondary);
    cursor:        pointer;

    &:hover {
      border-style: solid;
      color:        var(--studio-text);
    }
  }

  &__composer {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-8);
  }

  &__composer-actions {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
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
