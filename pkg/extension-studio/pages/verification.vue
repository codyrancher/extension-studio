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
//
// The scope card's two answers (39:1348, 39:1350) are real and they go to different places,
// because that is what the two of them mean. Accepting rewrites the brief - the line that ruled
// the behaviour out moves into what the change does, stamped with the day and the person - so
// the warning stops being true rather than being dismissed. Rejecting leaves the brief alone
// and asks the assistant to take the behaviour back out, because in that case the author's list
// was right and it is the code that has to move.
//
// Evidence, which the design draws as three controls (39:1306, 39:1384, 39:1385) and which are
// not one feature after all. Two of the three are here. "Capture this as evidence" records what
// this product can honestly record about a moment - the route the frame is on, the clock, and
// the person the apiserver names - into BRIEF.md under the criterion it is evidence for, so it
// survives the tab, the reload and the pod, and travels in the same commit as the code; the
// sentence above the button says exactly that. The third, the screenshot upload, is still out,
// and its reason is about files rather than about evidence: the two stores this screen writes
// to are the brief, which is the markdown under review, and one ConfigMap holding every
// sign-off this extension has. A PNG in the first makes the evidence part of the thing being
// reviewed; in the second it is a handful of screenshots from etcd's object limit, and going
// over it takes the sign-offs with it.
//
// The cluster row (39:1364) had the same two facts run together and they have been separated.
// Where the dev server runs is not a choice - it is this extension's own pod, in `local`.
// Which cluster the framed page is *about* is one, because the frame is a whole dashboard and
// its routes carry a cluster id, so the row is a chooser over the clusters Rancher actually
// has and picking one navigates the frame. The annotation beside the name is what the cluster
// object says about itself, because nothing here can know which capability a given extension
// depends on, which is what the design's "no metrics-server" is.
import {
  SButton, SChip, SIcon, SEmpty, SBanner, SLabel, SBadge, SMenu
} from '../components/ui';
import PreviewPanel from '../components/studio/PreviewPanel.vue';
import { toastSuccess, toastError } from '../toast';
import {
  ensureRepo,
  readExtensionFile, writeExtensionFile, extensionUrl, extensionReady, changedFiles, workingDiff,
  changeProvenance, askAssistant, previewClusters, DEFAULT_EXTENSION
} from '../extensions';
// The review record: where a decision about a change lives, so that it is readable by the
// queue, the review screen and the publish modal without any of them opening this brief. The
// brief stays the human record of the outcome; this is the one the gate reads.
import {
  readReview, updateReview, gateFrom, currentSigner, whoAsked, signOutcome
} from '../review';
import {
  REVIEW_QUEUE_ROUTE, BRIEF_ROUTE, EDITOR_ROUTE, STUDIO_PAGE_ACTIONS, handleStudioPageAction
} from '../editor-product';
import pageActionsMixin from '@shell/mixins/page-actions';
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
// The design draws three of the four, one per criterion in the mock: 39:1233 and 39:1287 are
// the saturated status fill a chosen segment gets, and 39:1330 is the grey #F2F3F5 fill on the
// chosen "Can't tell" - "styled neutrally (grey, not red)", in the feature's own words. Grey is
// that state's colour and it has it back; the fourth state, which the mock never draws, is
// styled as the empty control it is rather than borrowing the grey. See the badge rules at the
// foot of this file for the whole argument.
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
 * One captured piece of evidence, written under the criterion it backs.
 *
 * `- Captured 2026-08-24 12:41 by admin at `/c/local/explorer``, as `verificationBlock` writes
 * it. The date is in the file and only the clock is on the screen, which is what the design
 * draws (39:1225) - a verdict read back a week later needs the day, and a reviewer looking at
 * the row they just answered does not.
 *
 * It cannot collide with a verdict line: that one begins `- **`, and this one has no bold. The
 * person is optional because Rancher will not always name the session, and the route is not,
 * because a capture with nowhere attached to it is the thing this is for.
 */
const CAPTURE_LINE = /^-\s+Captured\s+([0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2})(?:\s+by\s+(.+?))?\s+at\s+`([^`]*)`\s*$/;

/**
 * The cluster in a route inside the framed dashboard.
 *
 * Two shapes, because the frame is a whole dashboard: `/c/<id>/...` for Rancher's own pages,
 * and `/<product>/c/<id>/...` for a page an extension registers, which is what the seeded
 * extension's own home is. The optional leading segment is what tells the two apart, and it
 * cannot swallow the `/c/` itself because the pattern requires one after it.
 */
const CLUSTER_IN_ROUTE = /^((?:\/[^/]+)?\/c\/)([^/]+)(.*)$/;

/** `2026-08-24 12:41`, the stamp a capture line carries. */
function stamp(at) {
  const pad = (n) => String(n).padStart(2, '0');

  return `${ at.getFullYear() }-${ pad(at.getMonth() + 1) }-${ pad(at.getDate()) } ${ pad(at.getHours()) }:${ pad(at.getMinutes()) }`;
}

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

/** The heading the reviewer's page-level notes sit under, inside `## Verification`. */
const NOTES_HEADING = '### notes';

/**
 * A reviewer's note about one criterion, written under its verdict line.
 *
 * A blockquote because that is what markdown has for "somebody said this", and because it keeps
 * the note attached to the line above it in every renderer rather than reading as a new item.
 */
const NOTE_LINE = /^>\s?(.*)$/;

/** `Signed off by admin on 2026-08-23.`, as `verificationBlock` writes it. */
const SIGNOFF_LINE = /^Outcome signed off(?:\s+by\s+(.+?))?\s+on\s+([0-9]{4}-[0-9]{2}-[0-9]{2})\.$/;

