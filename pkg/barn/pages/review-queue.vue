<script>
// Screen 11 · Review queue - what is waiting on you (Figma node 36:964).
//
// The queue is built from the review record (`review.ts`), not from a dirty working tree. That
// distinction is the whole screen: a change becomes a review request when its author hands it
// over as a packet, and until then it is the author's own work however many files are
// uncommitted in its pod. This list used to count `countChanges()`, so an author who had typed
// something was already in somebody's queue - the one behaviour the review design names as the
// thing the queue must stop doing.
//
// So each row reads three things and says which of them it is. `distributionGate()` is where
// the two sign-offs stand against the packet that was actually handed over; `readReview()`'s
// `packets` are the hand-overs themselves, with who pushed each and when; `sinceLastLook()` is
// what has landed since this reviewer last opened one. A change nobody has handed over is
// still listed, because it is real work and its next move is its author's, but it is labelled
// as never handed over and counted as the author's rather than as a review request.
//
// The footnote in the design states the rule this screen is built around - "rows lead with what
// the change is for, taken from its brief, not with a file count" - so each row's first line is
// the brief's opening paragraph, and a change with no brief says so plainly rather than falling
// back to a diffstat. The counts are on the line below, where they belong: they are how big the
// reading is, not what it is for.
//
// "Waiting on others" is back, and this time it has a truth condition. It was deleted when
// nothing in this product recorded who had decided what, so the filter could never match; the
// review record now names a principal per sign-off, so a change you have answered one half of
// and nobody else has answered the other half of is a real, observable state. It matches on a
// pre-packet sign-off as well as on a packet one, because a sign-off given against a commit is
// on record and `covers()` in review.ts already counts it - a predicate that only fired once
// somebody had pushed a packet would be a tab that could not match in this cluster today.
// There is still no "Your part" column, because most rows are the same part and a constant
// repeated per row is not information - what varies is the action, and the action cell says so.
import {
  SButton, SBadge, SChip, SIcon, SEmpty, STabs, SMenu, SModal, SField
} from '../components/ui';
import {
  listExtensions, extensionDetail, readExtensionFile, changedFiles, readDeferral, clearDeferral,
  listHistory
} from '../extensions';
import {
  readReview, gateFrom, distributionGate, currentSigner, whoAsked, sinceLastLook, lastLook,
  migrateDeferral, sameCommit
} from '../review';
import {
  STUDIO_ROUTE, REVIEW_CHANGE_ROUTE, VERIFICATION_ROUTE, BRIEF_ROUTE
} from '../editor-product';
import '../design/tokens';
import fullBleed from '../design/full-bleed';

const DAY = 24 * 60 * 60 * 1000;

/**
 * The orders the queue can be read in.
 *
 * The two by time say what they are ordered on in their note, and the note is not decoration:
 * what this screen can actually read is the last *commit*, so "oldest" means the change that
 * has been diverged from its branch longest, not the moment somebody typed. Calling that
 * "oldest" without saying so would be inventing a reading the cluster does not offer.
 */
const SORTS = [
  {
    id: 'oldest', label: 'Oldest first', icon: 'clock', note: 'by last commit'
  },
  {
    id: 'newest', label: 'Newest first', icon: 'clock', note: 'by last commit'
  },
  { id: 'most', label: 'Most changes', icon: 'compare' },
  { id: 'least', label: 'Least changes', icon: 'compare' },
];

/**
 * What this screen can be configured with, and where that is kept.
 *
 * Both settings change what the queue shows and both survive a reload, which is the whole test
 * of whether a settings dialog is a settings dialog. localStorage rather than the pod, because
 * neither is a fact about an extension: they are how one person likes to read the list, the
 * same place and for the same reason the editor keeps its splitter position.
 *
 * The gear used to open the *editor's* settings - a GitHub token - from a button labelled
 * "Review settings".
 */
const SETTINGS_KEY = 'barn.review.settings';
const DEFAULTS = { sort: 'oldest', signedOffDays: 7 };

function readReviewSettings() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || '{}');
    const days = parseInt(raw.signedOffDays, 10);

    return {
      sort:          SORTS.some((each) => each.id === raw.sort) ? raw.sort : DEFAULTS.sort,
      signedOffDays: days > 0 ? Math.min(90, days) : DEFAULTS.signedOffDays,
    };
  } catch (e) {
    return { ...DEFAULTS };
  }
}

function writeReviewSettings(settings) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    // A browser with storage turned off keeps the choice for this session and loses it on
    // reload. Nothing here is worth an error dialog.
  }
}

/** Markdown that is prose rather than code. */
const PROSE = /\.(md|markdown|txt)$/i;
/** The files that decide what the extension depends on. */
const MANIFEST = /(^|\/)package(-lock)?\.json$/;
/** The files Rancher loads first - a mistake in one of these takes the whole extension down. */
const ENTRY = /(^|\/)(index|product|routing)\.(ts|js)$/;

/**
 * How much of a reviewer's attention this change wants, and the one line saying why.
 *
 * The rating used to be a file count and nothing else, which cannot tell a ten-file
 * documentation pass from ten files of the extension's entry point. It reads the paths and the
 * diff sizes it already has: whether anything but prose changed, whether the dependency
 * manifest moved, whether the files Rancher loads first are among them, and how many lines.
 *
 * The reason is three clauses because that is what the design draws ("Read-only · no new
 * dependencies · one page"), and every clause is a reading rather than a judgement.
 */
function assessRisk(files) {
  if (!files.length) {
    return { level: 'none', reason: 'Nothing uncommitted since the last commit' };
  }

  const lines = files.reduce((n, f) => n + (f.added || 0) + (f.removed || 0), 0);
  const proseOnly = files.every((f) => PROSE.test(f.path));
  const deps = files.some((f) => MANIFEST.test(f.path));
  const entry = files.some((f) => ENTRY.test(f.path));

  let level = 'low';

  if (files.length > 8 || lines > 400) {
    level = 'high';
  } else if (deps || entry || files.length > 3 || lines > 80) {
    level = 'medium';
  }

  if (proseOnly) {
    // Prose cannot break the extension, however much of it there is.
    level = 'low';
  }

  const reason = [
    proseOnly ? 'Prose only, no code' : `${ lines } line${ lines === 1 ? '' : 's' } changed`,
    deps ? 'moves the dependencies' : 'no dependency changes',
    entry ? 'touches the entry point' : `${ files.length } file${ files.length === 1 ? '' : 's' }`,
  ];

  return { level, reason: reason.join(' · ') };
}

