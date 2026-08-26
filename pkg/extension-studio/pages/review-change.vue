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
import pageActionsMixin from '@shell/mixins/page-actions';
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
  readExtensionFile, writeExtensionFile, commitExtension, extensionUrl, extensionReady,
  extensionProxyPath, listBranches, baselineRef,
  deferReview, clearDeferral, changeProvenance, publishedVersion, askAssistant, provenanceFor,
  workingDiff, assistantLogin,
  DEFAULT_EXTENSION
} from '../extensions';
import {
  readReview, signCodeReview, gateFrom, addComment, markLook, sinceLastLook, markCommentSent,
  packetPullRequest, assessRisk, originStamp, packetProvenance, accumulatingPacket
} from '../review';
import { changeChecks, checksSummary } from '../change-checks';
import {
  askForDraft, readDrafts, discardDraft, draftPatch, draftSize
} from '../review-draft';
import { readFailure } from '../publish-failure';
import { applyProposedFix } from '../publish-fix';
import {
  REVIEW_QUEUE_ROUTE, EDITOR_ROUTE, BRIEF_ROUTE, STUDIO_PAGE_ACTIONS, handleStudioPageAction
} from '../editor-product';
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

/**
 * Put a question into the brief's `## Open questions`, in the shape screen 10 reads.
 *
 * The format is that screen's, not this one's: `- **Worth asking** <text>` with an indented
 * `Why:` under it (`pages/brief.vue`, `questionsBody`). Written by hand rather than through that
 * component's form because the form rewrites the whole document from its own state, and this
 * screen has one question to add and no business restating the other nine sections.
 *
 * Three shapes of brief have to survive this. One with the section and questions in it: append.
 * One with the section holding `_none open_`, which is how the form writes "there are none":
 * replace that line, because leaving it above a question would render an empty state over a
 * populated list. One with no section at all: add the heading at the end, which is where a new
 * section can go without moving anything a reader has already got their bearings from.
 */