/** Today, as the brief records a date. */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Just the clock, for the provenance line under a criterion (39:1225). */
function clock(at) {
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * `2 hours ago`, from an ISO timestamp. '' for anything that is not one.
 *
 * The same relative time screens 12 and the publish modal put on a sign-off row, so the two
 * halves of one gate are not worded two ways on two screens.
 */
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

/** An empty review record, so the gate can be read before the first fetch lands. */
const NO_REVIEW = {
  signoffs: {}, packets: {}, looks: {}, comments: [],
};

export default {
  name: 'BarnVerification',

  components: {
    SButton, SChip, SIcon, SEmpty, SBanner, SLabel, SBadge, SMenu, PreviewPanel
  },

  mixins: [fullBleed, pageActionsMixin],

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
      // The extension's own version, out of its package.json - the masthead has to say which
      // build of the thing is being signed off, and this is the only place that knows.
      version:    '',
      // Who signed the outcome off and when, as recorded in the brief. Cleared the moment a
      // verdict changes, because it was a sign-off on the answers as they stood.
      signedOff:  null,
      // The review record: both sign-offs, with the principal and the commit each was given
      // against. The brief's sign-off line is the human record of the same fact; this is the
      // one the queue, the review screen and the distribution gate read.
      review:     NO_REVIEW,
      // The commit the sign-off is given against, so a later commit leaves it on record and no
      // longer covering the change. Same reading screen 12 signs the code half against.
      sha:        '',
      // The principal the brief records under `## Who asked`, and '' when it records nobody -
      // which is every brief made before screen 02 started writing that section at creation.
      asked:      '',
      // Who the apiserver says is asking. Needed before the sign-off, not after it: the
      // requester check has to be answerable on screen rather than only in a thrown error.
      me:         null,
      // A withdrawal of the outcome sign-off is in flight.
      revoking:   false,
      // Which criterion the preview was last driven to, so the pane can say what it is showing.
      showing:    -1,
      // Every cluster the framed page could be about (39:1364), and whether the list could be
      // read at all. An empty list that was read and an unread one say different things, and
      // the row has to be able to say which.
      clusters:     [],
      clustersRead: false,
      clustersWhy:  '',
      // The criterion a "Send this back" is in flight for, by index.
      sending:    -1,
      // The drift term an accept or a reject is in flight for, by term. Two of them, because
      // the two do different things to different places and one spinner over both would put
      // the wrong one on the wrong button.
      accepting:  '',
      rejecting:  '',
      // The drift term whose "this is what will move" preview is open, if any. One at a time:
      // the preview is a decision about one rule, and two of them open is two decisions
      // half-made.
      confirming: '',
      // A "Send the whole list back" is in flight.
      handing:    false,
      VERDICTS,
    };
  },

  computed: {
    /**
     * What Rancher's header kebab offers here (39:1139, 53:2050).
     *
     * One of the design's three header controls, and the only one that is not Rancher's to
     * fill: `HeaderPageActionMenu` is already in that header and shows itself whenever the
     * mounted page has committed a non-empty `pageActions`. Eight Studio screens commit them
     * and get the kebab; this one committed none, which is the whole reason there was no
     * three-dot control here. Read by @shell/mixins/page-actions, which commits on `created`
     * and clears on `beforeUnmount`, so the menu belongs to this page rather than to every
     * page in Rancher.
     *
     * The app-collection grid beside it stays absent: this Rancher has no app-collection
     * popover for an entry to open, so there is nothing honest to point one at.
     */
    pageActions() {
      return STUDIO_PAGE_ACTIONS;
    },

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

    /**
     * How many criteria the reviewer has settled, which is what the progress chip counts.
     *
     * Yes and No both settle one: the reviewer looked and gave an answer. "Can't tell" does
     * not, and neither does an untouched row - the design's own counter reads 3 of 4 with two
     * Yes, one No and one "Can't tell". The chip used to count `passed`, so four criteria all
     * answered No read 0 of 4: a progress counter that goes backwards as the work gets done.
     */
    settled() {
      return this.passed + this.failed;
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
      if (this.signedOff) {
        return 'live';
      }

      return {
        pass: 'live', fail: 'failed', partial: 'building', unsure: 'unsaved', none: 'draft',
      }[this.verdict];
    },

    verdictLabel() {
      if (this.signedOff) {
        return `Signed off ${ this.signedOff.on }`;
      }

      return {
        pass:    'Every criterion checked',
        fail:    `${ this.failed } not met`,
        partial: `${ this.undecided } still to check`,
        unsure:  `${ this.unsure } could not be judged`,
        none:    'No criteria',
      }[this.verdict];
    },

    /**
     * Whether the outcome can be signed off.
     *
     * A "No" is the verdict that holds it open - that is the design's rule, and the only one
     * this screen can enforce honestly. A criterion nobody has answered holds it open too: a
     * sign-off on rows nobody opened is not a sign-off. A "Can't tell" does not, because it is
     * an answer somebody gave, and a criterion nobody can judge is a fact about the criterion.
     */
    canSignOff() {
      return !!this.criteria.length && !this.failed && !this.undecided && !this.saving &&
        !this.revoking && !this.requesterBlocker;
    },

    /** Why the sign-off button is refusing, in the words the criteria are answered in. */
    signOffBlocker() {
      if (!this.criteria.length) {
        return 'There are no acceptance criteria to sign off.';
      }

      if (this.failed) {
        return `${ this.failed } criteri${ this.failed === 1 ? 'on is' : 'a are' } answered No. A No holds the sign-off open until it is answered Yes.`;
      }

      if (this.undecided) {
        return `${ this.undecided } criteri${ this.undecided === 1 ? 'on has' : 'a have' } not been looked at yet.`;
      }

      // Last, because it is a fact about who is standing here rather than about the criteria,
      // and because on every brief that exists today it is empty.
      return this.requesterBlocker;
    },

    /**
     * Where the two questions stand, read from the review record at the current commit.
     *
     * The same reduced gate screen 12 draws, so the two screens cannot disagree about who has
     * answered what. A sign-off given before the branch moved is shown as what it is: still on
     * record, still named, and no longer about this change.
     */
    gate() {
      return gateFrom(this.review, this.sha);
    },

    /**
     * The code gate, as a chip (39:1187).
     *
     * The design draws this as "Code approved by Ana Silva" and its job is to tell the reviewer
     * their job is only the outcome. It is the other half of the gate, so it is read rather
     * than asserted: when nobody has answered the code question it says so, and when somebody
     * asked for changes it says that instead of implying an approval.
     */
    codeChip() {
      const signoff = this.gate.code;

      if (!signoff) {
        return {
          tone:  'subtle',
          icon:  'clock',
          label: 'Code not reviewed yet',
          title: 'Nobody has answered the code question yet. It is a separate sign-off, taken on the review screen, and it is not yours to give here.',
        };
      }

      const who = signoff.name || signoff.principal || 'somebody Rancher did not name';
      const when = ago(signoff.at);

      if (signoff.verdict === 'changes-requested') {
        return {
          tone:  'error',
          icon:  'alert',
          label: `${ who } asked for changes to the code`,
          title: signoff.note || 'No reason was recorded with the request.',
        };
      }

      if (this.gate.codeStale) {
        return {
          tone:  'warning',
          icon:  'alert',
          label: `Code approved by ${ who }, at an earlier commit`,
          title: `Approved ${ when } against ${ signoff.sha || 'a commit that is no longer the tip' }, and the branch has moved past it. The code question is open again.`,
        };
      }

      return {
        tone:  'success',
        icon:  'check',
        label: `Code approved by ${ who }`,
        title: `Approved ${ when } against ${ signoff.sha || 'this commit' }. Your job here is the outcome: whether it does what the brief said it would.`,
      };
    },

    /**
     * The two gate rows the footer draws (39:1392, 39:1400).
     *
     * One boundary with two halves, and the design draws both here so the reviewer can see that
     * theirs is the second one. `done` is what fills the marker, and it is only true for an
     * approval that still covers this commit - a stale one is on record and is not a gate that
     * is closed.
     */
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
          done: !stale,
          text: stale
            ? `${ who } approved an earlier commit, so it no longer covers this one`
            : `${ who } · ${ when }`,
        };
      };

      // "you · in progress" is what the design draws, and it is true whenever the sign-off is
      // this session's to give. When the brief names somebody else it is not, and the row says
      // who it is waiting for rather than pretending it is waiting for the reader.
      const waitingOutcome = this.asked && this.me && this.asked !== this.me.principal
        ? `waiting on ${ this.asked }`
        : 'you · in progress';

      return [
        {
          id: 'code', label: 'Code review', ...say(this.gate.code, this.gate.codeStale, 'not signed off'),
        },
        {
          id:    'outcome',
          label: 'Outcome sign-off',
          ...say(this.gate.outcome, this.gate.outcomeStale, waitingOutcome),
        },
      ];
    },

    /**
     * Whether the person standing here is the one the brief says asked for this.
     *
     * '' means nothing is holding them back, which is either because the brief names them or
     * because it names nobody. The distinction is said out loud in `requesterNote` rather than
     * folded away, because "no requester recorded" and "you are the requester" are different
     * facts and only one of them is a check.
     */
    requesterBlocker() {
      if (!this.asked) {
        return '';
      }

      if (!this.me) {
        return `The brief records ${ this.asked } as the person who asked for this, and Rancher would not say who you are, so a sign-off here could not be attributed to anybody.`;
      }

      return this.asked === this.me.principal
        ? ''
        : `The brief records ${ this.asked } as the person who asked for this, and the outcome sign-off is theirs to give. You are signed in as ${ this.me.principal }.`;
    },

    /**
     * What the screen says about the requester check, including when there is nothing to check.
     *
     * Screen 02 writes a `## Who asked` section at creation, so the check bites on anything
     * made since; on an extension that predates it - including the seeded `base` - the section
     * is absent and the check is inert. Saying "the requester is verified" would be a claim
     * about a section that may not be there; saying nothing at all would imply a check that is
     * not happening. So it says which of the two it is.
     */
    requesterNote() {
      if (this.requesterBlocker) {
        return this.requesterBlocker;
      }

      if (this.asked) {
        return 'The brief records you as the person who asked for this, so the outcome sign-off is yours to give.';
      }

      return 'This brief records no `## Who asked` - it was made before the Studio started recording who asked at creation - so the sign-off is not held to a requester. Whoever gives it is recorded by name against this commit.';
    },

    /** What the preview pane is showing, said on the pane rather than left to be inferred. */
    showingCriterion() {
      return this.criteria[this.showing] || null;
    },

    /**
     * The cluster id in the route the preview is on, or '' when the route has none.
     *
     * The framed thing is a whole dashboard, so its routes carry a cluster the way the rest of
     * Rancher's do: `/c/<id>/explorer`, and an extension's own page at `/<product>/c/<id>/...`.
     * That id is the answer to "which cluster is this page about", and it is the only place the
     * answer exists - nothing outside the frame is told.
     */
    previewCluster() {
      return CLUSTER_IN_ROUTE.exec(this.route || '')?.[2] || '';
    },

    /** The chosen cluster as Rancher describes it, when the list has been read and holds it. */
    previewClusterInfo() {
      return this.clusters.find((c) => c.id === this.previewCluster) || null;
    },

    /**
     * What the cluster row says next to the name (39:1371).
     *
     * The design annotates the current cluster with why it matters to this extension ("no
     * metrics-server"). Nothing here can know which capability a given extension depends on,
     * so the annotation is what the cluster object says about itself - which is a fact about
     * every cluster and is the information somebody choosing between two of them needs.
     */
    clusterNote() {
      const info = this.previewClusterInfo;

      if (!info) {
        return '';
      }

      const parts = [
        info.ready ? '' : 'not ready',
        info.provider,
        info.version,
        info.nodes ? `${ info.nodes } node${ info.nodes === 1 ? '' : 's' }` : '',
      ].filter(Boolean);

      return parts.join(' · ');
    },

    /** The dropdown behind the cluster row, one line per cluster this Rancher has. */
    clusterItems() {
      return this.clusters.map((c) => ({
        id:       c.id,
        label:    c.name,
        icon:     c.id === this.previewCluster ? 'check' : 'server',
        disabled: c.id === this.previewCluster,
        note:     [c.ready ? '' : 'not ready', c.provider, c.version].filter(Boolean).join(' · '),
      }));
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

      if (this.signedOff) {
        return `Signed off on ${ this.signedOff.on }${ this.signedOff.by ? ` by ${ this.signedOff.by }` : '' }. Changing a verdict takes the sign-off back.`;
      }

      if (!this.failed && !this.unsure && !this.undecided) {
        return 'Every criterion met. Signing off records that in the brief.';
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

      // What the counts mean for the gate. Only a No and an unanswered row hold it open, and
      // this is the same rule the sign-off button enforces - the footer and the button cannot
      // disagree, because both are `canSignOff`. The counts are in `parts` already, so the
      // tail says what they mean rather than saying them again.
      let tail = ' Nothing is holding the sign-off open.';

      if (this.failed) {
        tail = ' A No holds the sign-off open until it is answered Yes.';
      } else if (this.undecided) {
        tail = ' The sign-off waits on the ones nobody has looked at.';
      }

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

    /**
     * The provenance an accepted non-goal is stamped with, and the same string the preview
     * shows, so what is read is what is written.
     */
    driftStamp() {
      const who = this.signedInAs;

      return `accepted during verification on ${ today() }${ who ? ` by ${ who }` : '' }`;
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
    /** One of the header kebab's items was chosen. Dispatched here by the same mixin. */
    handlePageAction(action) {
      handleStudioPageAction(this, action);
    },

    async load() {
      // A freshly created extension has no repository yet, and every reading on this screen
      // is a git reading - so without this the screen is simply empty, with nothing saying
      // why. Memoised and idempotent, so this costs one exec the first time and nothing after.
      await ensureRepo(this.extension).catch(() => {});

      this.loading = true;

      const [brief, changed, diff, pkg, review, provenance, asked, me] = await Promise.all([
        readExtensionFile(this.extension, 'BRIEF.md').catch(() => ''),
        changedFiles(this.extension).catch(() => []),
        workingDiff(this.extension).catch(() => ''),
        readExtensionFile(this.extension, 'package.json').catch(() => ''),
        // Who has decided what about this change. A missing record is the normal state of an
        // extension nobody has reviewed and costs one 404.
        readReview(this.extension).catch(() => NO_REVIEW),
        // The commit a sign-off is given against, so it can go stale when the branch moves.
        changeProvenance(this.extension).catch(() => null),
        // Who the brief says asked for this, and '' when it says nobody - which is every brief
        // today. Read here rather than only inside `signOutcome` so the screen can say whose
        // sign-off this is before the button is pressed.
        whoAsked(this.extension).catch(() => ''),
        // Who the apiserver attributes this session to. Null when Rancher would not say, which
        // is the one case where nothing here can be attributed and the sign-off has to refuse.
        currentSigner().catch(() => null),
      ]);

      this.brief = brief;
      this.criteria = this.criteriaFrom(this.brief);
      this.problem = this.sectionOf(this.brief, 'The problem');
      this.changed = changed;
      this.diff = diff;
      // Everything the last save recorded, back on the screen. Without this the notes and the
      // sign-off were write-only: they went into the file and the next visit showed an empty
      // box, so recording again silently dropped them.
      this.notes = this.recordedNotes(brief);
      this.signedOff = this.recordedSignoff(brief);
      this.review = review;
      this.sha = provenance?.commit?.sha || '';
      this.asked = asked;
      this.me = me;
      this.version = this.versionOf(pkg);
      this.loading = false;

      if (await extensionReady(this.extension).catch(() => false)) {
        this.previewUrl = extensionUrl(this.extension);
      }

      // After the screen is up, because the criteria are what the reviewer came for and the
      // cluster row is furniture around the preview. A Rancher that will not answer leaves the
      // row saying so rather than leaving it empty.
      await previewClusters()
        .then((list) => {
          this.clusters = list;
          this.clustersRead = true;
        })
        .catch((e) => {
          this.clustersRead = false;
          this.clustersWhy = e?.message || String(e);
        });
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
        const wrote = queue.length ? queue.shift() : {
          verdict: '', route: '', note: '', captures: [],
        };

        return {
          text,
          // What the reviewer said about this one. Attached to the criterion rather than to the
          // page, because "it does not work" under a checklist of four is not a note anybody
          // can act on.
          note:    wrote.note || '',
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
          // What was captured against this criterion (39:1385), read back out of the file.
          // Unlike `taken` above these do survive, because they are written into the brief the
          // moment they are taken rather than being a fact about this session.
          captures: wrote.captures || [],
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
      let last = null;

      for (let i = range.at; i < range.end; i++) {
        const line = lines[i].trim();

        if (/^#{3,}\s/.test(line)) {
          inList = line.toLowerCase() === CRITERIA_HEADING;
          last = null;
          continue;
        }

        // A blockquote under a verdict line is that criterion's note, and may run to several
        // lines. It belongs to the verdict above it, so it is only read while there is one.
        const quoted = inList && last && NOTE_LINE.exec(line);

        if (quoted) {
          last.note = last.note ? `${ last.note }\n${ quoted[1] }` : quoted[1];
          continue;
        }

        // A capture belongs to the verdict above it for the same reason a note does, and is
        // read before the verdict line is tried because both start with a dash. The two cannot
        // be confused - a verdict is bold and a capture is not - but reading this first keeps
        // the order of the branches the same as the order of the lines in the file.
        const captured = inList && last && CAPTURE_LINE.exec(line);

        if (captured) {
          last.captures.push({
            at: captured[1], who: (captured[2] || '').trim(), route: captured[3],
          });
          continue;
        }

        const m = inList && VERDICT_LINE.exec(line);
        const verdict = m && WORD_VERDICTS[m[1].trim().toLowerCase()];

        if (!m || verdict === undefined) {
          continue;
        }

        const text = m[3].trim();

        last = {
          verdict, route: (m[2] || '').trim(), note: '', captures: [],
        };
        out.set(text, [...(out.get(text) || []), last]);
      }

      return out;
    },

    /** The reviewer's page-level notes, as the last save wrote them. */
    recordedNotes(brief) {
      const lines = brief.split('\n');
      const range = this.sectionRange(lines, 'Verification');

      if (!range) {
        return '';
      }

      const out = [];
      let inNotes = false;

      for (let i = range.at; i < range.end; i++) {
        const line = lines[i];

        if (/^#{3,}\s/.test(line.trim())) {
          inNotes = line.trim().toLowerCase() === NOTES_HEADING;
          continue;
        }

        if (inNotes) {
          out.push(line);
        }
      }

      return out.join('\n').trim();
    },

    /** Who closed the outcome gate, and when, or null while it is open. */
    recordedSignoff(brief) {
      const lines = brief.split('\n');
      const range = this.sectionRange(lines, 'Verification');

      if (!range) {
        return null;
      }

      for (let i = range.at; i < range.end; i++) {
        const m = SIGNOFF_LINE.exec(lines[i].trim());

        if (m) {
          return { by: (m[1] || '').trim(), on: m[2] };
        }
      }

      return null;
    },

    /** The extension's version, for the masthead. Empty when its package.json cannot be read. */
    versionOf(pkg) {
      try {
        return JSON.parse(pkg).version || '';
      } catch {
        return '';
      }
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
      // An approval, specifically. The outcome slot also holds a "changes requested" - what
      // "Send the whole list back" records - and that is not a judgement changing a verdict
      // invalidates: the author still has the list to work through, and the way to withdraw it
      // is to sign off, not to touch a radio button.
      const recorded = this.gate.outcome?.verdict === 'approved';

      // A sign-off is a judgement on the answers as they stood. Change one and it is no longer
      // a judgement on anything, so it goes - and the next save writes the file without it.
      this.signedOff = null;

      // The brief's line goes on the next save, which is how this has always worked. The
      // review record cannot wait for that: it is what the distribution gate reads, and a gate
      // left open on a verdict somebody has just changed is worse than no gate at all. So the
      // authoritative half is withdrawn now, and the button that writes the file catches up.
      if (recorded) {
        this.revokeOutcome();
      }
    },

    /**
     * Take the outcome sign-off back out of the review record.
     *
     * The other half of what changing a verdict already did to the brief. Read-change-write
     * through `updateReview`, so a second reviewer writing between the two gets a 409 rather
     * than having their answer silently dropped.
     */
    async revokeOutcome(announce = true) {
      if (this.revoking) {
        return;
      }

      this.revoking = true;

      try {
        this.review = await updateReview(this.extension, (record) => {
          const signoffs = { ...record.signoffs };

          delete signoffs.outcome;

          return { ...record, signoffs };
        });

        if (announce) {
          toastSuccess(
            this.$store,
            'The outcome sign-off is out of the review record, so the distribution gate is shut again. The line in BRIEF.md goes when you record the result.',
            { title: 'Sign-off withdrawn' }
          );
        }
      } catch (e) {
        toastError(
          this.$store,
          `${ e?.message || String(e) } The sign-off is still on record, so the gate is still open on it.`,
          { title: 'Could not withdraw the sign-off' }
        );
      } finally {
        this.revoking = false;
      }
    },

    /** "Checked 12:41 · admin", or just the time when the shell has no name for the user. */
    provenance() {
      const at = `Checked ${ clock(new Date()) }`;

      return this.signedInAs ? `${ at } · ${ this.signedInAs }` : at;
    },

    /**
     * Whoever a capture is attributed to, in a form a capture line can hold.
     *
     * The apiserver's answer first, because that is the identity the sign-off is recorded
     * under and the two should not name the same person two ways. Backticks and "at" are
     * removed because they are what the line's own grammar is made of; a name this leaves
     * empty is written as no name rather than as a guess.
     */
    capturedBy() {
      const who = this.me?.name || this.me?.principal || this.signedInAs || '';

      return String(who).replace(/`/g, '').replace(/\s+at\s+/gi, ' ').replace(/\s+/g, ' ').trim();
    },

    /**
     * Capture what the preview is showing as evidence for the criterion it is showing it for
     * (39:1385).
     *
     * What is captured is what can honestly be captured: the clock, the person the apiserver
     * names, and the route the framed dashboard is on. Not a picture - see the note beside the
     * button - and that is the whole difference between this and the design's screenshot
     * upload, which is why the two are not one feature after all.
     *
     * It writes immediately rather than waiting for "Record the result". The sentence this
     * sits under promises that what you are looking at is captured with your answer, and a
     * capture that only exists in this tab until somebody remembers to press save is a promise
     * the next reload breaks. `save()` writes the whole pass, so the verdicts and notes as
     * they stand go with it, and the toast says so.
     *
     * It refuses rather than guessing when the preview is not on a criterion. A capture
     * attached to whichever criterion happened to be first would be evidence pointing at the
     * wrong row, which is worse than no evidence.
     */
    async captureEvidence() {
      const criterion = this.showingCriterion;

      if (!criterion || this.saving) {
        return;
      }

      const capture = {
        at: stamp(new Date()), who: this.capturedBy(), route: this.route || '/',
      };

      criterion.captures = [...(criterion.captures || []), capture];

      const wrote = await this.save(
        `Captured ${ capture.at.slice(11) } at ${ capture.route } against criterion ${ this.showing + 1 }`
      );

      if (!wrote) {
        // The file is what makes a capture evidence. If it did not land, the line must not sit
        // on the screen looking as though it did - `save` has already said why.
        criterion.captures = (criterion.captures || []).filter((c) => c !== capture);
      }
    },

    /**
     * Write the verdict back into the brief.
     *
     * The boxes go back into the same `- [ ]` lines they came out of, and a Verification section
     * is written underneath. That means the record of whether this thing did its job lives in
     * the repository, in the file that said what the job was.
     *
     * Returns whether the write landed, so a caller that does something after it - handing the
     * list back to the assistant - does not claim the verdicts are in the file when they are
     * not. The button callers ignore it, which is the same behaviour as before.
     */
    async save(message = 'Verification recorded') {
      this.saving = true;

      try {
        // The brief and the review record are two halves of one fact, so a save writes both.
        // `record()` below drops the sign-off line whenever `signedOff` is null; this drops the
        // matching entry. It is a safety net rather than the main path - `set()` withdraws it
        // the moment the verdict changes - and it is quiet, because that toast has been shown.
        if (!this.signedOff && this.gate.outcome?.verdict === 'approved') {
          await this.revokeOutcome(false);
        }

        await writeExtensionFile(this.extension, 'BRIEF.md', this.record(this.brief));
        toastSuccess(this.$store, message, 'Written into BRIEF.md.');
        await this.load();

        return true;
      } catch (e) {
        toastError(this.$store, 'Could not record the verification', e?.message || String(e));

        return false;
      } finally {
        this.saving = false;
      }
    },

    /**
     * Close the outcome gate.
     *
     * The judgement this screen exists to take, and it is about the problem rather than about
     * the code: every criterion the brief set has been answered, and none of them was answered
     * No. It is refused while one is, which is the design's rule.
     *
     * It is one of the two answers the distribution gate needs, so it does hold that shut. It
     * does not hold a local load or a push to GitHub, which are deliberately ungated, and the
     * screen says which of the three it is rather than implying it blocks a publish.
     *
     * It is recorded twice, and the two records are not redundant. The review ConfigMap is the
     * authority: it carries the Rancher principal the apiserver attributes this session to and
     * the commit the answer was given against, and it is what the queue, the review screen and
     * the distribution gate read. The brief carries the human sentence, beside the verdicts it
     * was given for, so anybody who opens the file in the repository can see who closed it.
     *
     * The record goes first. If it is refused - and it is refused when the brief names somebody
     * else as the person who asked - nothing is written to the brief either, because a brief
     * claiming a sign-off the gate does not hold is the worst of the three outcomes.
     */
    async signOff() {
      if (!this.canSignOff) {
        return;
      }

      this.saving = true;

      let signoff = null;

      try {
        signoff = await signOutcome(this.extension, {
          verdict: 'approved',
          sha:     this.sha,
          note:    this.notes.trim(),
        });
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'The outcome sign-off was refused' });
      } finally {
        this.saving = false;
      }

      if (!signoff) {
        return;
      }

      this.signedOff = { by: signoff.name || signoff.principal, on: today() };

      await this.save('Outcome signed off');
    },

    /**
     * Put one failed criterion back to the assistant, with the reviewer's note.
     *
     * The one thing a reviewer can do about a No from here that is not bookkeeping. It goes to
     * the claude working on this extension and it answers in that extension's terminal, which
     * is what the card says - the screen does not draw a reply it has no way of receiving.
     */
    async sendBack(criterion, index) {
      if (this.sending >= 0) {
        return;
      }

      this.sending = index;

      try {
        const how = await askAssistant(this.extension, [
          `Verification of the ${ this.extension } extension found this acceptance criterion not met:`,
          `"${ criterion.text }".`,
          criterion.route ? `It was checked at ${ criterion.route }.` : '',
          criterion.note.trim() ? `The reviewer's note: "${ criterion.note.trim() }".` : '',
          'Work out why it is not met and fix it. Do not edit BRIEF.md - the verdicts are',
          'recorded by the reviewer.',
        ].filter(Boolean).join(' '));

        toastSuccess(
          this.$store,
          how === 'sent'
            ? 'Sent to the assistant working on this extension. It replies in the workspace terminal.'
            : 'The workspace session is not open yet, so this is the first thing it will be asked when it opens.',
          { title: 'Sent back' }
        );
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'Could not send it back' });
      } finally {
        this.sending = -1;
      }
    },

    /**
     * What accepting one drifted term would do to the brief (39:1348).
     *
     * Accepting drift is not "dismiss the warning". The warning is true - the change does
     * something the brief said it would not - and the only honest way to make it stop being
     * true is to change the brief: the text comes out of
     * `## What we are deliberately not doing` and goes into `## What changes for them`, stamped
     * with the day and the person, so the document now declares the behaviour and the next
     * reader can see it was agreed here rather than always having been in scope.
     *
     * Two things this returns rather than does, and both matter.
     *
     * It returns a plan, not a written file, so the screen can show exactly what will move
     * before anything moves. That was the bug: base's non-goals were one line, "No alerting,
     * and no history beyond 24 hours. Both belong in monitoring.", and accepting "alerting"
     * moved the whole line - so the untouched non-goal about 24-hour history was accepted by
     * nobody, the section was left `_not stated_`, and every later scope check on that
     * extension answered "there is nothing to measure against".
     *
     * And the unit it moves is the sentence the term is in, not the line. A non-goals section
     * is prose people write several rules into, and the line is whatever the author's wrapping
     * happened to make it. The sentence is the smallest piece that still reads as a rule.
     * It is not always small enough - the base sentence above states two rules in one - which
     * is why the plan is shown and confirmed rather than applied on the first press.
     *
     * Nothing else in the file is touched. The section this screen normally writes is
     * `## Verification` and this write leaves it exactly as it found it, because an unsaved
     * verdict on the page is not a verdict anybody recorded and accepting a drift is not the
     * moment to write one.
     *
     * Pure, and separate from the write, so it can be run against a real brief without a
     * cluster, and so the preview and the write cannot disagree about what happens.
     */
    driftPlan(brief, term, stamp = '') {
      const lines = brief.split('\n');
      const ruled = this.sectionRange(lines, 'What we are deliberately not doing');

      if (!ruled) {
        return { error: 'This brief has no "What we are deliberately not doing" section, so there is nothing to move out of it.' };
      }

      const needle = String(term).toLowerCase();
      const moved = [];
      const kept = [];

      for (let i = ruled.at; i < ruled.end; i++) {
        const line = lines[i];
        const hit = line.trim() && line.toLowerCase().includes(needle);

        if (!hit) {
          kept.push(line);
          continue;
        }

        // The list marker and any checkbox stay with whatever is left on the line, and are
        // dropped from what moves: the moved text becomes a statement of what the change
        // does, and a stray `- [ ]` in that section is a box somebody will tick.
        const marker = /^\s*[-*+]\s*(\[[ xX]\]\s*)?/.exec(line)?.[0] || '';
        const parts = this.sentences(line.slice(marker.length));
        const out = parts.filter((s) => s.toLowerCase().includes(needle));
        const stay = parts.filter((s) => !s.toLowerCase().includes(needle));

        out.forEach((s) => moved.push(s));

        if (stay.length) {
          kept.push(`${ marker }${ stay.join(' ') }`);
        }
      }

      if (!moved.length) {
        return { error: `"${ term }" is not in a sentence of its own in what the brief ruled out, so there is no rule to move.` };
      }

      // `_not stated_` rather than nothing, because that is the word screen 10 writes for an
      // empty section and the word its parser reads back as empty.
      const staying = kept.filter((l) => l.trim() && l.trim() !== '_not stated_');
      const body = staying.length ? kept : ['_not stated_', ''];

      lines.splice(ruled.at, ruled.end - ruled.at, ...body);

      const items = moved.map((text) => `- ${ text }${ stamp ? ` (${ stamp })` : '' }`);
      // Recomputed after the splice: the ranges above are indices into the array as it was.
      const changes = this.sectionRange(lines, 'What changes for them');

      if (changes) {
        let end = changes.end;

        while (end > changes.at && !lines[end - 1].trim()) {
          end--;
        }

        lines.splice(end, 0, '', ...items);
      } else {
        // No such section - a brief written by hand, or by something older than the form. It
        // goes immediately above the section the text came out of, which is the order screen
        // 10 writes the two in.
        const head = this.sectionRange(lines, 'What we are deliberately not doing').head;

        lines.splice(head, 0, '## What changes for them', '', ...items, '');
      }

      return {
        term,
        moving:  moved,
        staying: staying.map((l) => l.replace(/^\s*[-*+]\s*(\[[ xX]\]\s*)?/, '').trim()),
        text:    `${ lines.join('\n').replace(/\n+$/, '') }\n`,
      };
    },

    /**
     * One line of the non-goals section as the sentences it is made of.
     *
     * Split on a full stop, question mark or exclamation that is followed by whitespace or the
     * end of the line, keeping the punctuation on the sentence it closes. The lookahead is what
     * keeps `2.5` and `v1.2` in one piece. A line with no terminator at all - which is most
     * bulleted non-goals - comes back as a single sentence, so the old whole-line behaviour is
     * still what happens whenever the author wrote one rule per line.
     */
    sentences(text) {
      return (text.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) || [])
        .map((s) => s.trim())
        .filter(Boolean);
    },

    /**
     * Show what accepting one drifted term would move, before it moves (39:1348).
     *
     * The first press does not write. It puts the plan on the card - the exact text leaving
     * `## What we are deliberately not doing` and the exact text still ruled out afterwards -
     * and asks for a second press. That is the fix for accepting one term quietly accepting
     * every other rule that shared its sentence: it can still happen, because a sentence can
     * state two rules, but it can no longer happen without the reviewer reading the sentence
     * that is about to move.
     */
    previewDrift(hit) {
      if (this.accepting || this.rejecting) {
        return;
      }

      this.confirming = this.confirming === hit.term ? '' : hit.term;
    },

    /**
     * The plan for the term whose preview is open, or null.
     *
     * Computed rather than stored, so it follows `this.brief`: a write elsewhere on this screen
     * cannot leave a stale preview offering to move a line that is no longer there.
     */
    planFor(term) {
      if (!term) {
        return null;
      }

      return this.driftPlan(this.brief, term, this.driftStamp);
    },

    /**
     * Accept one drifted behaviour into the brief (39:1348).
     *
     * `this.brief` is reassigned from the text that was written rather than reloaded, so the
     * verdicts and notes on the page survive: `load()` re-reads the criteria and would throw
     * away anything unsaved. The scope card is computed off `this.brief`, so the row this
     * button was on goes as soon as the write lands.
     *
     * The plan is recomputed here rather than taken from the preview, for the same reason the
     * preview is a computed: the file may have moved under both of them, and the write has to
     * be the plan against the brief as it is now or not happen at all.
     */
    async acceptDrift(hit) {
      if (this.accepting || this.rejecting) {
        return;
      }

      const plan = this.driftPlan(this.brief, hit.term, this.driftStamp);

      if (plan.error) {
        toastError(this.$store, plan.error, { title: 'Could not add it to the brief' });

        return;
      }

      this.accepting = hit.term;

      try {
        await writeExtensionFile(this.extension, 'BRIEF.md', plan.text);
        this.brief = plan.text;
        this.confirming = '';

        toastSuccess(
          this.$store,
          plan.staying.length
            ? `Moved into what the brief says this change does. Still ruled out: ${ plan.staying.join(' ') }`
            : `"${ hit.term }" is now part of what the brief says this change does, and the brief no longer rules anything out.`,
          { title: 'Added to the brief' }
        );
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'Could not add it to the brief' });
      } finally {
        this.accepting = '';
      }
    },

    /**
     * Reject one drifted behaviour (39:1350).
     *
     * The brief is not touched: the author's list of what this was not doing was right, and the
     * thing that has to change is the code. So this goes the same way a failed criterion goes -
     * to the claude working on this extension, with the term and the files the match was found
     * in - and it answers in that extension's terminal. The screen does not tick anything and
     * does not pretend the behaviour is gone; a person reads the reply and looks again.
     *
     * It also says the one thing a word match cannot: that the hit may be a coincidence, and
     * that finding nothing is an acceptable answer. Without that, an assistant told to remove
     * a behaviour that was never there removes something else.
     */
    async removeDrift(hit) {
      if (this.accepting || this.rejecting) {
        return;
      }

      this.rejecting = hit.term;

      try {
        const how = await askAssistant(this.extension, [
          `The brief for the ${ this.extension } extension lists this under what it is`,
          `deliberately not doing: "${ this.nonGoals.replace(/\s+/g, ' ').trim() }".`,
          `Verification found the word "${ hit.term }" in lines this change adds, in:`,
          `${ hit.files.join(', ') }.`,
          'Read those lines. If the change really does the thing the brief ruled out, take that',
          'behaviour back out and leave the rest of the change alone. If the match is a',
          'coincidence and nothing there does it, change nothing and say so - a word match is',
          'not proof. Do not edit BRIEF.md: the brief is the reviewer\'s to change.',
        ].join(' '));

        toastSuccess(
          this.$store,
          how === 'sent'
            ? `Asked the assistant to take "${ hit.term }" back out. It replies in the workspace terminal, and this card will still warn until the lines are gone.`
            : 'The workspace session is not open yet, so this is the first thing it will be asked when it opens.',
          { title: 'Asked for it to come out' }
        );
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'Could not ask for it to come out' });
      } finally {
        this.rejecting = '';
      }
    },

    /**
     * Hand the whole pass back to whoever is building this (39:1405).
     *
     * Two things, in this order, because either alone is half an action: the pass is recorded
     * into BRIEF.md - every verdict, every route, every note - and then the same list goes to
     * the claude working on this extension so it does not have to be told to go and read it.
     * The brief is the durable half and the message is the prompt; the design draws one button
     * and this is the honest version of it.
     *
     * Three things, and the third is what was missing. Handing the list back is a refusal to
     * sign the outcome off, and a refusal is a state the review record already has: screen
     * 12's "Request changes" writes `changes-requested` into the code half, `gateFrom` reads
     * it, the queue reads it and puts the row back on the author's side, and the distribution
     * gate is shut on it. This screen wrote none of that, so the change stayed in the
     * reviewer's queue reading "the outcome sign-off is still outstanding" while the list was
     * already with the author. The design's own check is that the change leaves the reviewer's
     * queue, and this is the state that moves it.
     *
     * It is written before the brief, because the record is the half the gate reads and a
     * brief describing a hand-back the gate knows nothing about is the worse of the two
     * failures. The per-criterion "Send this back" is still the narrower action: one criterion,
     * one reason, and no change to the gate.
     *
     * There are two cases where the record cannot take it, and both are said out loud instead
     * of failing the whole press: no commit to record it against, and a brief that names
     * somebody else as the person whose answer the outcome is. The list still goes back in
     * both - it is the author's to work through either way.
     */
    async sendListBack() {
      if (this.handing || !this.criteria.length) {
        return;
      }

      this.handing = true;

      try {
        const refused = await this.refuseOutcome();
        const wrote = await this.save('The whole pass is in BRIEF.md');

        if (!wrote) {
          return;
        }

        const list = this.criteria
          .map((c, i) => [
            `(${ i + 1 })`,
            `[${ VERDICT_WORDS[c.verdict] ?? VERDICT_WORDS[''] }]`,
            c.text,
            c.route ? `[checked at ${ c.route }]` : '',
            c.note?.trim() ? `- the reviewer wrote: "${ c.note.replace(/\s+/g, ' ').trim() }"` : '',
          ].filter(Boolean).join(' '))
          .join('; ');

        const how = await askAssistant(this.extension, [
          `A reviewer has been through every acceptance criterion for the ${ this.extension }`,
          'extension and is handing the whole list back. The verdicts and their notes are',
          'recorded in BRIEF.md under `## Verification`, and here they are:',
          `${ list }.`,
          this.notes.trim() ? `Notes on the whole pass: "${ this.notes.replace(/\s+/g, ' ').trim() }".` : '',
          'Work through the ones that are not met, and for anything answered "Could not tell"',
          'say what would make it decidable. Do not edit BRIEF.md - the verdicts are the',
          'reviewer\'s.',
        ].filter(Boolean).join(' '));

        toastSuccess(
          this.$store,
          [
            `All ${ this.criteria.length } verdicts are in BRIEF.md.`,
            refused.recorded
              ? 'The review record has the outcome answered "changes requested" against this commit, so the queue shows the change as back with its author and the distribution gate is shut on it.'
              : refused.why,
            how === 'sent'
              ? 'The list has gone to the assistant working on this extension; it replies in the workspace terminal.'
              : 'No workspace session is open yet, so the list is the first thing that conversation will be asked.',
          ].filter(Boolean).join(' '),
          { title: 'Sent the whole list back' }
        );
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'Could not send the list back' });
      } finally {
        this.handing = false;
      }
    },

    /**
     * Record the refusal half of "send the whole list back".
     *
     * `changes-requested` in the outcome slot of the review record, against the commit the pass
     * was taken at, with the counts as the reason - the same shape and the same function screen
     * 12 uses for the code half, so the queue, the review screen and the publish dialog all
     * read it without knowing which screen wrote it.
     *
     * It answers rather than throwing, because the two ways it can decline are both ordinary
     * and neither should cost the reviewer the rest of the press.
     */
    async refuseOutcome() {
      if (!this.sha) {
        return {
          recorded: false,
          why:      'The review record was left alone: nothing in this extension is committed, so there is no commit to record the refusal against and a refusal covering nothing would read as covering everything.',
        };
      }

      if (this.requesterBlocker) {
        return { recorded: false, why: `The review record was left alone: ${ this.requesterBlocker }` };
      }

      const counts = [
        this.failed ? `${ this.failed } answered No` : '',
        this.unsure ? `${ this.unsure } could not be judged` : '',
        this.undecided ? `${ this.undecided } not looked at` : '',
      ].filter(Boolean).join(', ');

      try {
        const signoff = await signOutcome(this.extension, {
          verdict: 'changes-requested',
          sha:     this.sha,
          note:    `The whole criteria list was handed back${ counts ? `: ${ counts }` : ' after the pass' }. The verdicts and notes are in BRIEF.md under \`## Verification\`.`,
        });

        // So the footer's two gate rows and the sign-off button are right before the reload
        // `save()` does, rather than for the second in between.
        this.review = { ...this.review, signoffs: { ...this.review.signoffs, outcome: signoff } };

        return { recorded: true, why: '' };
      } catch (e) {
        return { recorded: false, why: `The review record could not be written: ${ e?.message || String(e) }` };
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
      ];

      if (this.signedOff) {
        block.push(
          `Outcome signed off${ this.signedOff.by ? ` by ${ this.signedOff.by }` : '' } on ${ this.signedOff.on }.`,
          ''
        );
      }

      block.push('### Criteria', '');

      this.criteria.forEach((c) => {
        const word = VERDICT_WORDS[c.verdict] ?? VERDICT_WORDS[''];
        const where = c.route ? ` at \`${ c.route }\`` : '';

        block.push(`- **${ word }**${ where }: ${ c.text }`);

        // The note goes under its own criterion as a blockquote, so it stays attached to the
        // line it is about wherever the brief is read.
        if (c.note?.trim()) {
          c.note.trim().split('\n').forEach((line) => block.push(`  > ${ line }`));
        }

        // Then what was captured against it, in the order it was captured. Indented under the
        // verdict, so a markdown renderer nests it inside the criterion rather than starting a
        // new list, and readable by eye in a `git diff` of the brief - which is the point of
        // keeping evidence in the file the code is reviewed with.
        (c.captures || []).forEach((cap) => {
          const who = cap.who ? ` by ${ cap.who }` : '';

          block.push(`  - Captured ${ cap.at }${ who } at \`${ cap.route }\``);
        });
      });

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
    showMe(criterion, index) {
      const panel = this.$refs.preview;

      // Which criterion the pane is answering, said on the pane. Set before the guard below,
      // because a preview that is still compiling is still being asked about this one.
      this.showing = index;

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
     * Point the previewed page at another cluster (39:1364).
     *
     * The frame is a dashboard, so the cluster is in its route: this rewrites that segment and
     * navigates, which is the same thing typing the path into the address field would do. What
     * it does not do, and says it does not, is move the dev server - that runs in this
     * extension's own pod, in `local`, wherever the page it serves is pointed.
     *
     * A route with no cluster in it (the extension's own start page, for one) has nothing to
     * rewrite, so this takes the preview to that cluster's explorer instead, which is a page
     * the framed dashboard certainly has. Either way it is a real navigation of a real
     * dashboard and not a setting kept on this side of the frame.
     */
    chooseCluster(id) {
      const panel = this.$refs.preview;

      if (!id || !panel || id === this.previewCluster) {
        return;
      }

      const m = CLUSTER_IN_ROUTE.exec(this.route || '');

      panel.address = m ? `${ m[1] }${ id }${ m[3] }` : `/c/${ id }/explorer`;
      panel.go();

      toastSuccess(
        this.$store,
        m
          ? `The preview is on the same page in ${ id }. The dev server has not moved - it runs in this extension's pod, in local, whichever cluster the page it serves is about.`
          : `The route the preview was on names no cluster, so this is ${ id }'s explorer. Navigate to the extension's own page from there and the picker will follow it.`,
        { title: `Preview pointed at ${ id }` }
      );
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
          <!--
            Which build is being signed off, out of the extension's own package.json. The
            design puts it here and nothing on the screen used to read it.
          -->
          <span v-if="version" class="verify__version">v{{ version }}</span>
        </div>
        <!--
          39:1186, the role line. The design has it name the reviewer as the person who raised
          the ticket; there is no ticket and no per-reviewer role in this product, so it says
          the job this screen is - the outcome sign-off - and who is signed in to do it, and
          claims nothing about why they were asked.
        -->
        <div class="verify__eyebrow" data-testid="verify-role">
          Verification · outcome sign-off{{ signedInAs ? ` · ${ signedInAs }` : '' }}
        </div>
      </div>

      <SBadge :status="verdictBadge" :label="verdictLabel" />

      <!--
        39:1187: the other half of the gate, so the reviewer knows their job is only the
        outcome. Read out of the review record rather than asserted, so it says "not reviewed
        yet" and "asked for changes" as readily as it says "approved".
      -->
      <SChip
        data-testid="verify-code-gate"
        :icon="codeChip.icon"
        :tone="codeChip.tone"
        :label="codeChip.label"
        :title="codeChip.title"
      />

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
          <SChip
            data-testid="verify-progress"
            :label="`${ settled }/${ criteria.length }`"
            tone="subtle"
            title="Criteria you have settled. A Yes or a No settles one; a Can't tell does not."
          />
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
            <!--
              What this pass is for, and what it is not (39:1212).
              The block used to be the brief's problem statement under a heading, which is
              useful but is not what an accented block at the top of the screen is for: the
              person reading it may never have reviewed anything before, and what they need
              first is what their job is and what it is not.
            -->
            <SBanner type="success" class="verify__framing" data-testid="verify-framing">
              <span class="verify__framing-lead">
                You are checking whether this does the job, not whether the code is any good
              </span>
              <p class="verify__framing-text">
                Reading the code is a separate step, on the review screen, and not this one.
                Answer each criterion
                against what you can see in the preview on the right. Nothing here changes the
                extension: the only thing you can change from this screen is the record of what
                you found.
              </p>
              <p v-if="problem" class="verify__framing-text">
                <strong>The problem this was for.</strong> {{ problem }}
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

                  <!--
                    39:1225's "Captured 12:41 · you", one line per capture. Unlike the
                    provenance line above it these are in BRIEF.md, so they are still here a
                    week later and after a reload - which is the whole claim the sentence under
                    the preview makes about them.
                  -->
                  <div
                    v-for="(cap, ci) in c.captures"
                    :key="`${ cap.at }-${ ci }`"
                    class="verify__meta verify__meta--captured"
                    :data-testid="`verify-capture-${ i }-${ ci }`"
                    :title="`Captured ${ cap.at }${ cap.who ? ` by ${ cap.who }` : '' }, recorded in BRIEF.md under this criterion`"
                  >
                    <SIcon name="save" :size="12" />
                    <span>Captured {{ cap.at.slice(11) }}</span>
                    <span v-if="cap.who" class="verify__meta-sep">·</span>
                    <span v-if="cap.who">{{ cap.who }}</span>
                    <span class="verify__meta-sep">·</span>
                    <span class="verify__meta-route">{{ cap.route }}</span>
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
                  @click="showMe(c, i)"
                >
                  Show me
                </SButton>

                <!--
                  39:1295: what a No opens up. The tint alone said a criterion had failed and
                  gave the reviewer nowhere to say why, which is the half of a No that is worth
                  anything to whoever has to fix it.
                -->
                <!--
                  `|| c.note` so a note written under a No does not become invisible saved
                  state the moment the verdict is changed to something else. It stays on the
                  screen, in the file, and editable.
                -->
                <div v-if="c.verdict === 'fail' || c.note" class="verify__failed">
                  <p
                    v-if="c.verdict === 'fail'"
                    class="verify__failed-rule"
                    data-testid="verify-blocked-note"
                  >
                    A No holds the outcome sign-off open until it is answered Yes; a "Can't
                    tell" does not. That sign-off is one of the two answers the distribution
                    gate needs, so a No holds <strong>distributing this to other Ranchers</strong>
                    shut as well. It holds neither of the other two ways out: loading this
                    extension into this Rancher, and pushing the source to GitHub for review,
                    are both deliberately ungated and stay open while this says No.
                  </p>

                  <div class="verify__note">
                    <SLabel :text="`Why criterion ${ i + 1 } is not met`" />
                    <textarea
                      v-model="c.note"
                      class="verify__notes-input"
                      rows="2"
                      :data-testid="`verify-note-${ i }`"
                      placeholder="What you did, what you saw instead, and where."
                    />
                    <p class="verify__note-hint">
                      Recorded in <strong>BRIEF.md</strong> under this criterion when you record
                      the result, so it is there for whoever opens the brief next. Sending it
                      back puts it to the assistant as well.
                    </p>
                  </div>

                  <div v-if="c.verdict === 'fail'" class="verify__failed-actions">
                    <SButton
                      variant="neutral"
                      size="sm"
                      icon="sparkle"
                      :loading="sending === i"
                      :data-testid="`verify-send-back-${ i }`"
                      @click="sendBack(c, i)"
                    >
                      Send this back to the assistant
                    </SButton>
                  </div>
                </div>
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
                  <div
                    v-for="hit in scopeDrift"
                    :key="hit.term"
                    class="verify__drift-hit"
                  >
                    <div class="verify__drift-row">
                      <code class="verify__term">{{ hit.term }}</code>
                      <span class="verify__drift-files">{{ hit.files.join(', ') }}</span>

                      <!--
                        39:1348 and 39:1350, per hit rather than per card: the card can be
                        warning about three different words found in three different files, and
                        one button for all of them would accept or reject work nobody looked at.
                      -->
                      <div class="verify__drift-actions">
                        <SButton
                          variant="neutral"
                          size="sm"
                          :data-testid="`verify-accept-drift-${ hit.term }`"
                          :disabled="!!accepting || !!rejecting"
                          :aria-expanded="confirming === hit.term"
                          title="Shows exactly which sentence would leave what the brief rules out, and what would still be ruled out afterwards. Nothing is written until you confirm."
                          @click="previewDrift(hit)"
                        >
                          That is fine - add it to the brief
                        </SButton>
                        <SButton
                          variant="ghost"
                          size="sm"
                          icon="undo"
                          :data-testid="`verify-remove-drift-${ hit.term }`"
                          :loading="rejecting === hit.term"
                          :disabled="!!accepting || !!rejecting"
                          title="Asks the assistant working on this extension to take the behaviour back out. It answers in the workspace terminal."
                          @click="removeDrift(hit)"
                        >
                          Remove it
                        </SButton>
                      </div>
                    </div>

                    <!--
                      Exactly what will move, before it moves.
                      Accepting used to take the whole line the term sat on, so a second rule
                      written in the same sentence was accepted by nobody. The unit is now the
                      sentence, and a sentence can still hold two rules - so the sentence is
                      put on the screen and read before the file changes.
                    -->
                    <div
                      v-if="confirming === hit.term"
                      class="verify__drift-plan"
                      :data-testid="`verify-drift-plan-${ hit.term }`"
                    >
                      <template v-if="planFor(hit.term).error">
                        <p class="verify__drift-plan-error">
                          {{ planFor(hit.term).error }}
                        </p>
                      </template>

                      <template v-else>
                        <p class="verify__drift-plan-head">
                          This moves out of <em>What we are deliberately not doing</em> and into
                          <em>What changes for them</em>. Read it before you press: whatever else
                          the sentence rules out is accepted with it.
                        </p>

                        <ul class="verify__drift-plan-list">
                          <li
                            v-for="(line, n) in planFor(hit.term).moving"
                            :key="n"
                            class="verify__drift-plan-move"
                          >
                            {{ line }}
                            <span class="verify__drift-plan-stamp">({{ driftStamp }})</span>
                          </li>
                        </ul>

                        <p class="verify__drift-plan-head">
                          Still ruled out afterwards:
                        </p>

                        <ul
                          v-if="planFor(hit.term).staying.length"
                          class="verify__drift-plan-list"
                        >
                          <li
                            v-for="(line, n) in planFor(hit.term).staying"
                            :key="n"
                            class="verify__drift-plan-stay"
                          >
                            {{ line }}
                          </li>
                        </ul>

                        <p v-else class="verify__drift-plan-empty">
                          Nothing. The section becomes <code class="verify__term">_not stated_</code>,
                          and every later scope check on this extension will say there is nothing
                          to measure against.
                        </p>

                        <div class="verify__drift-actions">
                          <SButton
                            variant="primary"
                            size="sm"
                            :data-testid="`verify-confirm-drift-${ hit.term }`"
                            :loading="accepting === hit.term"
                            :disabled="!!accepting || !!rejecting"
                            @click="acceptDrift(hit)"
                          >
                            Move it into the brief
                          </SButton>
                          <SButton
                            variant="ghost"
                            size="sm"
                            :data-testid="`verify-cancel-drift-${ hit.term }`"
                            :disabled="!!accepting || !!rejecting"
                            @click="confirming = ''"
                          >
                            Leave it ruled out
                          </SButton>
                        </div>
                      </template>
                    </div>
                  </div>
                </div>

                <p class="verify__drift-note">
                  Accepting rewrites <strong>BRIEF.md</strong>: the sentence that ruled this out
                  moves into <em>What changes for them</em>, stamped with today's date, so the
                  brief now covers the behaviour and the warning goes. Removing it does not
                  touch the brief - it puts the behaviour to the assistant in this extension's
                  pod and asks for it back out, and that answer arrives in the workspace
                  terminal.
                </p>
              </template>

              <!--
                What this card can and cannot see, said in every one of its four states.
                The design's clause is "the build is compared back to its own brief, and
                anything outside it is flagged". This is not that, and saying so on the card is
                the difference between evidence and a claim: a word match over one section
                cannot see work that goes outside the brief in words the brief never used, and
                a green banner that did not say so would read as "nothing is out of scope".
              -->
              <p class="verify__scope-limit" data-testid="verify-scope-limit">
                <strong>What this can see:</strong> the words the brief used in
                <em>What we are deliberately not doing</em>, looked for in the lines this change
                adds. Nothing here reads the change, so work that goes outside the brief without
                reusing one of those words is not flagged - a clear result means those words did
                not turn up, not that the change stayed inside the brief.
              </p>
            </div>

            <div class="verify__notes">
              <SLabel text="Notes on the whole pass" />
              <textarea
                v-model="notes"
                class="verify__notes-input"
                data-testid="verify-notes"
                rows="3"
                placeholder="Anything the checklist does not cover - what you tried, what surprised you."
              />
            </div>

            <SBanner type="info">
              Recording the result ticks these boxes in <strong>BRIEF.md</strong> and appends a
              verification block, so the record lives in the repository next to the code.
            </SBanner>

            <!--
              39:1306 is the one of the design's three evidence controls that is still absent,
              and it is absent for a reason that does not apply to the other two. Said out loud
              rather than left as a gap: a reviewer who half-remembers the mock will look for an
              attach button, and "there is no file store" is a shorter answer than a search.
            -->
            <p class="verify__evidence-note" data-testid="verify-evidence-note">
              <strong>Captured, and not captured.</strong> A capture is the route, the clock and
              your name, written into the brief under the criterion - press
              <em>Capture this as evidence</em> beside the preview. A file is not: the two
              places this screen writes are BRIEF.md, which is markdown in the repository under
              review, and the review record, which is one ConfigMap that all of this extension's
              review state shares. A PNG in the first makes the evidence part of the thing being
              reviewed; in the second it is a few screenshots from etcd's object limit, taking
              the sign-offs with it when it goes over. So there is no upload. If a picture is
              the evidence, keep it where your team already keeps them and name it in the note.
            </p>
          </template>
        </div>
      </div>

      <!-- the thing being verified -->
      <div class="verify__preview">
        <div class="verify__panel-head">
          <SIcon name="eye" :size="14" />
          <!--
            39:1357: the pane says which criterion it is showing. Until "Show me" has been
            pressed it is showing the extension and nothing in particular, and it says that
            rather than naming a criterion nobody asked about.
          -->
          <span class="verify__panel-title" data-testid="verify-preview-context">
            {{ showingCriterion ? `Criterion ${ showing + 1 }` : 'The extension, running' }}
          </span>
          <span
            v-if="showingCriterion"
            class="verify__showing"
            :title="showingCriterion.text"
          >{{ showingCriterion.text }}</span>
          <span class="verify__grow" />
          <span
            class="verify__dot"
            :class="{ 'verify__dot--off': !previewUrl }"
            :title="previewUrl ? 'The dev server is answering' : 'The dev server is still compiling'"
          />
          <SButton
            variant="ghost"
            size="sm"
            icon="sparkle"
            @click="$router.push({ name: routes.EDITOR_ROUTE, params: { extension } })"
          >
            Back to the workspace
          </SButton>
        </div>

        <!--
          39:1364: the cluster row, with a chevron, so it is a chooser. Two facts live here and
          they used to be run together as one refusal. Where the dev server RUNS is not a
          choice - it is this extension's own pod, in `local`, and there is nowhere else to put
          it. Which cluster the framed page is ABOUT is a choice, because the frame is a whole
          dashboard and its routes carry a cluster id, so pointing it at another one exercises
          the extension against that cluster's data. The row says both.
        -->
        <div class="verify__where" data-testid="verify-preview-where">
          <template v-if="clustersRead && clusters.length">
            <SMenu
              :items="clusterItems"
              align="left"
              aria-label="Choose the cluster the previewed page is about"
              @select="chooseCluster"
            >
              <template #trigger>
                <span class="verify__cluster" data-testid="verify-cluster-select">
                  <SIcon name="server" :size="14" />
                  <strong>{{ previewCluster || 'Point it at a cluster' }}</strong>
                  <span v-if="clusterNote" class="verify__cluster-note">{{ clusterNote }}</span>
                  <SIcon name="chevronDown" :size="12" />
                </span>
              </template>
            </SMenu>
            <span
              class="verify__where-say"
              title="Two different facts. Which cluster the framed page is about is in its route, and this changes it. Where the dev server runs is not: extension pods are created in local and nowhere else, so the frame is served from there whichever cluster its pages address."
            >
              <template v-if="previewCluster">is what this page is about.</template>
              <template v-else>This route names no cluster; choosing one opens its explorer.</template>
              The dev server itself always runs in <strong>local</strong>, in this extension's pod.
            </span>
          </template>
          <span v-else class="verify__where-say">
            The page in the frame is served by this extension's own pod, in <strong>local</strong>.
            {{ clustersRead
              ? 'Rancher lists no clusters, so there is nothing to point it at.'
              : `Rancher would not list its clusters, so this cannot offer them: ${ clustersWhy }` }}
          </span>
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

        <!--
          39:1384 and 39:1385: the sentence, and the button under it. The design's third
          control here is a screenshot upload (39:1306) and that one is still absent - the
          sentence says so, and says what a capture is instead, because a reviewer who
          half-remembers the mock will go looking for all three.
        -->
        <div class="verify__capture">
          <p class="verify__capture-say" data-testid="verify-evidence-explainer">
            What you see here is captured with your answer - the route, the clock and your name,
            into <strong>BRIEF.md</strong> under the criterion - so nobody has to take your word
            for it later, and the next person to touch this extension knows why it was rejected.
            A picture is not: see the note on the left.
          </p>
          <SButton
            variant="neutral"
            size="sm"
            icon="save"
            data-testid="verify-capture-evidence"
            :loading="saving"
            :disabled="!showingCriterion || !previewUrl || saving"
            :title="showingCriterion
              ? `Records ${ route || '/' } against criterion ${ showing + 1 }, in BRIEF.md`
              : 'Press Show me on a criterion first: a capture has to be evidence for something, and this cannot guess which row you mean.'"
            @click="captureEvidence"
          >
            Capture this as evidence
          </SButton>
        </div>
      </div>
    </div>

    <!-- sign-off bar (39:1391) -->
    <div class="verify__signoff">
      <div class="verify__signoff-say">
        <!--
          39:1392 and 39:1400: both gates, in the order the design puts them, so the reviewer
          can see that theirs is the second one. The same rows screen 12 and the publish modal
          draw, off the same record.
        -->
        <div
          class="verify__gates"
          data-testid="verify-signoffs"
          title="Two questions, and they are not the same question: whether the code is right, and whether it did the job. Each is recorded against the commit it was given for, with the Rancher principal who gave it - recorded, not attested: there is no server in this product to sign anything."
        >
          <div
            v-for="g in gates"
            :key="g.id"
            class="verify__gate"
            :data-testid="`verify-gate-${ g.id }`"
            :data-done="g.done ? 'yes' : 'no'"
          >
            <span class="verify__gate-dot" :class="{ 'verify__gate-dot--on': g.done }">
              <SIcon v-if="g.done" name="check" :size="9" />
            </span>
            <span class="verify__gate-label">{{ g.label }}</span>
            <span class="verify__gate-sub">{{ g.text }}</span>
          </div>
        </div>

        <div class="verify__signoff-line">
          <SIcon name="user" :size="15" />
          <span class="verify__signoff-text">{{ signoffText }}</span>
        </div>

        <!--
          Who the sign-off belongs to, and the honest version of that on every brief that
          predates screen 02 recording it: there is no `## Who asked` to check against. Said
          rather than left out, because silence here reads as a check happening.
        -->
        <p class="verify__requester" data-testid="verify-requester">
          {{ requesterNote }}
        </p>
      </div>

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
        variant="neutral"
        icon="save"
        data-testid="verify-record"
        :loading="saving"
        :disabled="!criteria.length"
        @click="save()"
      >
        Record the result
      </SButton>
      <!--
        39:1405. Records the pass and then puts the whole list to the assistant in one press,
        which is the difference between this and the per-criterion "Send this back": that one
        is one criterion and one reason, this one is the review.
      -->
      <SButton
        variant="neutral"
        icon="undo"
        data-testid="verify-send-list-back"
        :loading="handing"
        :disabled="!criteria.length || saving"
        title="Answers the outcome question 'changes requested' in the review record, so the change goes back to its author's side of the queue and the distribution gate stays shut; writes every verdict, route, capture and note into BRIEF.md; and puts the whole list to the assistant working on this extension."
        @click="sendListBack"
      >
        Send the whole list back
      </SButton>
      <!--
        39:1391's primary action, which is a judgement rather than a save: every criterion the
        brief set has been answered and none of them was answered No. It is refused while one
        is, and the title says which criteria are holding it - a disabled button that will not
        say why is the same dead end as one that does nothing.
      -->
      <SButton
        variant="primary"
        icon="check"
        data-testid="verify-sign-off"
        :loading="saving"
        :disabled="!canSignOff"
        :title="signOffBlocker || 'Records the outcome sign-off against this commit, in the review record the distribution gate reads and in the brief'"
        @click="signOff"
      >
        Sign off on the outcome
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

  &__panel-title { font: var(--studio-heading-14); color: var(--studio-text); flex: 0 0 auto; }

  // Which cluster the framed page is about, and where the pod that serves it runs. Sits
  // between the pane head and the frame, so it is read once on the way to the preview rather
  // than competing with it.
  &__where {
    display:       flex;
    align-items:   baseline;
    flex-wrap:     wrap;
    gap:           var(--studio-space-6);
    margin:        0;
    padding:       var(--studio-space-6) 14px;
    background:    var(--studio-surface-subtle);
    border-bottom: 1px solid var(--studio-border-subtle);
    font:          var(--studio-caption-12);
    color:         var(--studio-text-tertiary);
    flex:          0 0 auto;
  }

  &__where-say { flex: 1 1 220px; min-width: 0; }

  // 39:1364's row: the server glyph, the cluster, what it is, and the chevron that says it is
  // a chooser.
  &__cluster {
    display:     inline-flex;
    align-items: center;
    gap:         var(--studio-space-6);
    color:       var(--studio-text);
  }

  &__cluster-note { color: var(--studio-text-tertiary); font: var(--studio-caption-12); }

  // 39:1384 and 39:1385, under the frame: what a capture is, and the button that takes one.
  &__capture {
    display:     flex;
    align-items: flex-start;
    gap:         var(--studio-space-8);
    padding:     var(--studio-space-8) 14px;
    background:  var(--studio-surface-subtle);
    border-top:  1px solid var(--studio-border-subtle);
    flex:        0 0 auto;
  }

  &__capture-say {
    margin:    0;
    flex:      1 1 auto;
    min-width: 0;
    font:      var(--studio-caption-12);
    color:     var(--studio-text-tertiary);
  }

  // The criterion the preview is bound to, next to its number. Truncated rather than wrapped:
  // the pane head is one line and the number carries the identity.
  &__showing {
    font:          var(--studio-caption-12);
    color:         var(--studio-text-secondary);
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
    min-width:     0;
  }

  // The design's live dot (39:1357), on the pane head where it says what is being checked.
  &__dot {
    width:         7px;
    height:        7px;
    flex:          0 0 auto;
    border-radius: var(--studio-radius-pill);
    background:    var(--studio-success);

    &--off { background: var(--studio-text-tertiary); }
  }

  // The extension's version, beside its name in the masthead.
  &__version {
    font:         var(--studio-mono-12);
    color:        var(--studio-text-tertiary);
    margin-left:  var(--studio-space-6);
  }

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
    // Wrap, so what a No opens up sits under the whole row rather than being squeezed in
    // beside the verdict control (39:1295 spans the row's full width).
    flex-wrap:      wrap;
    gap:            var(--studio-space-12);
    padding:        13px var(--studio-space-16);
    border-bottom:  1px solid var(--studio-border-subtle);

    &:last-child { border-bottom: none; }

    // Only the failing row is washed. A met criterion is marked by its badge going green;
    // tinting it as well makes a checklist that is mostly done unreadably loud.
    &--fail { background: var(--studio-error-bg); }
  }

  // 39:1295: the block a No opens. The rule it states, somewhere to say why, and the one thing
  // that can be done about it from here.
  &__failed {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-8);
    flex:           1 0 100%;
    min-width:      0;
  }

  &__failed-rule {
    font:   var(--studio-caption-12);
    color:  var(--studio-text-secondary);
    margin: 0;
  }

  &__note {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-4);
  }

  &__note-hint {
    font:   var(--studio-caption-12);
    color:  var(--studio-text-tertiary);
    margin: 0;
  }

  &__failed-actions {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
    flex-wrap:   wrap;
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
    color:           var(--studio-text);
    font:            var(--studio-caption-12-semi);

    // One hue per state, the same hue the chosen segment takes, so the badge and the control
    // never disagree about what was answered.
    // --studio-success, not --studio-green-500: the two are the same #3E8C4F in light, but
    // only the status token is lifted for dark, and a pass badge that stayed at the brand
    // value would sit a tier below the fail and unsure badges beside it.
    &--pass { background: var(--studio-success); color: var(--studio-on-success); }
    &--fail { background: var(--studio-error); color: var(--studio-on-error); }

    // Grey belongs to "Can't tell", and this is where it was taken back.
    //
    // The design assigns it and says why: 39:1316 is a grey #F2F3F5 circle holding the literal
    // "4", and the feature's own wording is "styled neutrally (grey, not red)". Grey is the
    // point of the state - a criterion nobody could settle is not a warning, it is an absence
    // of judgement, and warning amber (the token this product keeps for something that needs
    // attention) over-stated it on every row a reviewer had honestly answered.
    //
    // The product's fourth state - nobody has answered yet - is ours, not the mock's: "No
    // 'unanswered' state of the control is drawn: every criterion in the mock carries a
    // verdict." It had been wearing the design's grey, which is what forced Can't tell onto
    // amber. So the two swap roles below, and the distinction survives because the fourth
    // state stops being a fill at all: an answer is a filled badge (green, red, grey), and no
    // answer is an empty outline waiting for one. That reads better than the two greys of
    // different weight it replaces, where an unanswered row wore a solid chip that looked
    // like somebody had decided something.
    //
    // Ink is --studio-text rather than --studio-on-status: this fill is a pale wash in light
    // and a faint lift in dark, so the ink has to flip with the theme instead of being pinned
    // to the near-black the saturated fills carry.
    &--unsure {
      background: var(--studio-surface-nav);
      color:      var(--studio-text);
    }

    &--unanswered {
      background: transparent;
      border:     1px dashed var(--studio-control-empty-border);
      color:      var(--studio-control-empty-text);
    }
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

  // A capture is a fact in the file rather than a fact about this session, so it is drawn a
  // shade stronger than the provenance line above it.
  &__meta--captured { color: var(--studio-text-secondary); }

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

    // The row nobody has answered, which the mock never draws: no segment is filled, so the
    // whole control is drawn as the empty thing it is. A dashed edge rather than the grey wash
    // it used to wear, because 39:1330's grey is the fill a *chosen* "Can't tell" segment takes
    // (see --on-unsure below) and two greys a tier apart is not a distinction anybody reads at
    // a glance. Dashed says unfilled, and it is the same rule the badge follows.
    //
    // Colours come from the empty-control tokens, which is what makes the state survive the
    // dark theme - see studio.css: the frame's light values leave it reading as a disabled
    // control on a dark panel.
    &--unanswered {
      background:   transparent;
      border-style: dashed;
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

    // The third hue is the design's own: 39:1330 fills the chosen "Can't tell" segment with
    // grey #F2F3F5, and that is --studio-surface-nav here. It is the one selected fill that is
    // not a status colour, deliberately - "I looked and I cannot tell" is not a warning - so it
    // takes body ink rather than --studio-on-status, which is pinned near-black for saturated
    // fills and would vanish on the dark theme's version of this wash.
    //
    // The inset ring is the one addition. A #F2F3F5 fill on the control's white is 1.06:1, so
    // the mock's own grey selection is all but invisible where the green and the red are
    // obvious; aria-pressed carries it for a screen reader and nothing carried it for an eye.
    // Same departure-on-accessibility-grounds as --studio-on-status, and it leaves the design's
    // fill exactly as drawn rather than substituting a colour of our own.
    &--on-unsure,
    &--on-unsure:hover {
      background: var(--studio-surface-nav);
      color:      var(--studio-text);
      box-shadow: inset 0 0 0 1px var(--studio-border-strong);
    }
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

  &__drift-hit {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-6);
    min-width:      0;
  }

  &__drift-row {
    display:     flex;
    align-items: baseline;
    flex-wrap:   wrap;
    gap:         var(--studio-space-8);
    min-width:   0;
  }

  // What accepting would move, shown before it moves. Indented and boxed so it reads as
  // belonging to the row above it rather than as another hit.
  &__drift-plan {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-6);
    margin-left:    var(--studio-space-12);
    padding:        var(--studio-space-8) var(--studio-space-12);
    background:     var(--studio-surface-subtle);
    border-left:    3px solid var(--studio-warning);
    border-radius:  0 var(--studio-radius-control) var(--studio-radius-control) 0;
  }

  &__drift-plan-head,
  &__drift-plan-empty,
  &__drift-plan-error {
    margin: 0;
    font:   var(--studio-caption-12);
    color:  var(--studio-text-secondary);
  }

  &__drift-plan-error { color: var(--studio-error); }

  &__drift-plan-list {
    margin:  0;
    padding: 0 0 0 18px;
    display: flex;
    flex-direction: column;
    gap:     var(--studio-space-4);
  }

  &__drift-plan-move,
  &__drift-plan-stay {
    font:       var(--studio-body-13);
    color:      var(--studio-text);
    word-break: break-word;
  }

  &__drift-plan-stay { color: var(--studio-text-secondary); }

  &__drift-plan-stamp {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  &__drift-files {
    flex:      1 1 auto;
    min-width: 0;
    font:      var(--studio-body-13);
    color:     var(--studio-text-secondary);
    word-break: break-word;
  }

  // The two answers to one drifted term. Wrapped onto their own line on a narrow column, so
  // the file list keeps the width it needs to be readable.
  &__drift-actions {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-6);
    flex:        0 0 auto;
  }

  &__drift-note {
    margin: 0;
    font:   var(--studio-caption-12);
    color:  var(--studio-text-tertiary);
  }

  // The card's own disclaimer, under every state it can be in.
  &__evidence-note {
    margin: 0;
    font:   var(--studio-caption-12);
    color:  var(--studio-text-tertiary);
  }

  &__scope-limit {
    margin:     0;
    padding-top: var(--studio-space-8);
    border-top: 1px solid var(--studio-border-subtle);
    font:       var(--studio-caption-12);
    color:      var(--studio-text-tertiary);
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

  &__signoff-say {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-4);
    min-width:      0;
  }

  &__signoff-line {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-6);
  }

  &__signoff-text {
    font:  var(--studio-body-13);
    color: var(--studio-text-secondary);
  }

  &__gates {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-16);
    flex-wrap:   wrap;
  }

  // One gate: a marker that is filled or not, the question it answers, and who answered it.
  // The same shape screen 12's decision bar draws, because it is the same fact.
  &__gate {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-6);
  }

  &__gate-dot {
    display:         flex;
    align-items:     center;
    justify-content: center;
    flex:            0 0 auto;
    width:           13px;
    height:          13px;
    border-radius:   var(--studio-radius-pill);
    border:          1px solid var(--studio-border-strong);
    background:      var(--studio-surface);
    color:           var(--studio-on-status);

    &--on {
      background:   var(--studio-green-500);
      border-color: var(--studio-green-500);
    }
  }

  &__gate-label {
    font:  var(--studio-body-13);
    color: var(--studio-text-secondary);
  }

  &__gate-sub {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  &__requester {
    margin:    0;
    font:      var(--studio-caption-12);
    color:     var(--studio-text-tertiary);
    max-width: 70ch;
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