/**
 * The brief's opening paragraph, whole.
 *
 * Skips the title and the `## The problem` heading and takes what is under it, joining the
 * lines up to the next blank line or heading. Taking one *line* was the bug: BRIEF.md is hard
 * wrapped, so the sentence the row exists to show stopped mid-clause - "apart from a slow" -
 * and the half that said what the problem was never appeared.
 */
function intentFrom(brief) {
  if (!brief || !brief.trim()) {
    return '';
  }

  const lines = brief.split('\n').map((l) => l.trim());
  const heading = lines.findIndex((l) => /^##\s+The problem/i.test(l));
  const from = heading >= 0 ? heading + 1 : 0;

  for (let i = from; i < lines.length; i++) {
    if (!lines[i] || lines[i].startsWith('#') || lines[i] === '_not stated_') {
      continue;
    }

    const paragraph = [];

    for (let j = i; j < lines.length && lines[j] && !lines[j].startsWith('#'); j++) {
      paragraph.push(lines[j]);
    }

    return paragraph.join(' ');
  }

  return '';
}

/** How many acceptance criteria the brief sets, which is what a sign-off is measured against. */
function criteriaCount(brief) {
  const lines = (brief || '').split('\n').map((l) => l.trim());
  const at = lines.findIndex((l) => /^##\s+How we will know it worked/i.test(l));

  if (at < 0) {
    return 0;
  }

  let n = 0;

  for (let i = at + 1; i < lines.length && !lines[i].startsWith('#'); i++) {
    if (/^- \[[ xX]\]/.test(lines[i])) {
      n++;
    }
  }

  return n;
}

/** The extension's own version, off the package.json in its pod. '' if it does not say. */
function versionFrom(packageJson) {
  try {
    return JSON.parse(packageJson || '{}').version || '';
  } catch (e) {
    return '';
  }
}

export default {
  name: 'BarnReviewQueue',

  components: {
    SButton, SBadge, SChip, SIcon, SEmpty, STabs, SMenu, SModal, SField
  },

  mixins: [fullBleed],

  data() {
    const settings = readReviewSettings();

    return {
      rows:          [],
      tab:           'you',
      loading:       true,
      // Who the cluster believes is asking, so "waiting on others" can mean "on somebody who
      // is not you". null when Rancher would not say, and the tab says so rather than guessing.
      me:            null,
      sort:          settings.sort,
      signedOffDays: settings.signedOffDays,
      showSettings:  false,
      // The modal's working copy. Nothing is applied until Save, so Cancel leaves the queue as
      // it was rather than half-changed behind the dialog.
      draft:         { ...settings },
    };
  },

  computed: {
    /**
     * Changes that have been answered on both questions, inside the window.
     *
     * "Signed off" means sign-offs. It used to mean a clean working tree inside seven days,
     * which is the same mistake as the first tab made in the other direction: a tree with
     * nothing uncommitted in it is a tree nobody has decided anything about. The window is
     * measured from the later of the two answers, because that is when the change was signed
     * off, not when somebody last committed to it.
     */
    signedOff() {
      const span = this.signedOffDays * DAY;

      return this.rows.filter((r) => r.side === 'reviewer' && r.bothIn && r.signedAt &&
        (Date.now() - r.signedAt) < span);
    },

    /**
     * Changes you have already answered one half of, still waiting on somebody else.
     *
     * The predicate the deleted version of this tab could never satisfy. It is true when the
     * review record holds a live answer from you and the change is not through the gate - which
     * the design's own rule makes a real state rather than a formality: one person ticking both
     * boxes defeats it, so a change you have answered is a change waiting on a second person by
     * construction.
     */
    waitingOnOthers() {
      if (!this.me) {
        return [];
      }

      return this.rows.filter((r) => r.side === 'reviewer' && r.mine && !r.bothIn);
    },

    /**
     * Everything whose next move is yours.
     *
     * Two kinds, and the row says which: a hand-over whose outstanding sign-off is yours to
     * give, and a change of your own that has not been handed over - no brief, never pushed,
     * moved on past the packet that was signed, or asked back by a reviewer. Both are "you are
     * the one holding this up", which is what the tab promises; only the first is a review
     * request, and only the first carries a packet number.
     *
     * A change both people have answered is not here whether or not it is still inside the
     * signed-off window. Falling out of that window is a change leaving the queue, which is
     * what the window is for; it is not a change coming back to somebody.
     */
    waitingOnYou() {
      const elsewhere = new Set(this.waitingOnOthers.map((r) => r.name));

      return this.rows.filter((r) => !!r.side && !r.bothIn && !elsewhere.has(r.name));
    },

    signedOffLabel() {
      if (this.signedOffDays === 7) {
        return 'Signed off this week';
      }

      return `Signed off in ${ this.signedOffDays } day${ this.signedOffDays === 1 ? '' : 's' }`;
    },

    tabs() {
      return [
        { id: 'you', label: 'Waiting on you', count: this.waitingOnYou.length },
        { id: 'others', label: 'Waiting on others', count: this.waitingOnOthers.length },
        { id: 'signed', label: this.signedOffLabel, count: this.signedOff.length },
      ];
    },

    /**
     * The route names the template pushes to.
     *
     * A plain `<script>` block's module scope is not the render function's scope, so a
     * constant imported above and used bare in the template resolves to `undefined` and the
     * push is silently dropped. That is what the breadcrumb was doing. See the same computed
     * in files.vue.
     */
    routes() {
      return { STUDIO_ROUTE };
    },

    sortOptions() {
      // The chosen line is marked rather than hidden, so the menu is the same four lines every
      // time it opens and the current order is readable without closing it again.
      return SORTS.map((each) => ({
        ...each,
        note: each.id === this.sort ? [each.note, 'current'].filter(Boolean).join(' · ') : each.note,
      }));
    },

    sortLabel() {
      return (SORTS.find((each) => each.id === this.sort) || SORTS[0]).label;
    },

    draftSortOptions() {
      return SORTS.map((each) => ({
        ...each,
        note: each.id === this.draft.sort ? [each.note, 'current'].filter(Boolean).join(' · ') : each.note,
      }));
    },

    draftSortLabel() {
      return (SORTS.find((each) => each.id === this.draft.sort) || SORTS[0]).label;
    },

    shown() {
      const rows = {
        signed: this.signedOff, others: this.waitingOnOthers,
      }[this.tab] || this.waitingOnYou;

      return this.inOrder(rows);
    },
  },

  mounted() {
    this.load();
  },

  methods: {
    async load() {
      this.loading = true;

      // Once, not per row: the same two calls answer it for the whole screen, and a queue that
      // cannot say who you are is a queue with no "waiting on others" rather than no queue.
      this.me = await currentSigner().catch(() => null);

      const summaries = await listExtensions().catch(() => []);

      this.rows = summaries.map((s) => {
        const existing = this.rows.find((r) => r.name === s.name);

        return {
          ...(existing || {}),
          name:    s.name,
          ready:   s.ready,
          changes: existing?.changes || 0,
        };
      });
      this.loading = false;

      await Promise.all(summaries.map((s) => this.enrich(s.name)));
    },

    /**
     * Fill in one row's readings.
     *
     * The row is re-found after the reads rather than held across them - see the same note in
     * the extensions list. A reference captured before an await survives a reload of `rows`
     * only as an orphan, and writes to it go nowhere visible.
     */
    async enrich(name) {
      const [
        detail, files, brief, manifest, deferral, review, gate, history, asked, since,
      ] = await Promise.all([
        // `detail.changes` is the same reading `countChanges()` gives, from the same shell, so
        // this screen no longer pays a second exec for it. It is a size, not a queue: what a
        // reviewer has been asked to read is the packet, and the file count is how big it is.
        extensionDetail(name).catch(() => null),
        changedFiles(name).catch(() => []),
        readExtensionFile(name, 'BRIEF.md').catch(() => ''),
        readExtensionFile(name, 'package.json').catch(() => ''),
        // The old per-extension deferral, still in the pod's git config until it is migrated.
        readDeferral(name).catch(() => null),
        // Who has decided what, and what has been handed over. A missing record is the normal
        // state of an extension nobody has reviewed and costs one 404.
        readReview(name).catch(() => ({ signoffs: {}, packets: {}, looks: {} })),
        // Where the two sign-offs stand against the packet, which is the only thing they can
        // meaningfully stand against. null when the pod would not answer.
        distributionGate(name).catch(() => null),
        listHistory(name, 50).catch(() => []),
        // Who the brief records as having asked for this. '' for every extension written
        // before the brief had a place to put it, which is a real answer and is said out loud
        // rather than filled in with whoever is standing here.
        whoAsked(name).catch(() => ''),
        // The packet-based counterpart of the banner below, owned by review.ts: how many
        // hand-overs have landed since this reviewer last opened one.
        sinceLastLook(name).catch(() => null),
      ]);

      const look = await this.deferralFor(name, deferral);
      const row = this.rows.find((r) => r.name === name);

      if (!row) {
        return;
      }

      const risk = assessRisk(files);
      const head = history.find((h) => h.kind === 'commit')?.ref || '';
      const intent = intentFrom(brief);
      const reading = this.readingFor(review, gate, head, !!intent);

      row.packet = reading.packet;
      row.handed = reading.handed;
      row.handover = reading.handover;
      row.stage = reading.stage;
      row.side = reading.side;
      row.mine = reading.mine;
      row.bothIn = reading.bothIn;
      row.signedAt = reading.signedAt;
      row.reason = reading.reason;
      row.asked = asked;
      // The packet model's sentence first, because it is the product's own record of what this
      // reviewer has seen. It says nothing at all until they have opened a packet - somebody
      // who has never looked is new to the change, not behind on it - so the approval count is
      // what a row falls back on, and is all a change that predates packets can ever have.
      row.since = (since?.banner
        ? {
          text: since.banner, when: '', who: '', from: since.sha, packet: since.lastPacket,
        }
        : null) || this.changesSince(reading.code, history, detail?.changes || 0);

      row.changes = detail?.changes || 0;
      row.deferred = look;
      row.deferredLabel = this.deferredLabel(look);
      row.branch = detail?.branch || '';
      row.committedAt = detail?.lastChange ? Date.parse(detail.lastChange) || null : null;
      row.handedAt = reading.handedAt;
      row.intent = intent;
      row.version = versionFrom(manifest);
      row.criteria = criteriaCount(brief);
      row.size = this.sizeOf(files, row.criteria);
      row.risk = risk.level;
      row.riskReason = risk.reason;
      // The part, and therefore the action. Each value is a reading: a change nobody wrote a
      // brief for cannot be reviewed against anything, a change nobody has handed over has not
      // been asked of a reviewer at all, and a change whose code is approved is asking the
      // other question.
      row.part = this.partFor(row);
      // "2 hours", not "2 hours ago": the column heading already says Waiting. A hand-over has
      // been waiting since it was handed over; anything else since its last commit, which is
      // the only moment this cluster records.
      row.waited = this.waitedOn(row);
    },

    /**
     * Where this change stands, and whose move it is.
     *
     * Two readings and a rule for choosing between them. `distributionGate()` is the authority
     * whenever a packet exists: it compares each sign-off against the thing that was handed
     * over, which is the only object a sign-off can honestly be about. `gateFrom()` answers the
     * same two questions against the current commit, which is what a sign-off recorded before
     * packets existed was given against, so it is what a row falls back on until its first
     * hand-over. Both are read from the one record.
     *
     * `side` is what the tabs need. 'reviewer' means somebody has been asked something.
     * 'author' means the next move belongs to whoever is writing it: there is no brief, it has
     * never been handed over, it has moved on past the packet that was signed, or a reviewer
     * has asked for changes and the ball is back.
     */
    readingFor(review, gate, head, hasBrief) {
      const recorded = Object.values(review.packets || {})
        .filter((p) => p && p.n)
        .sort((a, b) => a.n - b.n)
        .pop() || null;
      const legacy = gateFrom(review, head);
      // The gate can only be believed about a packet it found. When the pod would not answer,
      // or has never had one, the two questions are still answerable at the current commit.
      const byPacket = !!gate && gate.packet > 0;
      const code = (byPacket ? gate.code : legacy.code) || null;
      const outcome = (byPacket ? gate.outcome : legacy.outcome) || null;
      const codeStale = byPacket ? gate.codeStale : legacy.codeStale;
      const outcomeStale = byPacket ? gate.outcomeStale : legacy.outcomeStale;
      const packet = (gate?.packet || 0) || recorded?.n || 0;

      const live = (s, stale) => !!s && !stale;
      const approved = (s, stale) => live(s, stale) && s.verdict === 'approved';
      const bothIn = approved(code, codeStale) && approved(outcome, outcomeStale);
      const mine = !!this.me && (
        (live(code, codeStale) && code.principal === this.me.principal) ||
        (live(outcome, outcomeStale) && outcome.principal === this.me.principal)
      );
      const state = byPacket ? gate.state : this.liveStage(code, outcome, codeStale, outcomeStale);

      let stage = state;
      let side = 'reviewer';

      if (!hasBrief) {
        stage = 'no-brief';
        side = 'author';
      } else if (state === 'changes-requested' || state === 'stale-packet' || state === 'stale') {
        side = 'author';
      } else if (!packet && !code && !outcome) {
        stage = 'not-handed';
        side = 'author';
      }

      const handedAt = recorded?.at ? Date.parse(recorded.at) || null : null;

      return {
        packet,
        handed:   packet > 0,
        handedAt,
        handover: packet ? this.handoverLine(packet, recorded) : '',
        stage,
        side,
        code,
        outcome,
        bothIn,
        mine,
        signedAt: bothIn ? Math.max(Date.parse(code.at) || 0, Date.parse(outcome.at) || 0) : 0,
        reason:   this.reasonFor(stage, byPacket ? gate.reason : '', code, outcome, packet),
      };
    },

    /**
     * The two questions, counting only the answers that are still about this change.
     *
     * `gateFrom` reports the states and the staleness, and it is the authority on staleness -
     * including the case of a sign-off that names no commit at all, which reads as stale
     * because a record that does not say what it covered cannot be read as covering whatever
     * is on the branch today. What it does not do is drop a stale answer out of the state
     * itself: `approved(code)` there is true whether or not the branch has moved. That is
     * right for the screen it was written for, which shows the sign-off and marks it stale
     * beside it, and wrong for a queue, where "the code is signed off" as a row's whole
     * sentence would be a claim about a commit nobody is looking at any more.
     */
    liveStage(code, outcome, codeStale, outcomeStale) {
      const live = (s, stale) => !!s && !stale;
      const approved = (s, stale) => live(s, stale) && s.verdict === 'approved';

      if ((live(code, codeStale) && code.verdict === 'changes-requested') ||
        (live(outcome, outcomeStale) && outcome.verdict === 'changes-requested')) {
        return 'changes-requested';
      }

      const codeIn = approved(code, codeStale);
      const outcomeIn = approved(outcome, outcomeStale);

      if (codeIn && outcomeIn) {
        return code.principal && code.principal === outcome.principal ? 'same-signer' : 'open';
      }

      if (codeIn) {
        return 'awaiting-outcome';
      }

      if (outcomeIn) {
        return 'awaiting-code';
      }

      // Answers on record, none of them about the change as it stands. Not "unsigned", which
      // would lose the fact that somebody once decided something here.
      return code || outcome ? 'stale' : 'unsigned';
    },

    /** What the record says about the hand-over itself: which packet, whose, when. */
    handoverLine(packet, recorded) {
      const by = recorded?.byName || recorded?.by || '';
      const when = recorded?.at ? ` ${ this.ago(recorded.at) }` : '';

      return `Handed over as packet ${ packet }${ when }${ by ? ` by ${ by }` : '' }.`;
    },

    /**
     * The one sentence saying what the row is waiting for.
     *
     * The gate writes its own when it has a packet to write about, and it is better than
     * anything this screen could compose because it knows which packet the answers cover. The
     * rest are the states the gate cannot reach: a change with no brief, one nobody has handed
     * over, and the sign-offs that were recorded before there were packets to sign.
     */
    reasonFor(stage, gateReason, code, outcome, packet) {
      const who = (s) => s?.name || s?.principal || 'somebody Rancher did not name';

      if (stage === 'no-brief') {
        return 'No brief, so there is nothing to review this against and nothing to hand over.';
      }

      if (stage === 'not-handed') {
        return 'Never handed over, so nobody has been asked to review it. It is still the author\'s own working tree.';
      }

      if (gateReason) {
        return gateReason;
      }

      const before = packet ? '' : ' It was recorded before this change was handed over.';

      switch (stage) {
      case 'awaiting-outcome':
        return `The code is signed off by ${ who(code) }. The outcome sign-off is still outstanding.${ before }`;
      case 'awaiting-code':
        return `The outcome is signed off by ${ who(outcome) }. The code review is still outstanding.${ before }`;
      case 'changes-requested':
        return `${ who(code?.verdict === 'changes-requested' ? code : outcome) } asked for changes, so the change is back with its author.`;
      case 'same-signer':
        return `Both answers carry ${ who(code) }. The two questions are two sign-offs precisely because one person answering both is one opinion recorded twice.`;
      case 'stale':
        // Two different reasons an answer stops counting, and they send somebody to two
        // different places: one is a change that moved, the other is a record written before
        // sign-offs had to name what they covered.
        return [code, outcome].some((s) => s && !s.sha)
          ? 'A sign-off on record does not name the commit it was given against, so it cannot be read as covering the change as it stands.'
          : 'The branch has moved past the commit those sign-offs were given against, so they are about a different change.';
      case 'open':
        return `Signed off by ${ who(code) } for the code and ${ who(outcome) } for the outcome.${ before }`;
      default:
        return '';
      }
    },

    /**
     * Move the old deferral into the record, once, and read this reviewer's own.
     *
     * `git config --local barn.review.deferred` was the right home for a deferral when there
     * was nowhere better and the wrong home for anything with a person attached, because git
     * config has no idea who set a value. The migration attributes it to whoever first opens
     * the queue after the upgrade, which is a guess, so the record marks it and the chip says
     * so rather than putting somebody's name on it. The config key is unset only once the
     * record has taken it, so a migration that could not run leaves the deferral where it is.
     */
    async deferralFor(name, deferral) {
      if (deferral) {
        const moved = await migrateDeferral(name, deferral).then(() => true).catch(() => false);

        if (moved) {
          await clearDeferral(name).catch(() => null);
        }
      }

      const look = await lastLook(name).catch(() => null);

      return look?.deferred ? look : null;
    },

    deferredLabel(look) {
      if (!look) {
        return '';
      }

      const note = look.note ? ` - ${ look.note }` : '';
      const by = look.migrated
        ? ', before this Studio recorded who defers'
        : `${ look.name ? ` by ${ look.name }` : '' }`;

      return `Deferred ${ this.ago(look.deferred) }${ by }${ note }`;
    },

    /** How long the row has been waiting, and on what clock. */
    waitedOn(row) {
      const at = row.handedAt || row.committedAt;

      return at ? this.ago(new Date(at).toISOString()).replace(/ ago$/, '') : '';
    },

    /**
     * Which of the two questions this row is asking, and of whom.
     *
     * 'blocked'  - there is no brief, so there is nothing to review the change against
     * 'handover' - nobody has been asked anything yet; the next move is its author's
     * 'outcome'  - the code is approved and the outcome is not, so the next answer is screen 13's
     * 'code'     - everything else, which is most rows
     */
    partFor(row) {
      if (!row.intent) {
        return 'blocked';
      }

      if (row.stage === 'not-handed') {
        return 'handover';
      }

      return row.stage === 'awaiting-outcome' ? 'outcome' : 'code';
    },

    /**
     * How much has landed since the code sign-off (36:1108's banner).
     *
     * Counted rather than claimed: the sign-off names the commit it was given against, so the
     * commits above it in the log are the ones that landed after it, and the uncommitted files
     * are counted separately because they are not the same kind of thing. A sign-off whose
     * commit is not in the last fifty entries is reported as "the branch has moved past it",
     * which is what is actually known.
     */
    changesSince(code, history, changes) {
      if (!code || code.verdict !== 'approved' || !code.sha) {
        return null;
      }

      const commits = history.filter((h) => h.kind === 'commit');
      // `sameCommit`, not `===`. `listHistory` reports `%h` and a sign-off stores the full forty
      // characters that `resolveCommit` writes, so a string compare never matched and every real
      // sign-off produced "the branch has moved past the commit you approved" on a clean tree.
      // This is the same abbreviated-versus-full bug that stopped the distribution gate opening;
      // `sameCommit` exists so there is one answer to it rather than one per screen.
      const at = commits.findIndex((h) => sameCommit(h.ref, code.sha));

      if (at === 0 && !changes) {
        return null;
      }

      const clauses = [];

      if (at < 0) {
        clauses.push('the branch has moved past the commit you approved');
      } else if (at > 0) {
        clauses.push(`${ at } commit${ at === 1 ? '' : 's' }`);
      }

      if (changes) {
        clauses.push(`${ changes } uncommitted file${ changes === 1 ? '' : 's' }`);
      }

      if (!clauses.length) {
        return null;
      }

      return {
        text:   clauses.join(' and '),
        when:   (code.at || '').slice(0, 10),
        who:    code.name || code.principal,
        // What "since then" means for this sentence: the commit the approval was given
        // against, which is what the review screen would have to measure from.
        from:   code.sha,
        packet: code.packet || 0,
      };
    },

    /**
     * The row's second-line counts (36:1086): how big the reading is.
     *
     * A row with nothing uncommitted says so rather than printing "0 files · +0 -0", and a
     * brief with no criteria leaves the criteria clause off rather than claiming zero of
     * something it never had.
     */
    sizeOf(files, criteria) {
      const clauses = [];

      if (files.length) {
        const added = files.reduce((n, f) => n + (f.added || 0), 0);
        const removed = files.reduce((n, f) => n + (f.removed || 0), 0);

        clauses.push(`${ files.length } file${ files.length === 1 ? '' : 's' }`);
        clauses.push(`+${ added } -${ removed }`);
      } else {
        clauses.push('nothing uncommitted');
      }

      if (criteria) {
        clauses.push(`${ criteria } acceptance criteri${ criteria === 1 ? 'on' : 'a' }`);
      }

      return clauses.join(' · ');
    },

    /** "8 minutes ago", for the deferral marker's tooltip. */
    ago(iso) {
      const then = Date.parse(iso);

      if (isNaN(then)) {
        return 'at an unknown time';
      }

      const mins = Math.max(0, Math.round((Date.now() - then) / 60000));

      if (mins < 1) {
        return 'just now';
      }

      if (mins < 60) {
        return `${ mins } minute${ mins === 1 ? '' : 's' } ago`;
      }

      const hours = Math.round(mins / 60);

      if (hours < 24) {
        return `${ hours } hour${ hours === 1 ? '' : 's' } ago`;
      }

      const days = Math.round(hours / 24);

      return `${ days } day${ days === 1 ? '' : 's' } ago`;
    },

    riskTone(risk) {
      return {
        high: 'error', medium: 'warning', low: 'success', none: 'default',
      }[risk] || 'default';
    },

    /**
     * The chosen order, over a copy.
     *
     * A row that has never been committed has no timestamp at all, and it goes last whichever
     * way the list is pointing - "unknown" is not older than everything or newer than
     * everything, and putting it at one end or the other depending on the direction would be
     * claiming one of those. Name breaks ties so the order does not shuffle between loads.
     */
    inOrder(rows) {
      const by = this.sort;

      return [...rows].sort((a, b) => {
        if (by === 'most' || by === 'least') {
          const d = (a.changes || 0) - (b.changes || 0);

          return (by === 'most' ? -d : d) || a.name.localeCompare(b.name);
        }

        if (!a.committedAt || !b.committedAt) {
          return (a.committedAt ? 0 : 1) - (b.committedAt ? 0 : 1) || a.name.localeCompare(b.name);
        }

        const d = a.committedAt - b.committedAt;

        return (by === 'newest' ? -d : d) || a.name.localeCompare(b.name);
      });
    },

    /** Reordering is a setting, not a mood: the queue opens the way you last left it. */
    chooseSort(id) {
      this.sort = id;
      this.draft = { ...this.draft, sort: id };
      this.persist();
    },

    persist() {
      writeReviewSettings({ sort: this.sort, signedOffDays: this.signedOffDays });
    },

    openSettings() {
      this.draft = { sort: this.sort, signedOffDays: this.signedOffDays };
      this.showSettings = true;
    },

    saveSettings() {
      const days = parseInt(this.draft.signedOffDays, 10);

      this.sort = this.draft.sort;
      this.signedOffDays = days > 0 ? Math.min(90, days) : DEFAULTS.signedOffDays;
      this.persist();
      this.showSettings = false;
    },

    /**
     * Where a row goes, which is not the same screen for every row.
     *
     * A change with no brief goes to the brief rather than into the diff: the design sends the
     * reviewer to settle the open questions, and a diff read against nothing is the reading
     * this whole screen exists to stop somebody doing. A change whose code is already approved
     * goes to the verification screen, which is the other question and the other person.
     */
    open(row) {
      if (row.part === 'blocked') {
        this.$router.push({ name: BRIEF_ROUTE, params: { extension: row.name } });

        return;
      }

      if (row.part === 'outcome') {
        this.$router.push({ name: VERIFICATION_ROUTE, params: { extension: row.name } });

        return;
      }

      this.$router.push({
        name:   REVIEW_CHANGE_ROUTE,
        params: { extension: row.name, change: 'working' },
      });
    },

    /**
     * 36:1116: open the change with only what has landed since then in it.
     *
     * The same route the row's own action opens, with `scope=since` on it - the review screen's
     * "Since my last look" chip (38:1249) already switched on - and `from`, the commit to
     * measure from.
     *
     * `scope` says narrow it; `from` says from where, and the two are not the same fact. This
     * banner counts from the commit the *approval* was given against (`changesSince` sets
     * `from` to exactly that), while screen 12's own chip counts from the commit the reviewer
     * last *read*. Sending only `scope` would hand the link's promise to a different
     * measurement and quietly show a different diff from the one it offered.
     *
     * It is safe to put in a URL because it is not a copy of a moving answer: an approval names
     * one commit for ever. Screen 12 still refuses it out loud if that commit has left the
     * branch, rather than falling back to the whole change.
     */
    openSince(row) {
      this.$router.push({
        name:   REVIEW_CHANGE_ROUTE,
        params: { extension: row.name, change: 'working' },
        query:  { scope: 'since', from: row.since.from },
      });
    },

    /** The banner's sentence: review.ts's own when it has one, the approval count otherwise. */
    sinceText(since) {
      if (!since.who && !since.when) {
        return since.text;
      }

      const when = since.when ? ` on ${ since.when }` : '';

      return `${ since.text } since ${ since.who || 'somebody' } approved this${ when }.`;
    },

    actionLabel(row) {
      return {
        blocked: 'Open the brief', outcome: 'Sign off',
      }[row.part] || 'Review';
    },
  },
};
</script>

<template>
  <div class="queue">
    <!-- masthead (36:1035) -->
    <div class="queue__masthead">
      <div class="queue__breadcrumb">
        <a class="queue__crumb" @click="$router.push({ name: routes.STUDIO_ROUTE })">Extensions</a>
        <SIcon name="chevronRight" :size="12" />
        <span class="queue__crumb-current">Reviews</span>
      </div>

      <div class="queue__title-row">
        <h1 class="queue__title">
          Reviews
        </h1>
        <span class="queue__grow" />

        <SMenu
          :items="sortOptions"
          aria-label="Sort the queue"
          class="queue__sort"
          @select="chooseSort"
        >
          <template #trigger>
            <SChip :label="sortLabel" icon="filter" />
            <SIcon name="chevronDown" :size="11" />
          </template>
        </SMenu>
        <SButton
          variant="neutral"
          icon="gear"
          data-testid="queue-review-settings"
          @click="openSettings"
        >
          Review settings
        </SButton>
      </div>

      <p class="queue__lede">
        Nothing in this list is live. Everything here is still running only in its author's
        preview, and you are both its author and its only reviewer, so nothing here is waiting
        on anybody else. A change is only a review request once it has been handed over as a
        packet; until then it is its author's own work, and the row says so.
      </p>
    </div>

    <STabs
      v-model="tab"
      :tabs="tabs"
      variant="page"
      class="queue__tabs"
    />

    <!-- list (36:1075) -->
    <div class="queue__list">
      <SEmpty
        v-if="!loading && !shown.length && tab === 'you'"
        icon="check"
        title="Nothing is waiting on you"
        message="Nothing has been handed over for you to review, and nothing of your own is part-way to being handed over. A change arrives here when somebody pushes it for review, or when one of yours has a brief and has not been pushed yet."
      />

      <SEmpty
        v-else-if="!loading && !shown.length && tab === 'others'"
        icon="user"
        title="Nothing is waiting on anybody else"
        :message="me
          ? 'A change appears here once you have answered one of its two questions and it is still not through the gate. The two answers have to come from different people, so answering one half is what puts a change in somebody else\'s queue.'
          : 'Rancher would not say who you are, so this list cannot tell your answers apart from anybody else\'s.'"
      />

      <SEmpty
        v-else-if="!loading && !shown.length"
        icon="clock"
        :title="`Nothing signed off in the last ${ signedOffDays } day${ signedOffDays === 1 ? '' : 's' }`"
        message="A change appears here once both questions have been answered against what was handed over - the code review and the outcome sign-off. A clean working tree is not a sign-off, which is why it no longer counts as one. Review settings changes how far back this reaches."
      />

      <div
        v-for="row in shown"
        :key="row.name"
        class="queue__card"
        @click="open(row)"
      >
        <!--
          36:1108: a row you have already approved once, topped with what has landed since. It
          appears only when there is a recorded approval to count from and something has landed
          since it, so it is never a banner about nothing.
        -->
        <div v-if="row.since" class="queue__since" data-testid="queue-since">
          <SIcon name="undo" :size="14" />
          <span>{{ sinceText(row.since) }}</span>
          <!--
            36:1116. Drawn as a link rather than a button, and it is one: it opens the same
            change the row opens, with the review screen's "Since my last look" scope already
            applied instead of the whole change.
          -->
          <a
            v-if="row.since.from"
            class="queue__since-link"
            data-testid="queue-since-filter"
            @click.stop="openSince(row)"
          >Show only what changed since then</a>
          <span v-else class="queue__since-note">
            Nothing records the point to measure from, so this cannot be narrowed.
          </span>
        </div>

        <div class="queue__card-body">
          <div class="queue__main">
            <!-- what the change is for, first (36:1079) -->
            <div v-if="row.intent" class="queue__row-title">
              {{ row.intent }}
            </div>
            <div v-else class="queue__row-title queue__no-brief">
              <SIcon name="alert" :size="15" />
              No brief - nobody wrote down what this is for.
            </div>

            <!-- then which extension it is (36:1084) and how big the reading is (36:1086) -->
            <div class="queue__ident">
              {{ row.name }}<span v-if="row.version"> · v{{ row.version }}</span><span
                v-if="row.packet"
              > · packet {{ row.packet }}</span>
            </div>

            <div class="queue__size">
              {{ row.size || '…' }}
            </div>

            <!--
              Whether anybody has been asked anything about this change, and if so what is
              outstanding. It is the sentence the gate itself wrote, so the queue and the
              publish screen cannot end up saying two different things about one change.
            -->
            <div v-if="row.reason" class="queue__state" data-testid="queue-state">
              <span v-if="row.handover" class="queue__handover">{{ row.handover }}</span>
              {{ row.reason }}
            </div>
          </div>

          <!--
            36:1093: how long it has been waiting. The duration is real - it is the age of the
            last commit, which is what this cluster records - and the person the design puts
            beside it is not, so the line under it says that rather than inventing a name.
          -->
          <div class="queue__col queue__col--waiting">
            <span class="queue__label">Waiting</span>
            <span class="queue__value" data-testid="queue-waiting">{{ row.waited || 'never committed' }}</span>
            <span class="queue__reason" data-testid="queue-asked">{{
              row.asked ? `asked for by ${ row.asked }` : 'nothing records who asked for this'
            }}</span>
          </div>

          <div class="queue__col queue__col--risk">
            <span class="queue__label">Risk</span>
            <SChip :label="row.risk" :tone="riskTone(row.risk)" />
            <span class="queue__reason">{{ row.riskReason }}</span>
          </div>

          <div class="queue__col queue__col--who">
            <span class="queue__label">Branch</span>
            <span class="queue__value">{{ row.branch || '-' }}</span>
          </div>

          <div class="queue__action">
            <SChip
              v-if="row.deferred"
              label="Deferred"
              icon="clock"
              tone="warning"
              :title="row.deferredLabel"
            />
            <!--
              36:1195 / 36:1162. Only on the rows that are not the ordinary case: a chip that
              says the same thing on every row is not a readout, which is why there is no "Your
              part" column here any more.
            -->
            <SChip
              v-if="row.part === 'blocked'"
              label="Blocked"
              icon="lock"
              tone="warning"
              title="There is no brief, so there is nothing to review this against"
            />
            <!--
              The distinction this queue exists to draw: a change nobody has handed over is not
              a review request, however much of it there is. It is still listed, because the
              next move on it is real, and it is labelled rather than counted as somebody's
              review.
            -->
            <SChip
              v-else-if="row.part === 'handover'"
              label="Not handed over"
              icon="upload"
              tone="subtle"
              data-testid="queue-not-handed"
              :title="row.reason"
            />
            <SChip
              v-else-if="row.part === 'outcome'"
              label="Outcome sign-off"
              icon="eye"
              tone="info"
              title="The code is approved. What is left is whether it did the job."
            />
            <SBadge :status="row.changes ? 'unsaved' : 'live'" />
            <SButton
              :variant="row.part === 'outcome' ? 'primary' : 'secondary'"
              size="sm"
              :data-testid="`queue-review-${ row.name }`"
              @click.stop="open(row)"
            >
              {{ actionLabel(row) }}
            </SButton>
          </div>
        </div>
      </div>

      <!-- foot note (36:1218) -->
      <div class="queue__footnote">
        <SIcon name="sparkle" :size="15" />
        <p class="queue__footnote-text">
          Rows lead with what the change is for, taken from its brief - not with a file count. A
          change with no brief says so, which is the point: a reviewer should never have to
          reverse-engineer intent from a diff.
        </p>
      </div>
    </div>

    <!--
      Review settings (36:1050). Two settings, both of which change what this screen shows and
      both of which survive a reload. The note says what is not configurable rather than
      leaving somebody hunting for it.
    -->
    <SModal
      v-if="showSettings"
      title="Review settings"
      icon="gear"
      :width="520"
      @close="showSettings = false"
    >
      <div class="queue__settings">
        <div class="queue__setting">
          <span class="queue__label">Order the queue by</span>
          <SMenu
            :items="draftSortOptions"
            aria-label="Default order for the queue"
            align="left"
            class="queue__sort"
            @select="draft = { ...draft, sort: $event }"
          >
            <template #trigger>
              <SChip :label="draftSortLabel" icon="filter" />
              <SIcon name="chevronDown" :size="11" />
            </template>
          </SMenu>
        </div>

        <SField
          :model-value="draft.signedOffDays"
          label="Count as signed off for"
          type="number"
          hint="Days. A change whose two sign-offs both landed inside this window shows in the third tab."
          data-testid="queue-signed-off-days"
          @update:model-value="draft = { ...draft, signedOffDays: $event }"
        />

        <p class="queue__settings-note">
          There is nothing here about who reviews what. This product has one reviewer - you -
          and a setting that could only ever have one value would be a control that lies.
        </p>
      </div>

      <template #footer>
        <SButton variant="ghost" @click="showSettings = false">
          Cancel
        </SButton>
        <SButton variant="primary" data-testid="queue-settings-save" @click="saveSettings">
          Save
        </SButton>
      </template>
    </SModal>
  </div>
</template>

<style lang="scss" scoped>
.queue {
  display:        flex;
  flex-direction: column;
  height:         100%;
  overflow-y:     auto;
  background:     var(--studio-surface);

  &__masthead {
    display:        flex;
    flex-direction: column;
    gap:            6px;
    padding:        var(--studio-space-20) var(--studio-space-24) 0;
  }

  &__breadcrumb {
    display:     flex;
    align-items: center;
    gap:         6px;
    color:       var(--studio-text-tertiary);
  }

  &__crumb {
    font:   var(--studio-caption-12);
    color:  var(--studio-text-link);
    cursor: pointer;

    &:hover { text-decoration: underline; }
  }

  &__crumb-current { font: var(--studio-caption-12); color: var(--studio-text-secondary); }

  &__title-row {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-12);
  }

  &__title {
    font:           var(--studio-heading-24);
    letter-spacing: var(--studio-tracking-heading);
    color:          var(--studio-text);
    margin:         0;
  }

  &__grow { flex: 1 1 auto; }

  // The chip is the trigger, so the button around it gives back its own padding and lets the
  // chip's own box be the control - otherwise the drawn chip sits inside a second, larger one.
  &__sort {
    :deep(.s-menu__trigger) {
      padding: 0 var(--studio-space-4) 0 0;
      gap:     var(--studio-space-4);
    }
  }

  &__lede {
    font:   var(--studio-body-14);
    color:  var(--studio-text-secondary);
    margin: 0;
  }

  &__list {
    display:        flex;
    flex-direction: column;
    gap:            10px;
    padding:        var(--studio-space-16) var(--studio-space-24) var(--studio-space-24);
  }

  &__card {
    background:    var(--studio-surface);
    border:        1px solid var(--studio-border);
    border-radius: var(--studio-radius);
    cursor:        pointer;

    &:hover { border-color: var(--studio-border-strong); }
  }

  &__card-body {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-16);
    padding:     14px 18px;
  }

  &__main {
    display:        flex;
    flex-direction: column;
    gap:            5px;
    flex:           1 1 auto;
    min-width:      0;
  }

  // The purpose sentence is the row's lede (36:1079), so it carries the row's weight. The name
  // is identification and sits under it - which is the way round the design draws it, and the
  // opposite of what this rendered.
  &__row-title {
    font:  var(--studio-heading-16);
    color: var(--studio-text);
  }

  &__ident {
    font:  var(--studio-body-13);
    color: var(--studio-text-secondary);
  }

  &__size {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  // Who has been asked what. Set below the size line and in the same caption, because it is a
  // reading about the row rather than a claim the row is making.
  &__state {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  &__handover {
    font:  var(--studio-caption-12-semi);
    color: var(--studio-text-secondary);
  }

  // A row with no brief has nothing to lead with, so the missing brief leads instead - at the
  // lede's own size, because it is the most important thing about the row.
  &__no-brief {
    display:     flex;
    align-items: center;
    gap:         6px;
    color:       var(--studio-warning);
  }

  &__col {
    display:        flex;
    flex-direction: column;
    align-items:    flex-start;
    // The columns share one baseline for their caps labels, which centring each column in the
    // row cannot give: the risk pill is taller than the text the other one carries, so a
    // centred RISK column sits its label above the other.
    align-self:     flex-start;
    gap:            5px;
    flex:           0 0 auto;

    &--risk    { width: 200px; }
    &--who     { width: 110px; gap: var(--studio-space-4); }
    &--waiting { width: 150px; }

    // The risk pill hugs its label (36:1096). Left to stretch it became a green band across
    // the column, and the extra height pushed the column's caps label off the baseline it
    // shares with BRANCH.
    :deep(.s-chip) { padding: 3px var(--studio-space-8); }
  }

  &__label {
    font:           var(--studio-caption-11-caps);
    letter-spacing: var(--studio-tracking-caps);
    text-transform: uppercase;
    color:          var(--studio-text-tertiary);
  }

  &__value {
    font:  var(--studio-caption-12);
    color: var(--studio-text-secondary);
  }

  // The rating on its own says how much attention to give the row; this says what it read to
  // get there, which is the half a reviewer can argue with.
  &__reason {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  &__action {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
    flex:        0 0 auto;
  }

  /*
   * 36:1108: what has landed since you approved this. Tinted and above the row rather than in
   * it, because it is about the row's history rather than about the change - and it is the one
   * thing on the card that is addressed to you personally.
   */
  &__since {
    display:       flex;
    align-items:   center;
    flex-wrap:     wrap;
    gap:           var(--studio-space-8);
    padding:       var(--studio-space-8) 18px;
    border-bottom: 1px solid var(--studio-border-subtle);
    border-radius: var(--studio-radius) var(--studio-radius) 0 0;
    background:    var(--studio-info-bg);
    font:          var(--studio-caption-12);
    color:         var(--studio-text);
  }

  &__since-note {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  // 36:1116: blue semibold caption, so a link and not a button.
  &__since-link {
    font:   var(--studio-caption-12-semi);
    color:  var(--studio-text-link);
    cursor: pointer;

    &:hover { text-decoration: underline; }
  }

  &__settings {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-16);
  }

  &__setting {
    display:        flex;
    flex-direction: column;
    align-items:    flex-start;
    gap:            var(--studio-space-8);
  }

  &__settings-note {
    font:   var(--studio-caption-12);
    color:  var(--studio-text-tertiary);
    margin: 0;
  }

  &__footnote {
    display:       flex;
    gap:           10px;
    padding:       11px 14px;
    background:    var(--studio-surface-subtle);
    border:        1px solid var(--studio-border);
    border-radius: var(--studio-radius);
    color:         var(--studio-info);
  }

  &__footnote-text {
    flex:   1 1 auto;
    font:   var(--studio-caption-12);
    color:  var(--studio-text-secondary);
    margin: 0;
  }
}
</style>