function addOpenQuestion(brief, text, why) {
  const question = [`- **Worth asking** ${ text.trim().replace(/\s+/g, ' ') }`, `  Why: ${ why }`].join('\n');
  const lines = (brief || '').split('\n');
  const start = lines.findIndex((line) => /^##\s+open questions\s*$/i.test(line.trim()));

  if (start < 0) {
    const body = (brief || '').replace(/\s*$/, '');

    return `${ body ? `${ body }\n\n` : '' }## Open questions\n\n${ question }\n`;
  }

  let end = lines.length;

  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }

  const section = lines.slice(start + 1, end);
  const placeholder = section.findIndex((line) => /^_none open_\s*$/i.test(line.trim()));

  if (placeholder >= 0) {
    section.splice(placeholder, 1, question);
  } else {
    // After the last non-blank line of the section, so the question joins the list rather than
    // landing under the blank line that separates the section from the next heading.
    let last = section.length;

    while (last > 0 && !section[last - 1].trim()) {
      last -= 1;
    }

    section.splice(last, 0, question);
  }

  return [...lines.slice(0, start + 1), ...section, ...lines.slice(end)].join('\n');
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

  mixins: [fullBleed, pageActionsMixin],

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
      // What the masthead's GitHub chip knows, as `packetPullRequest` (review.ts) answered it.
      // `state` is the whole of it and every value carries a whole sentence in `prSentence`:
      //   checking   - the question is out
      //   recorded   - the hand-over opened one and the packet records it. No network needed.
      //   found      - the record had none and GitHub has an open one on the packet's branch
      //   failed     - the hand-over tried to open one and GitHub refused; `prError` says why
      //   none       - the packet is pushed and there is no open pull request on its branch
      //   unasked    - nothing could be asked: no token, no repository, or GitHub did not answer
      //   no-packet  - nothing has been handed over, so there is no hand-off to have a record of
      pr:       null,
      prState:  'checking',
      prError:  '',
      prSentence: '',
      repo:     '',
      // The branch the packet was pushed on - `git branch -f`, never checked out. Kept apart
      // from `branch` below, which is the branch the pod actually has: conflating the two is
      // what made the GitHub chip ask about the wrong head for as long as it did.
      prBranch: '',
      prPacket: 0,
      // The branch the working tree is on, for the masthead's provenance line. A fact about
      // where the work sits, and not the head any pull request would point at.
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
      // The packet's own copy of the same question (`packetProvenance`), read from the git note
      // the hand-over wrote. Two different facts, both worth having: `prov` is the pod as it is
      // now, this is what the reviewer was actually handed. See `handedOver`.
      packetProv:  null,
      // What the pod has gathered since that hand-over (`accumulatingPacket`), which is the
      // measure of how far the two above have drifted apart.
      accumulation: null,
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
      // The whole change as one patch, for the machine checks (38:1215). The file on screen is
      // not enough: a check that only read what the reviewer happened to click on is a check
      // that misses whatever they have not clicked on yet.
      changePatch:   '',
      l10n:          '',
      baseline:      null,
      failure:       null,
      checksOpen:    true,
      // Whether the assistant in this pod has a credential, so a draft that will never arrive
      // can say why rather than spinning. See `assistantLogin`.
      login:         null,
      // The assistant's drafted fixes (38:1306), keyed by the comment each answers, read out of
      // the pod rather than held here - see review-draft.ts for why /tmp and not the package.
      drafts:        {},
      draftAsking:   '',
      draftPolling:  false,
      draftTimer:    null,
      // Which draft's diff is open (38:1314, "See the fix"), and the patch it renders.
      showingDraft:  '',
      draftDiff:     null,
      draftLoading:  false,
      applyingDraft: false,
      // "Talk to the author" (38:1125), and what is being said.
      talking:       false,
      talkNote:      '',
      // "This is a UX decision, not a code one" (38:1437), and the question being handed over.
      rerouting:     false,
      rerouteNote:   '',
      rerouteWhy:    '',
      rerouted:      false,
      // The rendered-result pane's three-way switch (38:1354). `after` is the design's selected
      // segment and the pane's own default: the dev server serving the working tree.
      visualMode:    'after',
      // Where the preview is pointed, reported by the panel, so the Before frame can be pointed
      // at the same page of the installed build.
      previewPath:   '/',
      // The two directions of 38:1419. `inspecting` intercepts clicks inside the framed page and
      // answers with the file that drew what was clicked; `lineTarget` is the last diff line
      // whose file was outlined in the preview.
      inspecting:    false,
      inspectSays:   '',
      activeLine:    null,
      lineSays:      '',
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

    /**
     * How much attention this change wants (38:1108), from `assessRisk` in review.ts.
     *
     * The masthead used to count files - `count > 8 ? high : count > 3 ? medium : low` - while
     * the queue read the paths and the numstat. The same eight-line change to the entry point
     * was "medium" one screen back and "low risk" here, in the same minute, off the same
     * files. Cross-screen rule: one reading, called by both. The reason comes with it, so the
     * chip can say why on hover instead of leaving the rating unexplained.
     */
    riskReading() {
      return assessRisk(this.files);
    },

    risk() {
      return this.riskReading.level;
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

    /**
     * What Rancher's header kebab offers here (Figma 38:1060).
     *
     * The same list screens 01, 02, 03 and 11 commit, for the reason editor-product.ts gives:
     * one menu, so the kebab cannot mean different things on different Studio screens. It was
     * missing here for the reason it was missing on the workspace - the Studio's routes use the
     * `plain` layout, which commits no `pageActions`, and Rancher only draws the control for a
     * page that has committed some. So a reviewer lost the overflow menu by opening a change.
     *
     * Not filtered the way the queue filters it. The queue drops "Review queue" because that is
     * the page you are on; this is not that page, and getting back to the list is the one thing
     * a reviewer wants from a menu here.
     */
    pageActions() {
      return STUDIO_PAGE_ACTIONS;
    },

    /**
     * Every comment thread on this change, oldest first.
     *
     * A thread is one anchor - a file and a line - and every comment left on it. Grouped rather
     * than counted flat, because two sentences about the same line are one point being made and
     * the decision bar's count is a count of points.
     */
    threads() {
      const byAnchor = new Map();

      (this.review.comments || []).forEach((c) => {
        const key = `${ c.file }:${ c.hunk }`;
        const thread = byAnchor.get(key) || {
          key, file: c.file, hunk: c.hunk, comments: [],
        };

        thread.comments.push(c);
        byAnchor.set(key, thread);
      });

      return [...byAnchor.values()]
        .map((t) => ({
          ...t,
          comments: t.comments.sort((a, b) => String(a.at).localeCompare(String(b.at))),
        }))
        .sort((a, b) => String(a.comments[0].at).localeCompare(String(b.comments[0].at)));
    },

    /**
     * The label on Request changes (38:1442), counting the threads that would go back with it.
     *
     * It used to count sign-offs whose verdict was `changes-requested`, which can only ever be
     * 0, 1 or 2 and is a count of decisions already taken rather than of points still open. The
     * design's "(1 open)" sits beside a single open comment thread, and that is the number: how
     * much unanswered reviewing is attached to the change the button sends back.
     *
     * Nothing in this product resolves a thread, so every thread is open. That is not a gap
     * being papered over - a comment is answered by the change being made, and the next packet
     * is where that shows - but it does mean the count only ever grows within one packet, which
     * is what the title says out loud.
     */
    openRequests() {
      return this.threads.length;
    },

    /** Why the count is what it is, since a number on a button explains nothing by itself. */
    requestTitle() {
      const n = this.openRequests;
      const already = [this.gate.code, this.gate.outcome].filter((s) => s?.verdict === 'changes-requested').length;
      const bits = [
        n
          ? `${ n } comment thread${ n === 1 ? '' : 's' } on this change would go back with it. Nothing here marks a thread as resolved: a comment is answered by the change being made, so the count covers every thread left on this packet.`
          : 'No comment threads have been left on this change. Sending it back records the reason you type and puts it to the assistant in this extension\'s pod.',
      ];

      if (already) {
        bits.push(`${ already } sign-off on this change already says changes were requested.`);
      }

      return bits.join(' ');
    },

    /**
     * The machine checks (38:1215), over the whole change rather than the file on screen.
     *
     * Five rows because the design draws five, and each says what it actually did. Two are a real
     * scan of the patch, one is a real reading of the patch against this extension's translation
     * file, and two report that they could not run and why. See change-checks.ts: the rule is
     * that nothing which did not run is ever drawn as a pass.
     */
    checks() {
      return changeChecks({
        patch: this.changePatch,
        l10n:  this.l10n,
        build: {
          installed: this.version,
          failure:   this.failure
            ? {
              message: this.failure.message || 'no reason recorded',
              at:      new Date(this.failure.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            }
            : null,
        },
      });
    },

    /** Named apart from the imported `checksSummary` it calls, so neither shadows the other. */
    checksLine() {
      return checksSummary(this.checks);
    },

    checksTone() {
      if (this.checks.some((c) => c.state === 'warn')) {
        return 'warning';
      }

      return this.checks.every((c) => c.state === 'pass') ? 'success' : 'subtle';
    },

    /**
     * Who this change is somebody's to talk to (38:1125).
     *
     * Three sources, in order of how much they mean. The packet's own `by` is the best of them:
     * a hand-over is an act by a named Rancher principal and the record keeps who performed it,
     * which is exactly "the author of the change being reviewed". Failing that, the author git
     * recorded on the last commit. Failing both, nobody - and this screen has always refused to
     * name an author for an uncommitted working tree, because git records none and the pod's one
     * conversation is shared.
     */
    author() {
      const packets = Object.values(this.review.packets || {});
      const latest = packets.sort((a, b) => (a.n || 0) - (b.n || 0)).pop();

      if (latest?.by || latest?.byName) {
        return {
          name:      latest.byName || latest.by,
          principal: latest.by || '',
          how:       `handed packet ${ latest.n } over for review`,
          when:      ago(latest.at),
        };
      }

      if (this.provenance.commit.author) {
        return {
          name:      this.provenance.commit.author,
          principal: '',
          how:       `committed ${ this.provenance.commit.sha }`,
          when:      ago(this.provenance.commit.when),
        };
      }

      return null;
    },

    talkChip() {
      if (!this.author) {
        return {
          label:    'No author recorded',
          disabled: true,
          title:    'Nobody is recorded as the author of this change. Git records no author for an uncommitted working tree, and nothing has been handed over for review, so there is no name to address a message to. It gets one as soon as somebody commits or hands it over.',
        };
      }

      return {
        label:    'Talk to the author',
        disabled: false,
        title:    `${ this.author.name } ${ this.author.how } ${ this.author.when }. Rancher has no messaging, so this leaves a message for them on the change itself, with your name and the time on it, where they see it when they next open this review.`,
      };
    },

    /**
     * Where the Before pane can point, and what it honestly is (38:1401).
     *
     * The only unchanged rendering of this extension that exists anywhere is the build installed
     * in this Rancher: a version that was published, is running, and does not have the working
     * tree's edits in it. Nothing captures a screenshot before an edit, and nothing can render a
     * commit that was never built, so when nothing is installed there is no Before at all and the
     * segment says so instead of framing something else.
     *
     * The second half of the sentence matters as much as the first: what is installed is only the
     * point the change is measured from when the baseline is that same installed version. When it
     * is not - nothing published, or a hand-over since - the note says which point it really is,
     * because "Before" implying the wrong commit is the way this pane could lie.
     */
    beforeAvailable() {
      return !!this.version;
    },

    /** The dev server's own root-relative path, for the frame the overlay stacks underneath. */
    proxyPath() {
      return extensionProxyPath(this.extension);
    },

    beforeUrl() {
      return this.beforeAvailable ? `/dashboard${ this.previewPath.startsWith('/') ? '' : '/' }${ this.previewPath }` : '';
    },

    beforeNote() {
      if (!this.beforeAvailable) {
        return 'No version of this extension is installed in this Rancher, so there is no unchanged rendering of it anywhere to show. Nothing captures a picture of a page before an edit, and a commit that was never built cannot be rendered, so Before is empty rather than guessed at.';
      }

      // `baselineRef`'s own label is a whole clause ("nothing has been published yet, so this is
      // measured against the last commit"), which reads as an explanation and not as a noun. The
      // note needs the noun, the same way the preview panel's marker does.
      const noun = {
        oci:   'the last version handed over',
        local: 'the last version published into this Rancher',
        head:  'the last commit in the pod',
        none:  'nothing, because the pod has no history yet',
      }[this.baseline?.kind] || 'a point this screen could not identify';

      const same = this.baseline?.kind === 'local'
        ? 'That is also the point the diff is measured from, so the difference between the two panes is the change.'
        : `The diff, though, is measured from ${ noun }, so the difference between the two panes is not exactly the diff.`;

      return `Before is v${ this.version }, the build installed in this Rancher, running on this Rancher's own pages. ${ same }`;
    },

    /** The comments whose answer is still out, which is what keeps the poll alive. */
    waitingDrafts() {
      return Object.keys(this.drafts).filter((id) => this.drafts[id] === null);
    },

    visualModes() {
      return [
        {
          id: 'before', label: 'Before', disabled: !this.beforeAvailable,
        },
        { id: 'after', label: 'After', disabled: false },
        {
          id: 'overlay', label: 'Overlay', disabled: !this.beforeAvailable,
        },
      ];
    },

    visualNote() {
      if (this.visualMode === 'before') {
        return this.beforeNote;
      }

      if (this.visualMode === 'overlay') {
        return `${ this.beforeNote } The two are stacked, the installed build under the working tree, so anything that moved shows as a doubled edge.`;
      }

      return '';
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

    /**
     * What the packet carried when it was handed over, as against what the pod holds now.
     *
     * Two readings of one question and they answer it about different moments. `provenanceFor`
     * asks the pod what produced the lines that are in it, which is the better answer while the
     * pod still holds the change and the only answer for work that was never handed over. The
     * git note `assemblePacket` writes asks what was gathered behind the packet, which is what
     * the reviewer was actually asked to look at, and it goes on being true after the pod has
     * been restarted, the log pruned or the branch moved.
     *
     * They disagree as soon as the author carries on working, and that disagreement is the
     * useful part rather than a fault to resolve: it is the measure of how far the change has
     * moved since somebody asked for a review of it. So both are shown, each labelled with which
     * moment it describes, and neither is silently preferred.
     *
     * The note is also the only place the prompts live. Line-level attribution needs a turn that
     * *ended*, and a pod whose claude is signed out ends none - which is every pod in this
     * cluster - so the per-hunk strip says "no prompt recorded" and is right to. The prompts
     * were still recorded when they were submitted, and until this was read they travelled with
     * nothing. They are a record of what was asked for, not of which line came from which ask,
     * and the section says exactly that so the two are never confused.
     */
    handedOver() {
      const note = this.packetProv;

      if (!note) {
        return null;
      }

      if (!note.read) {
        return { state: 'none', sentence: note.reason, turns: [] };
      }

      const turns = (note.turns || [])
        .slice()
        .sort((a, b) => String(a.at).localeCompare(String(b.at)))
        .map((turn, i) => ({
          id:     turn.turn || `t${ i }`,
          label:  `Prompt ${ i + 1 } of ${ note.turns.length }`,
          prompt: (turn.prompt || '').trim(),
          when:   ago(turn.at),
          who:    turn.who || turn.principal || '',
          screen: turn.screen || '',
          ended:  !!turn.commit,
        }));

      return {
        state:    'read',
        packet:   note.packet,
        sha:      note.sha,
        at:       note.at,
        by:       note.by,
        sentence: note.sentence,
        turns,
      };
    },

    /**
     * Whether the pod has moved on since the hand-over, and by how much.
     *
     * Information rather than an error. A reviewer who is reading a diff of the pod while a
     * packet sits at an older commit is reading something nobody asked them to read, and the
     * only wrong thing to do about that is to say nothing.
     */
    handedOverDrift() {
      const note = this.packetProv;

      if (!note?.read || !note.sha) {
        return '';
      }

      const head = (this.provenance.commit.sha || '').trim();
      const moved = head && !note.sha.startsWith(head) && !head.startsWith(note.sha);

      if (!moved && !this.count) {
        return `The pod still holds exactly what packet ${ note.packet } was assembled from, so the diff below and the packet are the same change.`;
      }

      const bits = [];

      if (moved) {
        bits.push(`Packet ${ note.packet } was assembled at ${ note.sha.slice(0, 7) }${ note.at ? ` ${ ago(note.at) }` : '' } and the pod's last commit is now ${ head.slice(0, 7) }.`);
      }

      if (this.count) {
        bits.push(`${ this.count } file${ this.count === 1 ? '' : 's' } in the pod ${ this.count === 1 ? 'is' : 'are' } uncommitted on top of that.`);
      }

      bits.push('The diff below is the pod as it is now, not the packet as it was handed over.');

      if (this.accumulation?.read && this.accumulation.handedOver) {
        bits.push(this.accumulation.sentence);
      }

      return bits.join(' ');
    },

    /**
     * Comments about the change rather than about a line of it, oldest first.
     *
     * A message to the author and a point handed over as a design question are both about the
     * change as a whole, so neither has a file or a line. They need a home that does not depend
     * on which file is selected: hung off a file, they would be invisible until somebody clicked
     * the right one, and hung off a line they would be claiming an anchor they have not got.
     */
    changeComments() {
      return (this.review.comments || [])
        .filter((c) => !c.file && !c.hunk)
        .sort((a, b) => String(a.at).localeCompare(String(b.at)));
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
      const packet = this.prPacket ? `packet ${ this.prPacket }` : 'this change';

      if (this.prState === 'unasked') {
        // Three different reasons nothing could be asked, and they are not the same press.
        if (this.prError) {
          return { label: 'Could not ask GitHub', tone: 'error', action: 'retry' };
        }

        return this.repo
          ? { label: 'No GitHub token', tone: 'warning', action: 'settings' }
          : { label: 'No GitHub repository', tone: 'warning', action: '' };
      }

      const chips = {
        checking:   { label: 'Checking GitHub…', tone: 'subtle', action: '' },
        recorded:   { label: `PR #${ this.pr?.number } opened`, tone: 'success', action: 'open' },
        found:      { label: `PR #${ this.pr?.number } open`, tone: 'success', action: 'open' },
        failed:     { label: 'Pull request not opened', tone: 'error', action: 'retry' },
        none:       { label: `No PR for ${ packet }`, tone: 'default', action: 'list' },
        'no-packet': { label: 'Not handed over yet', tone: 'default', action: '' },
      };

      return chips[this.prState] || chips.checking;
    },

    /**
     * The hover text: the whole fact, where the chip only has room for the headline.
     *
     * `packetPullRequest` returns a sentence for every state it can be in, so this is that
     * sentence plus what the press does, rather than a second set of words that can drift
     * from the first.
     */
    prTitle() {
      if (this.prState === 'checking') {
        return 'Reading the hand-over record, and asking GitHub only if it has no answer';
      }

      const press = {
        open:     ' Opens the pull request.',
        list:     ` Opens ${ this.repo }'s pull requests.`,
        settings: ' Opens the editor settings.',
        retry:    ' Press to ask again.',
      }[this.prChip.action] || '';

      return `${ this.prSentence }${ press }`;
    },
  },

  watch: {
    selected(path, was) {
      this.loadDiff();

      // The outline was drawn for the file that was on screen. Leaving it there after the
      // selection moves is an outline that claims a different file drew it.
      if (path !== was) {
        this.clearLine();
      }
    },

    /**
     * The click listener lives in the framed document, and switching mode swaps the frame.
     *
     * Without this, turning inspection on and then switching to Overlay leaves the listener on a
     * hidden document and the chip saying it is on while nothing answers.
     */
    visualMode() {
      this.clearLine();

      if (this.inspecting) {
        this.detachInspect();
        this.$nextTick(() => this.attachInspect());
      }
    },
  },

  mounted() {
    this.load();
  },

  /**
   * Leave nothing running and nothing hanging in somebody else's document.
   *
   * The poll is this component's and dies with it. The outline and the click listener are not:
   * they are in the framed page, and a listener left behind on a document this screen no longer
   * owns would go on swallowing clicks in a preview the workspace is showing.
   */
  beforeUnmount() {
    this.stopPollingDrafts();
    this.detachInspect();
    this.clearLine();
  },

  methods: {
    async load() {
      // A freshly created extension has no repository yet, and every reading on this screen
      // is a git reading - so without this the screen is simply empty, with nothing saying
      // why. Memoised and idempotent, so this costs one exec the first time and nothing after.
      await ensureRepo(this.extension).catch(() => {});

      this.loading = true;

      const [files, brief, provenance, version, review, prov, branches] = await Promise.all([
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
        // The branch the working tree is on, for the provenance line. Read here rather than in
        // `checkPullRequest`, because that question is about the packet's branch and this one
        // is about the pod's, and one field answering both is what made the GitHub chip ask
        // GitHub about a head no pull request could ever have.
        listBranches(this.extension).catch(() => null),
      ]);

      this.files = files;
      this.brief = brief;
      this.provenance = provenance;
      this.version = version;
      this.review = review;
      this.prov = prov;
      this.branch = branches?.current || '';
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

      this.loadChecks();
      this.loadDrafts();
      this.loadPacketProvenance();
    },

    /**
     * The packet's own provenance note, and what has piled up since it was written.
     *
     * After the screen is up, like the checks, and for the same reason: both are readings about
     * the change rather than the change itself, and neither is worth a second of blank screen.
     */
    async loadPacketProvenance() {
      const [note, accumulation] = await Promise.all([
        packetProvenance(this.extension).catch((e) => ({
          read: false, reason: e?.message || String(e), turns: [],
        })),
        accumulatingPacket(this.extension).catch(() => null),
      ]);

      this.packetProv = note;
      this.accumulation = accumulation;
    },

    /**
     * What the machine checks read, fetched after the screen is up rather than with it.
     *
     * `workingDiff` writes the index (`git add -A -N`, so untracked files are in the diff at
     * all), and `index.lock` is one file: running it inside the same `Promise.all` as the other
     * git readings is two writers on one lock, and the loser silently does nothing. So it is
     * sequential and it is late, because a check section that is a second behind the diff costs
     * nothing and a diff that is a second behind itself costs the whole screen.
     */
    async loadChecks() {
      this.failure = readFailure(this.extension);

      const [patch, l10n, baseline] = await Promise.all([
        workingDiff(this.extension).catch(() => ''),
        readExtensionFile(this.extension, 'l10n/en-us.yaml').catch(() => ''),
        baselineRef(this.extension).catch(() => null),
      ]);

      this.changePatch = patch;
      this.l10n = l10n;
      this.baseline = baseline;
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
     * Which pull request this change is, asked of `packetPullRequest` (review.ts).
     *
     * This screen used to ask GitHub itself, about `listBranches().current`. That is the branch
     * the pod has checked out, and it is never the packet's branch: a hand-over writes the
     * packet branch with `git branch -f` and never checks it out, so the question was always
     * about the wrong head and the chip could not find a pull request that existed. It also
     * asked GitHub before looking at the record, so a recorded PR needed a token to be seen.
     *
     * `packetPullRequest` answers from the packet record first - which needs no network and no
     * credential - and only asks GitHub about the packet's own branch when the record is
     * silent. Every state it returns carries a sentence, which is what `prTitle` renders.
     */
    async checkPullRequest() {
      this.prState = 'checking';
      this.pr = null;
      this.prError = '';
      this.prSentence = '';

      const answer = await packetPullRequest(this.extension).catch((e) => ({
        state:    'unasked',
        packet:   0,
        branch:   '',
        repo:     '',
        pr:       null,
        error:    e?.message || String(e),
        sentence: `The hand-over record could not be read: ${ e?.message || String(e) }`,
      }));

      this.prState = answer.state;
      this.prPacket = answer.packet;
      this.prBranch = answer.branch;
      this.repo = answer.repo;
      this.pr = answer.pr;
      this.prError = answer.error;
      this.prSentence = answer.sentence;
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
        toastError(this.$store, this.prSentence || this.prError, { title: 'No pull request to open' });
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

    /** One of the header kebab's items was chosen. Dispatched here by the same mixin. */
    handlePageAction(action) {
      handleStudioPageAction(this, action);
    },

    // --- the assistant's drafted fix (38:1306, 38:1314) -------------------------------------

    /**
     * Read every draft this pod is holding, and learn whether the assistant can answer at all.
     *
     * One exec for all of them (`readDrafts`), and one for the credential, because a thread that
     * is waiting for an answer from a signed-out claude should say that rather than spin for two
     * minutes and time out with nothing to blame.
     */
    async loadDrafts() {
      const [drafts, login] = await Promise.all([
        readDrafts(this.extension).catch(() => ({})),
        assistantLogin(this.extension).catch(() => null),
      ]);

      this.drafts = drafts;
      this.login = login;

      // A question asked before this page was loaded is still out, because the pod remembers
      // being asked. Picking the watch back up is what makes the answer arrive at the screen
      // rather than at the next reload.
      if (this.waitingDrafts.length) {
        this.pollDrafts();
      }
    },

    /** Whether the pod answered and there was no credential. Three states, not two. */
    assistantSignedOut() {
      return !!this.login?.read && !this.login.signedIn;
    },

    /**
     * Ask the assistant to draft an answer to one comment, without applying it.
     *
     * The design's block is an *unapplied* change with a size on it, which needs the answer to
     * come back as a record rather than as prose in a terminal. review-draft.ts is how: the
     * question asks for JSON in a file in the pod and for nothing to be edited, and the answer
     * is read back from that file. Everything the block claims - the file, the line counts, "not
     * applied" - is then a fact about something that exists.
     */
    async askDraft(comment) {
      if (this.draftAsking) {
        return;
      }

      this.draftAsking = comment.id;

      try {
        const origin = await originStamp('review').catch(() => undefined);
        const how = await askForDraft(this.extension, comment, origin);

        this.drafts = { ...this.drafts, [comment.id]: null };

        if (!comment.sentAt) {
          await markCommentSent(this.extension, comment.id, how).catch(() => {});
          this.review = await readReview(this.extension).catch(() => this.review);
        }

        toastSuccess(
          this.$store,
          how === 'sent'
            ? 'The assistant is drafting an answer. It has been asked to write it down rather than apply it, and it appears under the comment when it lands.'
            : 'The workspace session is not open yet, so this is the first thing it will be asked when it opens. The draft appears under the comment when it lands.',
          { title: 'Asked for a drafted fix' }
        );

        this.pollDrafts();
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'Could not ask for a fix' });
      } finally {
        this.draftAsking = '';
      }
    },

    /**
     * Watch the pod for answers, and stop watching when there is nothing left to wait for.
     *
     * A poll rather than a subscription because there is nothing to subscribe to: the answer is a
     * file a process in a pod writes when it is ready. One read at a time, for the reason screen
     * 08 gives - an exec can outlast the interval and two in flight race over the same file.
     */
    pollDrafts() {
      this.stopPollingDrafts();

      this.draftTimer = window.setInterval(async() => {
        if (this.draftPolling) {
          return;
        }

        this.draftPolling = true;
        this.drafts = { ...this.drafts, ...await readDrafts(this.extension).catch(() => ({})) };
        this.draftPolling = false;

        if (!this.waitingDrafts.length) {
          this.stopPollingDrafts();
        }
      }, 4000);
    },

    stopPollingDrafts() {
      if (this.draftTimer) {
        window.clearInterval(this.draftTimer);
        this.draftTimer = null;
      }

      this.draftPolling = false;
    },

    /** The draft belonging to one comment: an object, `null` while it is out, undefined for none. */
    draftFor(comment) {
      return this.drafts[comment.id];
    },

    /**
     * What the draft block says, in every state it can be in (38:1306, 38:1313).
     *
     * Six states and not two, because "no draft" covers four different situations and a reviewer
     * needs to know which: never asked, out and waiting, waiting with nobody to answer, answered
     * with a change, answered with no change needed, and answered in prose.
     */
    draftBlock(comment) {
      const draft = this.draftFor(comment);

      if (draft === undefined) {
        return null;
      }

      if (draft === null) {
        return this.assistantSignedOut()
          ? {
            state: 'stuck',
            title: 'The assistant cannot answer this',
            note:  'claude in this pod is signed out, so the question is sitting in its session with nothing to read it. Run /login in the workspace terminal and ask again.',
          }
          : {
            state: 'waiting',
            title: 'The assistant is drafting an answer',
            note:  'It has been asked to write the change down rather than make it, so nothing in the tree moves while it thinks. This block fills in when it lands.',
          };
      }

      if (draft.fix) {
        return {
          state: 'drafted',
          title: draft.headline || 'The assistant has drafted a fix',
          note:  draft.explanation,
          fix:   draft.fix,
        };
      }

      if (draft.raw) {
        return {
          state: 'prose',
          title: 'The assistant answered, but not with a change',
          note:  draft.raw.slice(0, 600),
        };
      }

      return {
        state: 'none',
        title: draft.headline || 'The assistant answered and proposed no change',
        note:  draft.explanation || 'It wrote down an answer with no edit in it, so there is nothing to draft.',
      };
    },

    /** 38:1314. Open the drafted change as a diff of the file as it stands now. */
    async seeTheFix(comment) {
      const draft = this.draftFor(comment);

      if (!draft?.fix) {
        return;
      }

      this.showingDraft = comment.id;
      this.draftLoading = true;
      this.draftDiff = await draftPatch(this.extension, draft.fix)
        .catch((e) => ({
          patch: '', path: '', added: 0, removed: 0, problem: e?.message || String(e),
        }));
      this.draftLoading = false;
    },

    closeTheFix() {
      this.showingDraft = '';
      this.draftDiff = null;
    },

    /** `1 file, +7 −2` for the modal's header. The design's own summary of a draft (38:1306). */
    draftSize,

    draftSizeLabel(comment) {
      const draft = this.draftFor(comment);

      return draft?.fix ? `1 file · ${ draft.fix.path }` : '';
    },

    /**
     * Apply the drafted change, having shown it first.
     *
     * `applyProposedFix` rather than a write from here: it snapshots the tree before it touches
     * anything, and it refuses out loud when the quoted text is not in the file as written, which
     * is the guarantee that makes applying a model's suggestion reversible. The same function
     * screens 03 and 08 apply a fix with, so the three cannot drift.
     */
    async applyDraft(comment) {
      const draft = this.draftFor(comment);

      if (!draft?.fix || this.applyingDraft) {
        return;
      }

      this.applyingDraft = true;

      try {
        const path = await applyProposedFix(this.extension, draft.fix);

        await discardDraft(this.extension, comment.id).catch(() => {});
        const { [comment.id]: gone, ...rest } = this.drafts;

        this.drafts = rest;
        this.closeTheFix();
        await this.load();
        toastSuccess(this.$store, `${ path } changed, and the tree was snapshotted first so this can be undone.`, { title: 'Draft applied' });
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'The draft was not applied' });
      } finally {
        this.applyingDraft = false;
      }
    },

    // --- talk to the author (38:1125) --------------------------------------------------------

    /**
     * Leave a message for whoever the record says wrote this.
     *
     * There is no messaging in Rancher and this product does not invent one. What it has is the
     * review record, which the author reads when they open the change, so the message goes there
     * with the author's name in it, as a comment on the change as a whole (`hunk: 0`) rather than
     * on a line, because it is about the change and not about a line of it.
     */
    async sendToAuthor() {
      const note = this.talkNote.trim();

      if (!note || !this.author || this.sending) {
        return;
      }

      this.sending = true;

      try {
        await addComment(this.extension, {
          packet: this.since?.packet || 0,
          file:   '',
          hunk:   0,
          text:   `To ${ this.author.name }: ${ note }`,
        });

        this.review = await readReview(this.extension).catch(() => this.review);
        this.talking = false;
        this.talkNote = '';

        toastSuccess(
          this.$store,
          `Left on the change for ${ this.author.name }, with your name and the time on it. They see it when they next open this review.`,
          { title: 'Message left for the author' }
        );
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'Could not leave the message' });
      } finally {
        this.sending = false;
      }
    },

    // --- reroute a point as a design question (38:1437) --------------------------------------

    /**
     * Hand a point off as a design question rather than blocking the code review on it.
     *
     * The design draws the button and does not draw where it routes. There is exactly one place
     * in this product where a design question belongs and is already read by something: the
     * brief's `## Open questions`, which screen 10 renders as cards, the packet quotes, and the
     * assistant is handed before it writes anything. So that is where it goes - written into
     * BRIEF.md in the shape screen 10 parses - and a comment is left on the change saying it
     * went there, so the code review records that the point was moved rather than dropped.
     *
     * "Worth asking" rather than "Blocking", always. Screen 10 makes the same choice for a
     * question somebody else raised, for the same reason: calling another person's question
     * blocking is a decision that is not the asker's to take.
     */
    async rerouteAsDesign() {
      const note = this.rerouteNote.trim();

      if (!note || this.sending) {
        return;
      }

      this.sending = true;

      try {
        const brief = await readExtensionFile(this.extension, 'BRIEF.md').catch(() => '');
        const signer = await originStamp('review').catch(() => ({ name: '', principal: '' }));
        const who = signer.name || signer.principal || 'a code reviewer';
        const why = this.rerouteWhy.trim()
          ? `${ this.rerouteWhy.trim().replace(/\s+/g, ' ') } Raised by ${ who } in code review.`
          : `Raised by ${ who } in code review, as a design question rather than a code one.`;

        await writeExtensionFile(this.extension, 'BRIEF.md', addOpenQuestion(brief, note, why));

        await addComment(this.extension, {
          packet: this.since?.packet || 0,
          file:   '',
          hunk:   0,
          text:   `Rerouted as a design question, not a code one: ${ note } It is now an open question on the brief.`,
        });

        this.review = await readReview(this.extension).catch(() => this.review);
        this.rerouting = false;
        this.rerouted = true;
        this.rerouteNote = '';
        this.rerouteWhy = '';
        this.brief = await readExtensionFile(this.extension, 'BRIEF.md').catch(() => this.brief);
        this.files = await changedFiles(this.extension).catch(() => this.files);

        toastSuccess(
          this.$store,
          'It is an open question on this extension\'s brief now, marked "Worth asking", and the change is recorded as having it moved rather than blocked on. BRIEF.md is part of the change, so it is in the diff.',
          { title: 'Handed over as a design question' }
        );
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'Could not hand it over' });
      } finally {
        this.sending = false;
      }
    },

    // --- Before / After / Overlay (38:1354) --------------------------------------------------

    setVisualMode(id) {
      if (this.visualModes.find((m) => m.id === id)?.disabled) {
        return;
      }

      this.visualMode = id;
    },

    /** The path the live preview is on, so the Before frame can be pointed at the same page. */
    onPreviewRoute(path) {
      this.previewPath = path || '/';
    },

    // --- the two directions of 38:1419 -------------------------------------------------------

    /**
     * The framed page, found by looking in this screen's own column.
     *
     * Deliberately a query rather than a ref into the preview component: this column holds
     * whichever frame the current mode put there, and a lookup by shape keeps this code from
     * depending on another component's internals.
     */
    frameDoc() {
      // Always the frame showing the working tree, whichever mode put it there. The diff is
      // about the change, so pointing at the installed build would be pointing at the wrong
      // rendering; in Before there is no such frame on screen and the answer is honestly none.
      const selector = {
        after:   '.rc__preview iframe',
        overlay: '.rc__after-frame',
        before:  '',
      }[this.visualMode];

      if (!selector) {
        return null;
      }

      try {
        const frame = this.$el?.querySelector(`.rc__visual ${ selector }`);

        return frame?.contentDocument || null;
      } catch {
        // Cross-origin, which the pod's dev server is not, or the frame is mid-navigation.
        return null;
      }
    },

    /**
     * Clicking the rendered result to find the code that draws it (38:1419).
     *
     * The framed page is same-origin and a dev build leaves `__file` on every component's
     * options, so an element says which file drew it - the same reading the preview's own outline
     * is made of. What it cannot say is which *line*, so this selects the file and takes the diff
     * to it, and the readout says that is what it did.
     *
     * A mode rather than an always-on listener: the preview is a working dashboard and a page
     * that swallowed every click in it would be worse than no feature.
     */
    toggleInspect() {
      this.inspecting = !this.inspecting;
      this.inspectSays = '';

      if (this.inspecting) {
        this.attachInspect();
      } else {
        this.detachInspect();
      }
    },

    attachInspect() {
      const doc = this.frameDoc();

      if (!doc) {
        this.inspecting = false;
        this.inspectSays = this.visualMode === 'before'
          ? 'Before is the installed build, and the diff is about the working tree, so there is nothing here to trace back to it. Switch to After or Overlay.'
          : 'The rendered page cannot be read from here yet. It is still loading, or it is not the pod\'s own dev server.';

        return;
      }

      doc.addEventListener('click', this.onFrameClick, true);
      doc.body?.style.setProperty('cursor', 'crosshair');
      this.inspectSays = 'Click anything in the page below and the diff goes to the file that draws it.';
    },

    /**
     * Every framed document in this column, whichever mode put it there.
     *
     * Used by the two cleanups rather than `frameDoc`, because both run after the mode has
     * already changed: asking for "the current frame" would tidy the one that is not dirty and
     * leave the listener and the outline on the one that is.
     */
    allFrameDocs() {
      const out = [];

      (this.$el?.querySelectorAll('.rc__visual iframe') || []).forEach((frame) => {
        try {
          if (frame.contentDocument) {
            out.push(frame.contentDocument);
          }
        } catch { /* cross-origin or mid-navigation */ }
      });

      return out;
    },

    detachInspect() {
      this.allFrameDocs().forEach((doc) => {
        doc.removeEventListener('click', this.onFrameClick, true);
        doc.body?.style.removeProperty('cursor');
      });
    },

    onFrameClick(event) {
      event.preventDefault();
      event.stopPropagation();

      let el = event.target;
      let file = '';

      // Up the tree until something says which file drew it: the click usually lands on a leaf
      // the component's own template does not own, a text span inside a button inside a card.
      while (el && !file) {
        file = el.__vueParentComponent?.type?.__file || '';
        el = el.parentElement;
      }

      if (!file) {
        this.inspectSays = 'Nothing there says which file drew it. That is a plain element the dev build left no component record on, or a part of Rancher\'s own shell rather than of this extension.';

        return;
      }

      const match = this.paneFiles.find((f) => file === f.path || file.endsWith(`/${ f.path }`));

      if (!match) {
        this.inspectSays = `That is drawn by ${ file.replace(/^.*\/pkg\//, 'pkg/') }, which this change does not touch.`;

        return;
      }

      this.selected = match.path;
      this.inspectSays = `${ match.path } draws that. The diff on the left is now showing it - which hunk drew the element cannot be known, because nothing in the running page records a line number.`;
    },

    /**
     * Clicking a diff line to see what it changes on screen (38:1419, the other direction).
     *
     * The honest half of it. Nothing maps a line of source to an element: a dev build records the
     * file a component came from and no line, and the compiled render function keeps no trace of
     * which template line produced which node. So what this does is outline what the *file* draws
     * on the framed page, and say in one sentence that it is the file and not the line.
     *
     * One thing does get to line precision, when the line offers it. A changed template line that
     * carries a `class="..."` or a `data-testid="..."` names something that is in the rendered
     * document by that exact string, so a match on it is a match and not a guess. When the line
     * has one, the outline narrows to the elements that carry it *and* were drawn by this file,
     * and the sentence says which attribute it used.
     */
    onDiffLine(line) {
      this.activeLine = line?.new ?? line?.old ?? null;

      const doc = this.frameDoc();

      if (!doc?.body) {
        this.lineSays = 'The rendered page is not loaded, so there is nothing to point at yet.';

        return;
      }

      const named = /(?:class|data-testid|id)="([^"]+)"/.exec(line?.text || '');
      const selector = named
        ? (named[0].startsWith('class') ? `.${ named[1].trim().split(/\s+/).join('.') }` : `[${ named[0].split('=')[0] }="${ named[1] }"]`)
        : '';

      const drawn = [...doc.body.querySelectorAll('*')].filter((el) => {
        const file = el.__vueParentComponent?.type?.__file;

        return !!file && (file === this.selected || file.endsWith(`/${ this.selected }`));
      });

      let targets = drawn;
      let how = `${ this.selected } draws ${ drawn.length } block${ drawn.length === 1 ? '' : 's' } on this page. Nothing records which line drew which element, so the whole file's output is outlined rather than this one line's.`;

      if (selector) {
        const narrowed = drawn.filter((el) => {
          try {
            return el.matches(selector);
          } catch {
            return false;
          }
        });

        if (narrowed.length) {
          targets = narrowed;
          how = `Outlined: ${ narrowed.length } element${ narrowed.length === 1 ? '' : 's' } matching ${ selector } and drawn by ${ this.selected }. Matched on the attribute the line itself carries, which is an exact match rather than a guess.`;
        }
      }

      this.paintLine(doc, targets);
      this.lineSays = targets.length
        ? how
        : `Nothing on the page below is drawn by ${ this.selected }. Point the preview at a page it renders and this line's output is outlined here.`;
    },

    /**
     * Draw the outline in the framed document, and only there.
     *
     * A separate attribute and stylesheet from the preview panel's own change marker, so the two
     * do not fight over the same attribute and turning one off does not lift the other.
     */
    paintLine(doc, elements) {
      doc.querySelectorAll('[data-barn-line]').forEach((el) => el.removeAttribute('data-barn-line'));

      if (!doc.getElementById('barn-line-style')) {
        const style = doc.createElement('style');
        const accent = getComputedStyle(document.body).getPropertyValue('--studio-accent-text').trim()
          || getComputedStyle(document.body).getPropertyValue('--studio-accent').trim() || '#2C7BB0';

        style.id = 'barn-line-style';
        style.textContent = '[data-barn-line]{outline:3px dashed ' + accent + ';outline-offset:2px;border-radius:4px;}';
        doc.head?.appendChild(style);
      }

      elements.forEach((el) => el.setAttribute('data-barn-line', ''));
      elements[0]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },

    clearLine() {
      this.allFrameDocs().forEach((doc) => {
        doc.querySelectorAll('[data-barn-line]').forEach((el) => el.removeAttribute('data-barn-line'));
        doc.getElementById('barn-line-style')?.remove();
      });

      this.activeLine = null;
      this.lineSays = '';
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

      <SChip
        :label="`${ risk } risk`"
        :tone="riskTone"
        :title="riskReading.reason"
        data-testid="rc-risk"
      />
      <SChip
        :label="prChip.label"
        :tone="prChip.tone"
        :title="prTitle"
        icon="github"
        :clickable="!!prChip.action"
        data-testid="rc-pr"
        @click="onPrChip"
      />

      <span class="rc__grow" />

      <!-- 38:1125. Rancher has no messaging, so this leaves a message on the change for whoever
           the record names as its author. See `author` for where that name comes from. -->
      <!-- The title is on the wrapper, not the button: a disabled button takes no pointer
           events, so the one state that most needs its reason read would never show it. -->
      <span :title="talkChip.title">
        <SButton
          variant="ghost"
          size="sm"
          icon="user"
          data-testid="rc-talk-to-author"
          :disabled="talkChip.disabled"
          @click="talking = true"
        >
          {{ talkChip.label }}
        </SButton>
      </span>

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

          <!--
            Comments about the change rather than about a line: a message left for the author
            (38:1125), and a point handed over as a design question (38:1437). Here rather than
            in the diff column because they have no line to sit beside, and in the packet because
            that is the column that describes the change as a whole.
          -->
          <div v-if="changeComments.length" class="rc__section" data-testid="rc-change-comments">
            <div class="rc__criteria-head">
              <SLabel text="On the change as a whole" />
              <span class="rc__group-count">{{ changeComments.length }}</span>
            </div>

            <div class="rc__section-body">
              <div
                v-for="c in changeComments"
                :key="c.id"
                class="rc__comment"
                :data-testid="`rc-change-comment-${ c.id }`"
              >
                <span class="rc__avatar" :title="c.principal">{{ initials(c.name || c.principal) }}</span>
                <div class="rc__comment-body">
                  <div class="rc__comment-byline">{{ commentByline(c) }}</div>
                  <div class="rc__comment-text">{{ c.text }}</div>
                </div>
              </div>
            </div>
          </div>

          <!--
            What the packet carried, from the git note the hand-over wrote (38:1256's material,
            at the level it can honestly be had at). The per-hunk strip below the diff is the
            live reading of the pod; this is the packet's own copy, and the two describe
            different moments. Both are labelled as which.
          -->
          <div v-if="handedOver" class="rc__section" data-testid="rc-handed-over">
            <div class="rc__criteria-head">
              <SLabel text="What was handed over" />
              <span v-if="handedOver.state === 'read'" class="rc__group-count">
                packet {{ handedOver.packet }}
              </span>
            </div>

            <div class="rc__section-body">
              <p class="rc__section-line">{{ handedOver.sentence }}</p>

              <p
                v-if="handedOverDrift"
                class="rc__section-note"
                data-testid="rc-handed-over-drift"
              >
                {{ handedOverDrift }}
              </p>

              <div
                v-if="handedOver.turns.length"
                class="rc__prompts"
                data-testid="rc-packet-prompts"
                title="The prompts the pod recorded behind this packet, read from the packet's own note rather than recomputed from the pod. They say what was asked for, in order. They do not say which line came from which ask: tying a line to a turn needs the turn to have ended in a commit, and none of these did."
              >
                <div
                  v-for="turn in handedOver.turns"
                  :key="turn.id"
                  class="rc__prompt"
                >
                  <SIcon name="sparkle" :size="12" class="rc__prov-icon" />
                  <span class="rc__prompt-text">
                    <span class="rc__prompt-label">{{ turn.label }}</span>
                    {{ turn.prompt || 'the prompt for that turn was not kept' }}
                    <span class="rc__prompt-meta">
                      <template v-if="turn.when">{{ turn.when }}</template>
                      <template v-if="turn.screen"> · from the {{ turn.screen }} screen</template>
                      <template v-if="!turn.ended"> · ended in no commit, so no line can be traced to it</template>
                    </span>
                  </span>
                </div>
              </div>
            </div>
          </div>

          <!-- automated checks (38:1215). Five rows, and each says what it actually did. -->
          <div class="rc__section" data-testid="rc-checks">
            <div class="rc__criteria-head">
              <SLabel text="Automated checks" />
              <SChip
                :label="checksLine"
                :tone="checksTone"
                data-testid="rc-checks-summary"
                title="What ran, what found something, and what could not run. A check that could not run is never drawn as a pass: a green tick nobody earned is the one thing on this screen a reviewer is invited to trust without reading."
              />
            </div>

            <div class="rc__section-body">
              <div
                v-for="c in checks"
                :key="c.id"
                class="rc__check"
                :data-testid="`rc-check-${ c.id }`"
                :data-state="c.state"
                :title="c.title"
              >
                <SIcon
                  :name="{ pass: 'check', warn: 'alert', unknown: 'clock' }[c.state]"
                  :size="13"
                  :class="`rc__check-icon rc__check-icon--${ c.state }`"
                />
                <span class="rc__check-text">
                  {{ c.label }}
                  <span class="rc__check-note">{{ c.note }}</span>
                  <span v-for="(f, i) in c.findings" :key="i" class="rc__check-finding">
                    {{ f.path }}:{{ f.line }} · {{ f.what }}
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
            <!-- 38:1419, one half of it: a changed line is pressable and answers with what the
                 file it is in draws on the page beside this. See `onDiffLine`. -->
            <p v-if="lineSays" class="rc__line-says" data-testid="rc-line-says">
              <SIcon name="eye" :size="12" />
              {{ lineSays }}
              <button type="button" class="rc__link" @click="clearLine">Clear</button>
            </p>
            <DiffView
              :patch="patch"
              link-lines
              :active-line="activeLine"
              @line="onDiffLine($event.line)"
            >
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

                      <!-- the assistant's drafted fix (38:1306), or the reason there is none -->
                      <div
                        v-if="draftBlock(c)"
                        class="rc__draft"
                        :class="`rc__draft--${ draftBlock(c).state }`"
                        :data-testid="`rc-draft-${ c.id }`"
                        :data-state="draftBlock(c).state"
                      >
                        <div class="rc__draft-head">
                          <SIcon :name="draftBlock(c).state === 'drafted' ? 'sparkle' : 'clock'" :size="12" />
                          <span class="rc__draft-title">{{ draftBlock(c).title }}</span>
                          <span v-if="draftSizeLabel(c)" class="rc__draft-size">{{ draftSizeLabel(c) }}</span>
                        </div>
                        <p v-if="draftBlock(c).note" class="rc__draft-note">{{ draftBlock(c).note }}</p>
                        <div v-if="draftBlock(c).state === 'drafted'" class="rc__draft-actions">
                          <span class="rc__draft-unapplied">
                            Not applied. Nothing in the tree has moved, and the author approves it first.
                          </span>
                          <span class="rc__grow" />
                          <SButton
                            variant="secondary"
                            size="sm"
                            icon="code"
                            :data-testid="`rc-see-the-fix-${ c.id }`"
                            @click="seeTheFix(c)"
                          >
                            See the fix
                          </SButton>
                        </div>
                      </div>

                      <button
                        v-else
                        type="button"
                        class="rc__link rc__draft-ask"
                        :data-testid="`rc-ask-draft-${ c.id }`"
                        :disabled="draftAsking === c.id"
                        title="Asks the assistant in this pod to write down the smallest change that answers this comment, as a change and not as a conversation. It is told to edit nothing, so what comes back is a draft with a size on it that you can read before anybody applies it."
                        @click="askDraft(c)"
                      >
                        <SIcon name="sparkle" :size="11" />
                        {{ draftAsking === c.id ? 'Asking…' : 'Ask the assistant to draft a fix' }}
                      </button>
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
          <span class="rc__grow" />
          <!-- 38:1419, the other half: click the rendered result to find its code. -->
          <SChip
            :label="inspecting ? 'Click a block to find its code' : 'Find the code'"
            :tone="inspecting ? 'info' : 'subtle'"
            icon="code"
            clickable
            data-testid="rc-inspect"
            title="Turns clicks in the page below into a jump to the file that drew what you clicked. A dev build records which file each component came from and no line number, so this lands on the file rather than the hunk, and it says so when it does. Off by default because the preview is a working dashboard and a page that swallowed every click would be worse than no feature."
            @click="toggleInspect"
          />
        </div>

        <!-- Before / After / Overlay (38:1354). Before is the build installed in this Rancher,
             which is the only unchanged rendering of this extension that exists anywhere. -->
        <div class="rc__segments" role="group" aria-label="Which rendering to show">
          <button
            v-for="m in visualModes"
            :key="m.id"
            type="button"
            class="rc__segment"
            :class="{ 'rc__segment--on': visualMode === m.id }"
            :disabled="m.disabled"
            :data-testid="`rc-visual-${ m.id }`"
            :aria-pressed="visualMode === m.id"
            @click="setVisualMode(m.id)"
          >
            {{ m.label }}
          </button>
          <span class="rc__grow" />
          <span
            v-if="!beforeAvailable"
            class="rc__segment-why"
            :title="beforeNote"
            data-testid="rc-no-before"
          >
            no Before to show
          </span>
        </div>

        <p v-if="visualNote" class="rc__visual-note" data-testid="rc-visual-note">
          {{ visualNote }}
        </p>
        <p v-if="inspectSays" class="rc__visual-note" data-testid="rc-inspect-says">
          {{ inspectSays }}
        </p>

        <!-- After (38:1361): the pod's dev server, serving the working tree. The panel, not a
             bare frame, because its toolbar, its live readout and its own changed-block outline
             are all readings of this same thing. -->
        <!-- `v-show`, not `v-if`: the panel holds where the reviewer navigated to inside the
             framed dashboard, and unmounting it to look at Before would send them back to the
             extension's home page every time they compared the two. -->
        <PreviewPanel
          v-if="previewUrl"
          v-show="visualMode === 'after'"
          class="rc__preview"
          :url="previewUrl"
          :extension="extension"
          @route="onPreviewRoute"
        />

        <!-- Before (38:1401), and Overlay, which is the two of them in one box. Plain frames
             here: the toolbar belongs to the live view and a toolbar over a stack of two would
             be a control that only reaches one of them. -->
        <div
          v-if="visualMode !== 'after' && beforeAvailable"
          class="rc__stack"
          :class="{ 'rc__stack--overlay': visualMode === 'overlay' }"
          data-testid="rc-visual-stack"
        >
          <iframe
            v-if="visualMode === 'overlay' && previewUrl"
            class="rc__after-frame"
            :src="`${ proxyPath }${ previewPath }`"
            title="After: the working tree, served by this extension's dev server"
          />
          <iframe
            class="rc__before-frame"
            :src="beforeUrl"
            data-testid="rc-before-frame"
            title="Before: the build installed in this Rancher"
          />
        </div>

        <SEmpty
          v-if="visualMode === 'after' && !previewUrl"
          icon="monitor"
          title="The preview is not up"
          message="The extension's dev server is still compiling. The rendered result appears here once it answers."
        />
        <SEmpty
          v-if="visualMode !== 'after' && !beforeAvailable"
          icon="monitor"
          title="There is no Before"
          :message="beforeNote"
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

      <!-- 38:1437. Hands a point off as a design question instead of blocking the code review
           on it. It goes to the brief's Open questions, which is where this product already
           keeps design questions and the only place anything reads them. -->
      <span :title="rerouted
        ? 'Already handed over: it is an open question on this extension\'s brief. Press again to add another.'
        : 'Writes the point into this extension\'s BRIEF.md under Open questions, marked \'Worth asking\', where screen 10 renders it and the assistant reads it before it writes anything. The code review records that it was moved rather than dropped, and stays open.'">
        <SButton
          variant="neutral"
          icon="user"
          data-testid="rc-ux-decision"
          @click="rerouting = true"
        >
          This is a UX decision, not a code one
        </SButton>
      </span>
      <span :title="requestTitle">
        <SButton
          variant="neutral"
          icon="undo"
          data-testid="rc-request-changes"
          :disabled="!count"
          @click="requesting = true"
        >
          Request changes<template v-if="openRequests"> ({{ openRequests }} open)</template>
        </SButton>
      </span>
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

    <!-- 38:1125. A message for the author, in the only place this product has to put one. -->
    <SModal
      v-if="talking"
      title="Talk to the author"
      icon="user"
      :width="520"
      :busy="sending"
      @close="talking = false"
    >
      <p class="rc__say">
        <strong>{{ author && author.name }}</strong> {{ author && author.how }} {{ author && author.when }}.
        Rancher has no messaging and this product does not invent one, so this is left on the
        change itself, with your name and the time on it, where they see it when they next open
        this review. Nothing is sent to the pod and nothing is emailed.
      </p>

      <SField
        v-model="talkNote"
        label="The message"
        multiline
        :rows="4"
        placeholder="Why did this move out of the store? I want to understand before I sign it off."
        input-testid="rc-talk-input"
        hint="It is recorded against the change as a whole, not against a line."
      />

      <template #footer>
        <SButton variant="neutral" :disabled="sending" @click="talking = false">
          Cancel
        </SButton>
        <SButton
          variant="primary"
          icon="user"
          data-testid="rc-talk-send"
          :disabled="!talkNote.trim()"
          :loading="sending"
          @click="sendToAuthor"
        >
          Leave it for them
        </SButton>
      </template>
    </SModal>

    <!-- 38:1437. The point, on its way to being a design question rather than a code one. -->
    <SModal
      v-if="rerouting"
      title="This is a UX decision, not a code one"
      icon="user"
      :width="540"
      :busy="sending"
      @close="rerouting = false"
    >
      <p class="rc__say">
        This does not reject the change and does not sign anything off. It writes the point into
        <strong>{{ extension }}</strong>'s brief as an open question, marked "Worth asking", which
        is where this product keeps design questions: the brief screen renders them, the packet
        quotes them, and the assistant is handed them before it writes anything. A comment is left
        on the change saying it went there, so the code review records that it moved rather than
        that it was dropped.
      </p>

      <SField
        v-model="rerouteNote"
        label="The question"
        multiline
        :rows="3"
        placeholder="Should the threshold be shown as a number or as a band on the chart?"
        input-testid="rc-reroute-input"
        hint="One question. It goes into BRIEF.md exactly as written, so write it as a question somebody can answer."
      />
      <SField
        v-model="rerouteWhy"
        label="Why it matters (optional)"
        multiline
        :rows="2"
        placeholder="Either reading is defensible and the choice changes what the panel is for."
      />

      <template #footer>
        <SButton variant="neutral" :disabled="sending" @click="rerouting = false">
          Cancel
        </SButton>
        <SButton
          variant="primary"
          icon="book"
          data-testid="rc-reroute-send"
          :disabled="!rerouteNote.trim()"
          :loading="sending"
          @click="rerouteAsDesign"
        >
          Put it on the brief
        </SButton>
      </template>
    </SModal>

    <!-- 38:1314. The drafted change, as a diff of the file as it stands now. -->
    <SModal
      v-if="showingDraft"
      title="The assistant's drafted fix"
      icon="sparkle"
      :width="760"
      :busy="applyingDraft"
      @close="closeTheFix"
    >
      <div v-if="draftLoading" class="rc__loading">
        <SIcon name="spinner" :size="18" class="rc__spin" />
        Reading the file the draft names
      </div>
      <template v-else-if="draftDiff && draftDiff.patch">
        <p class="rc__say">
          <strong>{{ draftDiff.path }}</strong> · {{ draftSize(draftDiff) }}. This has not been
          applied: it is a change the assistant wrote down when it was asked not to make one, and
          the diff below is it, measured against the file as it is in the pod right now.
        </p>
        <div class="rc__draft-diff">
          <DiffView :patch="draftDiff.patch" />
        </div>
      </template>
      <SBanner v-else type="warning">
        {{ draftDiff && draftDiff.problem }}
      </SBanner>

      <template #footer>
        <SButton variant="neutral" :disabled="applyingDraft" @click="closeTheFix">
          Leave it as a draft
        </SButton>
        <SButton
          v-if="draftDiff && draftDiff.patch"
          variant="primary"
          icon="check"
          data-testid="rc-apply-draft"
          :loading="applyingDraft"
          @click="applyDraft({ id: showingDraft })"
        >
          Apply it
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

  // 38:1354. A segmented control, which is one control and not three buttons: one border round
  // the set, dividers between, and the chosen segment filled.
  &__segments {
    display:       flex;
    align-items:   center;
    gap:           var(--studio-space-8);
    padding:       var(--studio-space-8) var(--studio-space-12);
    border-bottom: 1px solid var(--studio-border-subtle);
  }

  &__segment {
    padding:       var(--studio-space-4) var(--studio-space-12);
    background:    var(--studio-surface);
    border:        1px solid var(--studio-border);
    font:          var(--studio-caption-12-semi);
    color:         var(--studio-text-secondary);
    cursor:        pointer;

    &:first-of-type { border-radius: var(--studio-radius-control) 0 0 var(--studio-radius-control); }
    &:nth-of-type(3) { border-radius: 0 var(--studio-radius-control) var(--studio-radius-control) 0; }
    & + & { border-left: none; }

    &--on {
      background:   var(--studio-green-500);
      border-color: var(--studio-green-500);
      color:        var(--studio-text-inverse);
    }

    &:disabled {
      cursor:  not-allowed;
      opacity: 0.5;
    }
  }

  &__segment-why {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  &__visual-note {
    margin:  0;
    padding: var(--studio-space-6) var(--studio-space-12);
    font:    var(--studio-caption-12);
    color:   var(--studio-text-tertiary);
  }

  // Before on its own, or the two stacked. In the overlay the working tree is underneath and
  // the installed build is over it at half opacity, so anything that moved reads as a doubled
  // edge; the top frame takes no pointer events, because clicking through to the wrong one of
  // two identical-looking pages is the worst thing this could do.
  &__stack {
    position:  relative;
    flex:      1 1 auto;
    min-height: 0;

    iframe {
      width:  100%;
      height: 100%;
      border: none;
      background: var(--studio-surface);
    }
  }

  &__stack--overlay {
    .rc__before-frame {
      position:       absolute;
      inset:          0;
      opacity:        0.5;
      pointer-events: none;
    }
  }

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

  // The prompts a packet carried. Quoted, because the prompt is the record and paraphrasing it
  // would be inventing it.
  &__prompts {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-6);
    padding-left:   var(--studio-space-2);
  }

  &__prompt {
    display: flex;
    gap:     var(--studio-space-6);
  }

  &__prompt-text {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-2);
    font:           var(--studio-body-13);
    color:          var(--studio-text);
  }

  &__prompt-label {
    font:  var(--studio-caption-12-semi);
    color: var(--studio-text-secondary);
  }

  &__prompt-meta {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  // 38:1215. Same shape as a criterion, because it answers the same kind of question: a state,
  // a name, and the words that say what the state means. The third icon - a clock - is the one
  // the design never draws, and it is the honest half of this section: a check that could not
  // run is neither green nor red.
  &__check {
    display: flex;
    gap:     var(--studio-space-8);
  }

  &__check-icon {
    margin-top: 2px;

    &--pass    { color: var(--studio-green-500); }
    &--warn    { color: var(--studio-warning); }
    &--unknown { color: var(--studio-text-tertiary); }
  }

  &__check-text {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-2);
    font:           var(--studio-body-13);
    color:          var(--studio-text);
  }

  &__check-note {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  &__check-finding {
    font:  var(--studio-caption-12);
    color: var(--studio-warning);
    word-break: break-all;
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

  // 38:1306. The drafted change, under the comment it answers. Boxed, because it is not the
  // reviewer's sentence and not the record's: it is a thing the assistant made that nobody has
  // accepted, and the border is what says so before the words do.
  &__draft {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-4);
    margin-top:     var(--studio-space-6);
    padding:        var(--studio-space-8);
    border:         1px dashed var(--studio-border);
    border-radius:  var(--studio-radius-control);
    background:     var(--studio-surface);
  }

  &__draft--drafted {
    border-style: solid;
    border-color: var(--studio-green-500);
  }

  &__draft-head {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-4);
    color:       var(--studio-text);
  }

  &__draft-title {
    font: var(--studio-caption-12-semi);
  }

  &__draft-size {
    margin-left: auto;
    font:        var(--studio-caption-12);
    color:       var(--studio-text-tertiary);
  }

  &__draft-note {
    margin: 0;
    font:   var(--studio-caption-12);
    color:  var(--studio-text-secondary);
  }

  &__draft-actions {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
  }

  &__draft-unapplied {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  &__draft-ask {
    align-self:  flex-start;
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-4);
    margin-top:  var(--studio-space-4);
  }

  &__draft-diff {
    max-height: 46vh;
    overflow:   auto;
  }

  // The readout over the diff when a line has been pressed (38:1419).
  &__line-says {
    display:       flex;
    align-items:   center;
    gap:           var(--studio-space-6);
    margin:        0 0 var(--studio-space-8);
    padding:       var(--studio-space-6) var(--studio-space-8);
    border:        1px solid var(--studio-border-subtle);
    border-radius: var(--studio-radius-control);
    font:          var(--studio-caption-12);
    color:         var(--studio-text-secondary);
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
