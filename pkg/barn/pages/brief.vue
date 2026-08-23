<script>
// Screen 10 · The brief - what are we actually trying to do? (Figma node 34:894).
//
// The step between describing an extension and building it. Two columns: the brief itself on
// the left, and on the right what the assistant cannot decide and what already exists.
//
// Real. Everything you can type. The brief is a form, and agreeing it writes BRIEF.md into the
// extension's package in the pod and sends it to the claude in that pod as its first
// instruction - so the brief is not a ceremony, it is the prompt. Skip the brief goes straight
// to the workspace.
//
// Real, and both on the right. "What the assistant cannot decide" hands the brief as it stands
// to the claude in this extension's pod and asks it what it cannot decide from it; the answer
// arrives in that conversation, in the workspace's terminal, which the card says in as many
// words rather than leaving a person watching this page for a list that will never appear here.
// "This already exists, partly" greps the source of every extension in this Studio for the
// terms in the brief's own title and problem, and reports the file and line of each hit - or
// says plainly that there were none, which is a finding rather than an empty state.
//
// Gone. The masthead's "Send questions to the requester", and the per-question "Ask the
// requester" beside it. There is now a requester - screen 02 records whoever created the
// extension under `## Who asked`, and this screen names them on the first card - but there is
// still nothing to send with. Rancher has no messaging between users, this Studio has no
// ticket system to comment on, and a button that names a person it cannot reach is worse than
// no button, not better. So the requester is shown and the send is still absent.
//
// Read, not written, here. `## Who asked` and `## The challenge` are both quoted by this
// screen and owned by something else - the first by screen 02 at creation, the second by the
// assistant in the pod. Neither is in `ownedSections`, which is what keeps `briefDocument`
// copying them through untouched on every autosave.
//
// Here instead. The open questions the design draws as cards (34:1090 and the two under it) are
// a real list, kept in BRIEF.md under `## Open questions`, marked Blocking or Worth asking, and
// answerable in place. Two things write them: you, and the assistant - "Ask what is unclear"
// tells the claude in this extension's pod to write what it cannot decide into that section of
// this file, which is a thing it can actually do, unlike sending a message to a person this
// product has never heard of. Reading them back is a button, because the pod writes the file
// when it gets round to it rather than when this page would like it to.
//
// The callout the design has arguing with the request (34:1012) asks for the argument instead
// of asserting one. Nothing in this Studio can weigh a request against a problem statement, so
// the button hands both to the assistant in this extension's pod and asks it to write what it
// makes of them into `## The challenge` in BRIEF.md; when that section exists, the callout is
// what it says. That is also the one thing in the product that reads screen 02's two fields
// against each other, which is what the second field was added for.
//
// The second line the design draws under every question card - the rationale, the evidence,
// the risk - is one optional field, `why`, written under the question in BRIEF.md as an
// indented `Why:` line. Three moods of the same sentence, so one field; optional, because its
// only two honest writers are the person and the assistant, and an empty line under every
// question would be the card claiming a reason nobody gave it.
//
// Prior art, likewise, stops at a finding and now goes one step further: a hit opens in the
// Files screen of the extension it was found in, and "Reuse this" records the decision in the
// brief, which is the document the assistant is handed. The design's two named entries (the
// cluster dashboard, longhorn-capacity) stay unimplemented and the reason is in the return
// message: nothing here can search Rancher's own pages, and neither entry's editorial half -
// what it does and does not cover - has a source.
import {
  SButton, SChip, SIcon, SBanner, SField, SLabel, SMenu
} from '../components/ui';
import { toastSuccess, toastError } from '../toast';
import {
  readExtensionFile, writeExtensionFile, askAssistant, findPriorArt, DEFAULT_EXTENSION
} from '../extensions';
import { EDITOR_ROUTE, STUDIO_ROUTE, FILES_ROUTE } from '../editor-product';
import '../design/tokens';
import fullBleed from '../design/full-bleed';

/**
 * Who the extension is written for (34:1036 and the three beside it).
 *
 * Multi-select, not a radio group: the design draws two of the four with a tick. It is written
 * into the brief because the audience decides half the interface - what a support engineer
 * needs on a page and what a platform admin needs are different pages - and the assistant reads
 * the brief before it writes any of it.
 */
const ROLES = ['Cluster operator', 'Support engineer', 'Platform admin', 'App developer'];

/** The two severities the design distinguishes (34:1090 Blocking, 34:1106 Worth asking). */
const BLOCKING = 'Blocking';
const WORTH_ASKING = 'Worth asking';

/**
 * Words that match everything, so they find nothing.
 *
 * The commonest English on top of the vocabulary this form's own placeholders put in people's
 * heads - "should", "cannot", "rancher", "extension", "cluster" - which appear in every package
 * in the namespace and would make every search return the same eight lines of somebody else's
 * boilerplate.
 */
const STOP_WORDS = new Set([
  'that', 'this', 'with', 'from', 'they', 'them', 'have', 'been', 'when', 'what', 'which',
  'their', 'there', 'would', 'could', 'should', 'cannot', 'about', 'into', 'only', 'more',
  'than', 'then', 'some', 'each', 'other', 'because', 'without', 'every', 'where', 'while',
  'rancher', 'extension', 'extensions', 'cluster', 'clusters', 'dashboard', 'page', 'pages',
  'user', 'users', 'need', 'needs', 'wants', 'today', 'thing', 'things',
]);

export default {
  name: 'BarnBrief',

  components: {
    SButton, SChip, SIcon, SBanner, SField, SLabel, SMenu
  },

  mixins: [fullBleed],

  data() {
    return {
      // The request as it arrived, quoted rather than edited: it is a record of what was asked
      // for, and the point of the card is that it does not change while the brief does.
      request:  '',
      problem:  '',
      who:      '',
      changes:  '',
      notDoing: '',
      criteria: ['', '', ''],
      // Who it is for (34:1030). Multi-select, in BRIEF.md, read back on the way in.
      roles:    [],
      // The open questions (34:1085). `{ severity, text, why, answer }`, in BRIEF.md. A
      // question with an answer is settled and stops counting against the card's badge.
      //
      // `why` is the second line the design draws under every question - the rationale on the
      // blocking card, the evidence on the first "Worth asking" one, the risk on the second.
      // One field for all three, because they are the same sentence in three moods: why this
      // cannot just be guessed. It is optional, has the same two writers as the question text
      // itself, and is absent rather than invented when neither of them wrote one.
      questions: [],
      // Which question has its answer box open, by index, or -1. Only one at a time: the box
      // is a text field the width of the card and two of them is a form nobody asked for.
      answeringAt: -1,
      draftAnswer: '',
      // The same, for the `why` line. Separate index so opening one does not close the other.
      whyAt:    -1,
      draftWhy: '',
      newQuestion: '',
      // Prior art this brief has decided to reuse. `{ extension, where }` - the file and line
      // the search found, which is enough for a person to go and read it and enough for the
      // assistant to be told to.
      reuse:    [],
      saving:   false,
      // True until BRIEF.md has been read. Agreeing writes the whole form over that
      // file, so agreeing before it has been read back would replace it with a form
      // that never contained it.
      loading:  true,
      // The file as it was last read or written, which every save is merged into rather than
      // replacing. Sections this form does not own - the verification block screen 13 writes,
      // anything a person added by hand - live in here and nowhere else.
      original: '',
      // Whether BRIEF.md was there to be read. The difference between "saved" and "nothing
      // written yet", which the masthead has to be able to say.
      exists:   false,
      // The date somebody pressed Agree, read back out of the file. Empty means nobody has,
      // which is the only thing that makes this a draft.
      agreedOn: '',
      // Which criteria were ticked in the file. Screen 13 owns the ticks; this form must not
      // untick one just because it rewrote the line around it.
      ticked:   new Set(),
      // The autosave. Separate from `saving`, which is the Agree button's own spinner.
      ready:      false,
      dirty:      false,
      autosaving: false,
      savedAt:    null,
      saveError:  '',
      saveTimer:  null,
      asking:   false,
      rereading: false,
      // '' until the question has been put to the pod; then what happened to it, so the card
      // can say where the answer is rather than looking like nothing happened.
      asked:    '',
      searching: false,
      // null is "nobody has looked yet", [] is "looked, found nothing" - and those are
      // different sentences.
      priorArt: null,
      priorArtError: '',
      // Whether BRIEF.md already carries a `## Where it appears` section. See ownedSections.
      seededPlacement: false,
      // Who the brief records as having asked for this, read out of `## Who asked` - the
      // section screen 02 writes at creation and `review.ts` gates the outcome sign-off on.
      // Read, never written, here: this form does not own it and must copy it through.
      // null is "the section is not in the file", which is a real answer and the one every
      // extension made before that section existed gives.
      askedBy: null,
      // `## The challenge`, written into the brief by the assistant when somebody asks it to
      // argue with the request. Read-only here for the same reason.
      challenge: '',
      arguing:   false,
      argued:    '',
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

    /** What screen 02 was told, carried here in the query rather than in a store. */
    handed() {
      return this.$route.query.prompt || '';
    },

    outcome() {
      return this.$route.query.outcome || '';
    },

    placement() {
      return this.$route.query.placement || '';
    },

    filledCriteria() {
      return this.criteria.map((c) => c.trim()).filter(Boolean);
    },

    /** Everything the form owns, as one value, so one watcher can see any edit to any of it. */
    formKey() {
      return JSON.stringify([
        this.request, this.problem, this.who, this.changes, this.notDoing, this.criteria,
        this.roles, this.questions, this.reuse,
      ]);
    },

    roleOptions() {
      return ROLES;
    },

    /**
     * The questions nobody has answered yet, blocking ones first.
     *
     * The order is the design's argument rather than decoration: "separating blocking from
     * merely useful" is the whole point of the severity, and a blocking question below two
     * curiosities is a blocking question nobody reads.
     */
    openQuestions() {
      return this.questions
        .map((q, i) => ({ ...q, index: i }))
        .filter((q) => !q.answer.trim())
        .sort((a, b) => (a.severity === BLOCKING ? 0 : 1) - (b.severity === BLOCKING ? 0 : 1));
    },

    answeredQuestions() {
      return this.questions.map((q, i) => ({ ...q, index: i })).filter((q) => !!q.answer.trim());
    },

    /** What the card's badge says. Live, off the list, not a number typed into a template. */
    openCount() {
      return this.openQuestions.length;
    },

    blockingCount() {
      return this.openQuestions.filter((q) => q.severity === BLOCKING).length;
    },

    reuseKeys() {
      return new Set(this.reuse.map((r) => `${ r.extension } ${ r.where }`));
    },

    /**
     * How long ago the request was made, from the date in `## Who asked`.
     *
     * The design's ticket line ends "4 days ago", and this is the one third of it that has a
     * source. Days rather than hours because the section records a date and nothing finer, and
     * a screen that says "6 hours ago" off a date is guessing at the clock.
     */
    askedAge() {
      const on = this.askedBy?.on;

      if (!on) {
        return '';
      }

      const then = Date.parse(`${ on }T00:00:00`);

      if (Number.isNaN(then)) {
        return '';
      }

      const today = new Date();
      const days = Math.round((Date.parse(
        `${ today.toISOString().slice(0, 10) }T00:00:00`
      ) - then) / 86400000);

      if (days <= 0) {
        return 'today';
      }

      return days === 1 ? 'yesterday' : `${ days } days ago`;
    },

    canAgree() {
      return !!this.problem.trim() && !this.saving && !this.loading;
    },

    /**
     * What the chip says about the brief, from the file rather than from the template.
     *
     * It was the literal "Draft - not yet agreed", which was false the moment anybody agreed
     * one - and once the form started loading the file it was visibly false, because the screen
     * would show an agreed brief while the chip called it a draft. Agreement is recorded in the
     * document itself, so it survives a reload and is readable by anyone who opens the file.
     */
    status() {
      if (this.agreedOn) {
        return { label: `Agreed ${ this.agreedOn }`, icon: 'check', tone: 'success' };
      }

      return { label: 'Draft - not yet agreed', icon: 'clock', tone: 'warning' };
    },

    /**
     * Where the typing has got to, said plainly.
     *
     * Every edit here is written into BRIEF.md, so the screen has to say when that last
     * happened. A form that saves silently and a form that does not save at all look identical
     * until you reload one of them.
     */
    savedNote() {
      if (this.loading) {
        return 'Reading BRIEF.md';
      }

      if (this.saveError) {
        return `Not saved: ${ this.saveError }`;
      }

      if (this.autosaving) {
        return 'Saving';
      }

      if (this.dirty) {
        return 'Unsaved';
      }

      if (this.savedAt) {
        return `Saved ${ this.savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }`;
      }

      return this.exists ? 'Saved in BRIEF.md' : 'Nothing written yet';
    },

    /**
     * What to search the other extensions for.
     *
     * The brief's own vocabulary: the extension's name and the words of the problem statement,
     * which is the sentence that says what this is for. Words of four letters or more, because
     * the search is a fixed-string grep and "the" matches everything; the commonest English and
     * brief-template words on top of that, because "should" and "cannot" match everything too.
     *
     * Longest first, then capped: a grep for six terms across every pod is six chances to match
     * something irrelevant, and the longest words in a sentence are the ones that carry it.
     */
    priorArtTerms() {
      const seen = new Set();

      return `${ this.extension } ${ this.problem }`
        .toLowerCase()
        .match(/[a-z][a-z0-9-]{3,}/g)
        ?.filter((w) => !STOP_WORDS.has(w) && !seen.has(w) && seen.add(w))
        .sort((a, b) => b.length - a.length)
        .slice(0, 5) || [];
    },

    /** The hits under a heading per extension, which is the unit a person would go and look at. */
    priorArtGroups() {
      const groups = new Map();

      (this.priorArt || []).forEach((hit) => {
        groups.set(hit.extension, [...(groups.get(hit.extension) || []), hit]);
      });

      return [...groups.entries()].map(([extension, hits]) => ({ extension, hits }));
    },
  },

  watch: {
    // Any edit to anything the form owns. Armed only once the file has been read, so the
    // prefill below and the load itself are not mistaken for typing and written straight back.
    formKey() {
      if (this.ready) {
        this.queueSave();
      }
    },
  },

  mounted() {
    // Prefill from what screen 02 collected. These are the person's own words moved into the
    // right boxes, not the assistant's guess at them - which is why they are editable and why
    // nothing is invented for the boxes there is no answer for.
    this.request = this.handed;
    this.problem = this.outcome || this.handed;
    this.changes = this.handed;

    this.load().catch(() => {
      this.loading = false;
      this.ready = true;
    });
  },

  beforeUnmount() {
    clearTimeout(this.saveTimer);

    // Leaving the screen with typing in it is the case this has to cover: the debounce has not
    // fired yet and there is no other write path. Not awaited, because unmounting cannot wait.
    if (this.dirty && !this.saving) {
      this.saveDraft();
    }
  },

  methods: {
    /**
     * Read the brief that already exists, if one does.
     *
     * Agreeing writes the whole form over BRIEF.md, and until this existed the form was never
     * filled from that file - only from the query parameters screen 02 hands over at creation.
     * So opening the brief of an extension that already had one showed a form that did not
     * contain it, and agreeing replaced the document with the form. What went with it was not
     * just prose: the criteria under "How we will know it worked" are the same items screen 12
     * renders and screen 13 records verdicts against, so one click dropped the criteria, every
     * verdict recorded against them, and the review packet's link to what was promised.
     *
     * An extension that has no BRIEF.md yet is the normal case on the way in from screen 02, and
     * for that the query prefill already in place is right. So a missing file is not an error
     * here, and neither is one this parser cannot make sense of: in both cases the form keeps
     * what it has rather than blanking itself.
     */
    async load() {
      const text = await readExtensionFile(this.extension, 'BRIEF.md').catch(() => '');

      if (text.trim()) {
        const sections = this.parseBrief(text);

        // Only overwrite a box the file actually spoke about. A brief written before a section
        // existed should not blank the box for it.
        ['request', 'problem', 'who', 'changes', 'notDoing'].forEach((key) => {
          if (sections[key] !== undefined) {
            this[key] = sections[key];
          }
        });

        if (sections.criteria?.length) {
          this.criteria = sections.criteria;
          this.ticked = new Set(sections.criteria.filter((_, i) => sections.criteriaTicked[i]));
        }

        // These three are lists, and an empty one is a real answer - the questions were all
        // settled, nothing is being reused - so they are taken whenever the file had the
        // section at all, rather than only when it had something in it.
        if (sections.roles) {
          this.roles = sections.roles;
        }

        if (sections.questions) {
          this.questions = sections.questions;
        }

        if (sections.reuse) {
          this.reuse = sections.reuse;
        }

        this.original = text;
        this.exists = true;
        this.agreedOn = sections.agreedOn || '';
        this.seededPlacement = /^##\s+Where it appears\s*$/mi.test(text);
        // Read out of the file rather than through `parseBrief`, deliberately. `parseBrief` is
        // the list of what this form owns and `briefDocument` writes back everything on it, so
        // adding either of these there would make the form the author of a section it only
        // quotes - and the next save would flatten what the assistant or screen 02 wrote.
        this.askedBy = this.parseAsked(this.readSection(text, 'Who asked'));
        this.challenge = this.readSection(text, 'The challenge');
      }

      this.loading = false;
      // A tick later, so the assignments above have all settled before the watcher counts
      // anything as typing.
      this.$nextTick(() => {
        this.ready = true;
      });
    },

    /**
     * Turn the markdown `briefDocument` writes back into the form that wrote it.
     *
     * Keyed on the headings that method emits, so the two stay together: change one and this
     * stops finding a section rather than silently reading the wrong one. `_not stated_` is what
     * it writes for a box left empty, so it reads back as empty rather than as that literal.
     */
    parseBrief(text) {
      // Lower case, and matched lower case, because `briefDocument` decides what it owns the
      // same way. A heading the two halves disagree about is a section read by neither and
      // overwritten by one of them.
      const HEADINGS = {
        '## what you were handed':               'request',
        '## the problem':                        'problem',
        '## who has it':                         'who',
        '## what changes for them':              'changes',
        '## what we are deliberately not doing': 'notDoing',
      };

      const out = {};
      let key = null;
      let buffer = [];

      // Who agreed this, and when, as `agree()` records it in the footer. Its absence is what
      // makes a brief a draft, so it is read from the whole document rather than from a
      // section a rewrite could move.
      const agreed = /^_Agreed in the Extension Studio on ([0-9]{4}-[0-9]{2}-[0-9]{2})\._$/m.exec(text);

      if (agreed) {
        out.agreedOn = agreed[1];
      }

      // The sections that are a list rather than a paragraph. Each is accumulated item by item
      // into an array below, so `flush` must leave them alone: replacing one with the prose
      // buffer would read a full section back as empty. That is not hypothetical - the first
      // version of this parser did exactly that to `criteria` when it reached the
      // `## Verification` section screen 13 appends, and read four real criteria back as none,
      // which agreeing would then have written over them as `_not stated_`.
      const LISTS = {
        '## how we will know it worked':   'criteria',
        '## written for':                  'roles',
        '## open questions':               'questions',
        '## prior art we are reusing':     'reuse',
      };

      const LIST_KEYS = new Set(Object.values(LISTS));

      const flush = () => {
        if (!key || LIST_KEYS.has(key)) {
          return;
        }
        const body = buffer.join('\n').trim();

        out[key] = body === '_not stated_' ? '' : body;
      };

      for (const raw of text.split('\n')) {
        const line = raw.replace(/\s+$/, '');

        if (line.startsWith('## ') || line === '---') {
          flush();
          key = HEADINGS[line.toLowerCase()] || null;
          buffer = [];

          const list = LISTS[line.toLowerCase()];

          if (list) {
            key = list;
            out[list] = [];

            if (list === 'criteria') {
              // Whether each box is ticked, parallel to `criteria`. Screen 13 owns the tick, so
              // this form has to be able to put it back on the line it rewrites.
              out.criteriaTicked = [];
            }
          }
          continue;
        }

        if (key === 'criteria') {
          // The verdicts screen 13 records live on these same lines, as trailing bold text after
          // the criterion. Keep only the criterion itself, which is what this form owns.
          const m = line.match(/^- \[([ xX])\]\s+(.*)$/);

          if (m) {
            out.criteria.push(m[2].replace(/\s*-\s*\*\*.*$/, '').trim());
            out.criteriaTicked.push(m[1] !== ' ');
          }
          continue;
        }

        if (key === 'roles') {
          const m = line.match(/^-\s+(.*\S)\s*$/);

          if (m && ROLES.includes(m[1])) {
            out.roles.push(m[1]);
          }
          continue;
        }

        if (key === 'questions') {
          // `- **Blocking** what happens when metrics-server is missing?`, and the answer, if
          // there is one, indented under it. Deliberately the shape a person would write by
          // hand, because a person and the assistant in the pod are the two things that write
          // this section and neither of them is this form.
          const q = line.match(/^-\s+\*\*(Blocking|Worth asking)\*\*\s+(.*\S)\s*$/i);

          if (q) {
            out.questions.push({
              severity: /^blocking$/i.test(q[1]) ? BLOCKING : WORTH_ASKING,
              text:     q[2],
              why:      '',
              answer:   '',
            });
            continue;
          }

          // `  Why: ` and `  Answer: `, both indented under the question they belong to. Two
          // continuation lines rather than one longer question line, because the question is
          // what gets asked and the why is what gets weighed, and a reader of the file should
          // be able to skim the questions without reading the reasoning under each one.
          const w = line.match(/^\s{2,}Why:\s*(.*\S)\s*$/);

          if (w && out.questions.length) {
            const last = out.questions[out.questions.length - 1];

            last.why = last.why ? `${ last.why } ${ w[1] }` : w[1];
            continue;
          }

          const a = line.match(/^\s{2,}Answer:\s*(.*\S)\s*$/);

          if (a && out.questions.length) {
            const last = out.questions[out.questions.length - 1];

            last.answer = last.answer ? `${ last.answer } ${ a[1] }` : a[1];
          }
          continue;
        }

        if (key === 'reuse') {
          const m = line.match(/^-\s+(\S+)\s+(\S+)\s*$/);

          if (m) {
            out.reuse.push({ extension: m[1], where: m[2] });
          }
          continue;
        }

        if (key) {
          buffer.push(line);
        }
      }
      flush();

      return out;
    },

    /**
     * The body of one `##` section, verbatim, for the sections this form quotes but does not own.
     *
     * Walked to the next heading rather than matched with a regex that has to express "up to
     * the next ## or the end of the file", which is the same loop `review.ts`'s `whoAsked`
     * uses on this same file for this same reason.
     */
    readSection(text, title) {
      const lines = (text || '').split('\n');
      const head = new RegExp(`^##\\s+${ title }\\s*$`, 'i');
      const start = lines.findIndex((line) => head.test(line.trim()));

      if (start < 0) {
        return '';
      }

      const body = [];

      for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
        body.push(lines[i]);
      }

      return body.join('\n').trim();
    },

    /**
     * `## Who asked` as the card needs it: a principal, a name and a date.
     *
     * The principal is found the same way `review.ts` finds it - the first `scheme://...` run
     * of non-space characters - so this screen can never name somebody the sign-off gate would
     * not accept. The name and the date are the rest of the line screen 02 writes and are
     * allowed to be missing: a brief is a file a person can edit, and a hand-written principal
     * on its own is still a recorded requester.
     */
    parseAsked(body) {
      const principal = (/([a-z][\w-]*:\/\/\S+)/.exec(body || '')?.[1] || '').trim();

      if (!principal) {
        return null;
      }

      const line = (body.split('\n').find((l) => l.includes(principal)) || '').trim();
      const rest = /^\S+\s+-\s+(?:(.*?),\s+)?on\s+(\d{4}-\d{2}-\d{2})\./.exec(line);

      return { principal, name: rest?.[1] || '', on: rest?.[2] || '' };
    },

    addCriterion() {
      this.criteria.push('');
    },

    removeCriterion(i) {
      this.criteria.splice(i, 1);
    },

    /**
     * The per-criterion menu (34:1057 and the three under it).
     *
     * Reorder is the reason it exists. Delete was already a button and editing is the row
     * itself, but the order of the criteria is the order screen 13 walks them in and there was
     * no way to change it - so a criterion typed in the wrong place stayed there.
     */
    criterionMenu(i) {
      return [
        {
          id: 'up', label: 'Move up', icon: 'chevronUp', disabled: i === 0,
        },
        {
          id:       'down',
          label:    'Move down',
          icon:     'chevronDown',
          disabled: i === this.criteria.length - 1,
        },
        { divider: true },
        {
          id:       'remove',
          label:    'Delete this criterion',
          icon:     'trash',
          danger:   true,
          disabled: this.criteria.length < 2,
        },
      ];
    },

    onCriterion(i, id) {
      if (id === 'remove') {
        this.removeCriterion(i);

        return;
      }

      const to = id === 'up' ? i - 1 : i + 1;

      if (to < 0 || to >= this.criteria.length) {
        return;
      }

      const moved = this.criteria.slice();

      [moved[i], moved[to]] = [moved[to], moved[i]];
      this.criteria = moved;
    },

    toggleRole(role) {
      this.roles = this.roles.includes(role)
        ? this.roles.filter((each) => each !== role)
        : [...this.roles, role];
    },

    addQuestion() {
      const text = this.newQuestion.trim();

      if (!text) {
        return;
      }

      // New questions arrive as "Worth asking". Calling somebody else's question blocking on
      // their behalf is the one thing this list should not do for them, and the chip on the
      // card changes it in one click.
      this.questions = [...this.questions, {
        severity: WORTH_ASKING, text, why: '', answer: '',
      }];
      this.newQuestion = '';
    },

    toggleSeverity(index) {
      this.questions = this.questions.map((q, i) => (i === index
        ? { ...q, severity: q.severity === BLOCKING ? WORTH_ASKING : BLOCKING }
        : q));
    },

    removeQuestion(index) {
      this.questions = this.questions.filter((_, i) => i !== index);

      if (this.answeringAt === index) {
        this.answeringAt = -1;
      }
    },

    startAnswering(index) {
      this.answeringAt = index;
      this.draftAnswer = this.questions[index]?.answer || '';
    },

    /**
     * Answer a question yourself (34:1105).
     *
     * The answer goes onto the question in BRIEF.md rather than into a box that forgets it, so
     * the question stops being open here, stops being open on the next visit, and is read by
     * whatever reads the brief next - which is the assistant.
     */
    saveAnswer(index) {
      const answer = this.draftAnswer.trim();

      if (!answer) {
        this.answeringAt = -1;

        return;
      }

      this.questions = this.questions.map((q, i) => (i === index ? { ...q, answer } : q));
      this.answeringAt = -1;
      this.draftAnswer = '';
    },

    reopenQuestion(index) {
      this.questions = this.questions.map((q, i) => (i === index ? { ...q, answer: '' } : q));
    },

    startWhy(index) {
      this.whyAt = index;
      this.draftWhy = this.questions[index]?.why || '';
    },

    /**
     * The second line of a question card (the design's 34:1095 and the two like it).
     *
     * Why the question cannot be guessed, what makes it worth asking, or what goes wrong if it
     * is answered the wrong way. It goes into BRIEF.md under the question, so the assistant is
     * handed the reasoning along with the question rather than the question alone - which is
     * the difference between it answering and it guessing again.
     *
     * Emptying the box removes the line rather than leaving a blank one.
     */
    saveWhy(index) {
      const why = this.draftWhy.trim();

      this.questions = this.questions.map((q, i) => (i === index ? { ...q, why } : q));
      this.whyAt = -1;
      this.draftWhy = '';
    },

    /**
     * The sections this form owns, in the order the document lays them out.
     *
     * The one list `parseBrief` is keyed against and `briefDocument` writes from, so the two
     * halves of the round trip cannot drift apart: add a box to the form and it is read and
     * written by the same edit.
     */
    ownedSections() {
      const out = [
        ['What you were handed', this.request.trim() || '_not stated_'],
        ['The problem', this.problem.trim() || '_not stated_'],
        ['Who has it', this.who.trim() || '_not stated_'],
        ['Written for', this.rolesBody()],
        ['What changes for them', this.changes.trim() || '_not stated_'],
        ['What we are deliberately not doing', this.notDoing.trim() || '_not stated_'],
        ['How we will know it worked', this.criteriaBody()],
        ['Open questions', this.questionsBody()],
        ['Prior art we are reusing', this.reuseBody()],
      ];

      // Only when the file does not already say. `extension-placement.ts` writes this section
      // at creation with the paragraph that explains the choice, and this form knows the route
      // id and nothing else - so claiming the section unconditionally flattened that paragraph
      // to one line on the first save.
      if (this.placement && !this.seededPlacement) {
        out.push(['Where it appears', `Parent route: \`${ this.placement }\``]);
      }

      return out;
    },

    /**
     * The checklist, with the ticks left where they were.
     *
     * A tick is screen 13's record that the criterion was met. This form rewrites the line to
     * change its wording, so it has to put the box back as it found it - keyed on the text,
     * because that is the key both other screens reconcile on. Re-wording a criterion drops its
     * tick, which is right: it is not the same criterion any more.
     */
    criteriaBody() {
      if (!this.filledCriteria.length) {
        return '_not stated_';
      }

      return this.filledCriteria
        .map((c) => `- [${ this.ticked.has(c) ? 'x' : ' ' }] ${ c }`)
        .join('\n');
    },

    /** The audience chips, in the order the chips are drawn rather than the order clicked. */
    rolesBody() {
      const chosen = ROLES.filter((role) => this.roles.includes(role));

      return chosen.length ? chosen.map((role) => `- ${ role }`).join('\n') : '_not stated_';
    },

    /**
     * The open questions, in the shape the parser above reads and a person would write.
     *
     * The severity is the first thing on the line because it is the first thing that matters
     * about a question, both to whoever reads the file and to the assistant that is handed it.
     */
    questionsBody() {
      const oneLine = (text) => text.trim().replace(/\s+/g, ' ');

      const rows = this.questions
        .filter((q) => q.text.trim())
        .map((q) => {
          const out = [`- **${ q.severity }** ${ q.text.trim() }`];

          if (q.why?.trim()) {
            out.push(`  Why: ${ oneLine(q.why) }`);
          }

          if (q.answer.trim()) {
            out.push(`  Answer: ${ oneLine(q.answer) }`);
          }

          return out.join('\n');
        });

      return rows.length ? rows.join('\n') : '_none open_';
    },

    /**
     * What this brief has decided to reuse rather than build again.
     *
     * A decision, not a search result: the search is re-run every time somebody presses the
     * button and finds whatever the words match today, while this is the line somebody chose,
     * and it is in the document the assistant reads before it writes anything.
     */
    reuseBody() {
      if (!this.reuse.length) {
        return '_nothing chosen_';
      }

      return [
        'Look at these before writing the same thing again, and say in the code where it came from.',
        '',
        ...this.reuse.map((r) => `- ${ r.extension } ${ r.where }`),
      ].join('\n');
    },

    /**
     * The brief as a document, with everything this form does not own left where it was.
     *
     * Markdown because it is going into a git repository next to the code it describes, and
     * because the thing that reads it first is a language model.
     *
     * The version this replaces built the whole file from the form, which meant that saving a
     * brief deleted every section the form has no box for - and by the time anybody saves one,
     * screen 13 has appended `## Verification` with a verdict per criterion, and a person may
     * have added prose of their own. Sections are matched by heading: the ones this form owns
     * get the form's contents, the rest are copied through untouched.
     */
    briefDocument(existing = '', agreed = this.agreedOn) {
      const owned = this.ownedSections();
      const bodies = new Map(owned.map(([title, body]) => [title.toLowerCase(), body]));
      const head = [];
      const blocks = [];
      let current = null;
      let inFooter = false;
      // Which block the footer sat under in the file it came from, or -1 for a file with none.
      let footerAfter = -1;

      (existing || '').split('\n').forEach((raw) => {
        const line = raw.replace(/\s+$/, '');
        const heading = /^##\s+(\S.*)$/.exec(line);

        if (heading) {
          current = { title: heading[1].trim(), body: [] };
          inFooter = false;
          blocks.push(current);

          return;
        }

        if (!current) {
          head.push(line);

          return;
        }

        // The `---` and the sentence under it are this form's own footer, wherever they sit.
        // They are re-emitted below rather than carried, so the agreed line can be kept
        // current instead of accumulating one per agreement - but they go back after the same
        // section they were under, so saving does not reshuffle the document.
        if (line.trim() === '---') {
          inFooter = true;
          footerAfter = blocks.length - 1;
        }

        if (!inFooter) {
          current.body.push(line);
        }
      });

      const inFile = new Set(blocks.map((b) => b.title.toLowerCase()));
      const out = [];
      const done = new Set();

      const pushBlock = (lines) => {
        while (out.length && !out[out.length - 1].trim()) {
          out.pop();
        }

        if (out.length) {
          out.push('');
        }

        out.push(...lines);
      };

      const pushOwned = (title) => {
        done.add(title.toLowerCase());
        pushBlock([`## ${ title }`, ...bodies.get(title.toLowerCase()).split('\n')]);
      };

      pushBlock(head.join('\n').trim() ? head : [`# ${ this.extension }`]);

      let ownedEnd = out.length;
      let footerAt = -1;

      blocks.forEach((block, i) => {
        const key = block.title.toLowerCase();

        if (!bodies.has(key)) {
          pushBlock([`## ${ block.title }`, ...block.body]);

          if (i === footerAfter) {
            footerAt = out.length;
          }

          return;
        }

        // Any owned section the file has never had goes in ahead of the first one it does
        // have that comes after it, so the document keeps the order the form is in.
        owned.forEach(([title]) => {
          const t = title.toLowerCase();

          if (t !== key && !done.has(t) && !inFile.has(t) && !this.after(owned, t, key)) {
            pushOwned(title);
          }
        });

        pushOwned(block.title);
        ownedEnd = out.length;

        if (i === footerAfter) {
          footerAt = out.length;
        }
      });

      owned.forEach(([title]) => {
        if (!done.has(title.toLowerCase())) {
          pushOwned(title);
          ownedEnd = out.length;
        }
      });

      // The footer goes back where it was - under the brief, above anything appended after it -
      // rather than at the end of the file, where it would sit below screen 13's verdicts.
      let at = footerAt < 0 ? ownedEnd : footerAt;

      // The blank line the footer used to be separated by belongs to the footer, not to the
      // section above it, or every save adds another one.
      while (at > 0 && !out[at - 1].trim()) {
        out.splice(at - 1, 1);
        at--;
      }

      out.splice(at, 0,
        '', '---', '', 'Written in the Extension Studio before any code existed.',
        ...(agreed ? ['', `_Agreed in the Extension Studio on ${ agreed }._`] : []));

      return `${ out.join('\n').replace(/\n+$/, '') }\n`;
    },

    /** Whether `title` comes after `other` in the owned order. */
    after(owned, title, other) {
      const index = (t) => owned.findIndex(([name]) => name.toLowerCase() === t);

      return index(title) > index(other);
    },

    /** Save what is typed, into the file, without agreeing anything. */
    async saveDraft() {
      if (this.loading || this.autosaving) {
        return;
      }

      const key = this.formKey;
      const text = this.briefDocument(this.original);

      this.autosaving = true;
      this.saveError = '';

      try {
        await writeExtensionFile(this.extension, 'BRIEF.md', text);
        this.original = text;
        this.exists = true;
        this.savedAt = new Date();
        // Anything typed while that write was in flight is still unsaved.
        this.dirty = this.formKey !== key;

        if (this.dirty) {
          this.queueSave();
        }
      } catch (e) {
        this.saveError = e?.message || String(e);
      } finally {
        this.autosaving = false;
      }
    },

    /**
     * Save shortly after the typing stops.
     *
     * The brief was write-only until this: the only write was `agree()`, which navigates away,
     * so an edit to any box - or to a criterion, which two other screens read - was lost on the
     * next reload with nothing on the screen suggesting it would be. The masthead says when the
     * last save happened, so the promise the screen makes is one it keeps.
     */
    queueSave() {
      this.dirty = true;
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.saveDraft(), 700);
    },

    async agree() {
      if (!this.canAgree) {
        return;
      }

      this.saving = true;
      clearTimeout(this.saveTimer);

      const on = new Date().toISOString().slice(0, 10);
      const text = this.briefDocument(this.original, on);

      try {
        await writeExtensionFile(this.extension, 'BRIEF.md', text);
        this.original = text;
        this.agreedOn = on;
        this.exists = true;
        this.dirty = false;
        this.savedAt = new Date();

        // The workspace picks the brief up and sends it to the assistant as the first
        // instruction of the session.
        this.$router.push({
          name:   EDITOR_ROUTE,
          params: { extension: this.extension },
          query:  { brief: '1' },
        });
      } catch (e) {
        toastError(this.$store, 'Could not save the brief', e?.message || String(e));
        this.saving = false;
      }
    },

    skip() {
      this.$router.push({ name: EDITOR_ROUTE, params: { extension: this.extension } });
    },

    /**
     * Ask the assistant what it cannot decide from this brief.
     *
     * It is asked to write the questions into `## Open questions` in BRIEF.md rather than to
     * answer in the terminal, because writing a file is a thing it can do and this screen can
     * read - so the questions land in the list beside this button instead of scrolling past in
     * a pane nobody has open. The answer in the terminal is still there to argue with; what
     * changed is that the list is not lost when the pane is closed.
     *
     * The typing is saved first. The prompt tells it to edit the file, and an edit against a
     * copy that does not yet contain what is on this screen would drop it.
     */
    async askWhatIsUnclear() {
      if (this.asking) {
        return;
      }

      this.asking = true;

      try {
        clearTimeout(this.saveTimer);
        await this.saveDraft();

        const how = await askAssistant(this.extension, [
          `Read BRIEF.md in this package. It is the brief for the ${ this.extension } extension,`,
          'written before any code exists.',
          'Work out only the decisions you cannot make from it - the choices where guessing would',
          'waste the build: empty states, defaults, whether to replace something or sit beside it.',
          'Then edit BRIEF.md: under the `## Open questions` heading, replace `_none open_` with one',
          'line per question in exactly this form, and change nothing else in the file:',
          '`- **Blocking** the question` for a question that stops you starting, or',
          '`- **Worth asking** the question` for one that does not.',
          'Under each question add one further line, indented by two spaces, in the form',
          '`  Why: ` followed by why it cannot be guessed - what in the brief made you ask, or',
          'what goes wrong if it is answered the wrong way. One sentence.',
          'Do not answer them and do not write any other code yet.',
        ].join(' '));

        this.asked = how;
        toastSuccess(
          this.$store,
          how === 'sent'
            ? 'It is reading the brief now. Press "Re-read the brief" in a moment to pick the questions up.'
            : 'The workspace session is not open yet, so this is the first thing it will be asked when it opens.',
          { title: 'Asked the assistant' }
        );
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'Could not ask the assistant' });
      } finally {
        this.asking = false;
      }
    },

    /**
     * Ask the assistant to argue with the request (34:1012's callout).
     *
     * The design has this callout asserting that the ticket named a solution rather than a
     * problem, and saying why building it as written would miss the point. Nothing in this
     * Studio can make that judgement - it is a reading of two paragraphs against each other,
     * which is what the thing in the pod is for - so the callout does not assert it. It asks
     * for it, and prints what came back.
     *
     * Which makes it the same shape as "Ask what is unclear", on purpose: the assistant is
     * asked to write into a named section of BRIEF.md, the file is re-read, and what it wrote
     * is rendered here. A section rather than a reply in the terminal, because a reply in the
     * terminal is gone the moment the pane is closed and this is a judgement about the brief
     * that belongs with the brief. It is also the one thing in the product that reads screen
     * 02's two fields against each other, which was the whole point of the second field.
     */
    async askItToArgue() {
      if (this.arguing) {
        return;
      }

      this.arguing = true;

      try {
        clearTimeout(this.saveTimer);
        await this.saveDraft();

        const how = await askAssistant(this.extension, [
          `Read BRIEF.md in this package. It is the brief for the ${ this.extension } extension.`,
          '`## What you were handed` is the request as it was typed and `## The problem` is what',
          'the person said cannot be done today. Read one against the other and decide whether',
          'the request names a solution rather than the problem behind it, and whether building',
          'it exactly as written would miss the point. Then edit BRIEF.md: add a section headed',
          '`## The challenge` directly under `## What you were handed`, replacing that section if',
          'it is already there, holding at most four sentences - what you think is being asked',
          'for, and why building it as written would or would not answer the problem. Say so',
          'plainly if the request is already a problem statement and there is nothing to argue',
          'with. Change nothing else in the file and write no code yet.',
        ].join(' '));

        this.argued = how;
        toastSuccess(
          this.$store,
          how === 'sent'
            ? 'It is reading the brief now. Press "Re-read the brief" in a moment to see what it says.'
            : 'The workspace session is not open yet, so this is the first thing it will be asked when it opens.',
          { title: 'Asked it to argue' }
        );
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'Could not ask the assistant' });
      } finally {
        this.arguing = false;
      }
    },

    /**
     * Read BRIEF.md again, for the questions the pod has written into it since.
     *
     * A button rather than a poll: the assistant writes the file when it gets round to it, and
     * a form that reloads itself under somebody's cursor while they are typing in it is worse
     * than one they have to ask. Anything unsaved goes in first, for the same reason the ask
     * saves first.
     */
    async rereadBrief() {
      if (this.rereading) {
        return;
      }

      this.rereading = true;

      try {
        clearTimeout(this.saveTimer);

        if (this.dirty) {
          await this.saveDraft();
        }

        const before = this.questions.length;
        const hadChallenge = !!this.challenge;

        this.ready = false;
        this.loading = true;
        await this.load();

        const found = this.questions.length - before;
        const news = [];

        if (found > 0) {
          news.push(`${ found } new question${ found === 1 ? '' : 's' }`);
        }

        if (!hadChallenge && this.challenge) {
          news.push('the assistant\'s argument with the request, in the first card');
        }

        toastSuccess(this.$store, news.length
          ? `${ news.join(', and ') } in the brief.`
          : 'Nothing new in the brief yet.');
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'Could not re-read the brief' });
      } finally {
        this.rereading = false;
      }
    },

    /**
     * Go and look at what the search found (34:1145's "Look at it").
     *
     * The Files screen of the extension the hit is in, with that file open - which is the one
     * surface in this Studio that can show somebody else's source, so nothing new is invented
     * to do it.
     */
    lookAtHit(hit) {
      this.$router.push({
        name:   FILES_ROUTE,
        params: { extension: hit.extension },
        query:  { file: hit.path },
      });
    },

    /**
     * Adopt a finding into the brief (34:1147's "Reuse its chart").
     *
     * A real commitment rather than a bookmark: it is written into BRIEF.md, which is the
     * document CLAUDE.md tells the assistant to read first, so the choice reaches the thing
     * that writes the code. Toggling, because the wrong line gets clicked.
     */
    toggleReuse(hit) {
      const where = `${ hit.path }:${ hit.line }`;
      const key = `${ hit.extension } ${ where }`;

      this.reuse = this.reuseKeys.has(key)
        ? this.reuse.filter((r) => `${ r.extension } ${ r.where }` !== key)
        : [...this.reuse, { extension: hit.extension, where }];
    },

    isReused(hit) {
      return this.reuseKeys.has(`${ hit.extension } ${ hit.path }:${ hit.line }`);
    },

    openWorkspace() {
      this.$router.push({
        name:   EDITOR_ROUTE,
        params: { extension: this.extension },
        query:  { tab: 'terminal' },
      });
    },

    /**
     * Look for the parts of this that somebody has already built.
     *
     * A fixed-string grep over the source of every extension in this Studio, which is what
     * `findPriorArt` is: not a semantic search, and the card says so, because "no hits" from a
     * grep means "nobody used these words" and not "nothing like this exists".
     *
     * This extension's own BRIEF.md is dropped from the results. It is the document being typed
     * on this screen - it matches every term by construction, and reporting it as prior art
     * would be the search finding itself.
     */
    async lookForPriorArt() {
      if (this.searching) {
        return;
      }

      this.searching = true;
      this.priorArtError = '';

      try {
        const hits = await findPriorArt(this.priorArtTerms);

        this.priorArt = hits.filter((h) => !(h.extension === this.extension && h.path === 'BRIEF.md'));
      } catch (e) {
        this.priorArtError = e?.message || String(e);
        this.priorArt = null;
      } finally {
        this.searching = false;
      }
    },
  },
};
</script>

<template>
  <div class="brief">
    <!-- workspace masthead (34:965) -->
    <div class="brief__masthead">
      <SButton
        variant="ghost"
        size="sm"
        icon="chevronLeft"
        icon-only
        aria-label="Back"
        @click="$router.push({ name: routes.STUDIO_ROUTE })"
      />

      <div class="brief__name">
        <div class="brief__title">
          {{ extension }}
        </div>
        <div class="brief__eyebrow">
          Brief · step 1 of 2 before any code is written
        </div>
      </div>

      <SChip
        data-testid="brief-status"
        :label="status.label"
        :icon="status.icon"
        :tone="status.tone"
      />

      <span
        class="brief__saved"
        data-testid="brief-saved"
        title="Every edit is written into BRIEF.md in the extension. Agreeing is what hands it to the assistant."
      >{{ savedNote }}</span>

      <span class="brief__grow" />

      <SButton variant="ghost" size="sm" @click="skip">
        Skip the brief
      </SButton>
      <SButton
        variant="primary"
        size="sm"
        icon="sparkle"
        :loading="saving"
        :disabled="!canAgree"
        @click="agree"
      >
        Agree and start building
      </SButton>
    </div>

    <!-- scroll (34:991) -->
    <div class="brief__scroll">
      <div class="brief__columns">
        <!-- main column (34:993) -->
        <div class="brief__main">
          <!-- What you were handed (34:995) -->
          <section class="brief__card">
            <header class="brief__card-head">
              <h2 class="brief__card-title">
                What you were handed
              </h2>
              <!--
                The design frames this card as a ticket: an id, whoever raised it, and how long
                ago. Two of those three now have a source. The extension records whoever created
                it under `## Who asked` in the brief, with the date, so the raiser and the age
                are read rather than invented - and they are the same principal `review.ts`
                gates the outcome sign-off on, so what this line says is what that rule
                enforces. The id has no source and is not shown: there is no ticket system
                behind this Studio to have issued one.
              -->
              <p class="brief__card-note">
                The request as it was typed in the description step, kept with the brief. There
                is no ticket system behind this Studio, so there is no id - but the brief
                records who asked and when.
              </p>
            </header>
            <div class="brief__card-body">
              <!--
                Raised by, and how long ago (34:999). Read out of `## Who asked`; absent from
                every brief written before that section existed, and it says which rather than
                naming whoever has the page open.
              -->
              <div class="brief__raised" data-testid="brief-raised">
                <SIcon :name="askedBy ? 'user' : 'info'" :size="14" />
                <template v-if="askedBy">
                  <span>Asked for by <strong>{{ askedBy.name || askedBy.principal }}</strong></span>
                  <span v-if="askedAge" class="brief__raised-age">· {{ askedAge }}</span>
                  <span
                    class="brief__raised-id"
                    title="The Rancher principal recorded in the brief. The outcome sign-off is theirs to give."
                  >
                    {{ askedBy.principal }}
                  </span>
                </template>
                <span v-else>
                  Nobody is recorded as having asked for this. The brief has no
                  <code>## Who asked</code> section, which is how every extension made before the
                  Studio recorded it reads - so the outcome sign-off will accept whoever gives it
                  and say that the requester was never recorded.
                </span>
              </div>

              <div class="brief__ticket" data-testid="brief-request">
                <SIcon name="book" :size="15" />
                <p class="brief__ticket-text">
                  {{ request || 'Nothing was carried through from the description step.' }}
                </p>
              </div>

              <div v-if="outcome" class="brief__ticket">
                <SIcon name="user" :size="15" />
                <div class="brief__quote">
                  <span class="brief__quote-lead">What you said a good outcome would be</span>
                  <p class="brief__ticket-text">
                    {{ outcome }}
                  </p>
                </div>
              </div>

              <!--
                34:1013's accented callout, which the design has arguing that the request names a
                solution rather than a problem. Nothing in this Studio can make that judgement -
                it is a reading of the request against the problem statement - so the callout
                does not assert it, it asks for it. The button puts both to the assistant in
                this extension's pod and asks it to write its verdict into `## The challenge` in
                BRIEF.md; when that section is there, this is what it says. Until then the
                callout says nobody has argued, which is the truth rather than an empty state.
              -->
              <div class="brief__insight" data-testid="brief-insight">
                <SIcon :name="challenge ? 'sparkle' : 'info'" :size="15" />
                <div class="brief__quote">
                  <span class="brief__insight-lead">
                    {{ challenge ? 'The assistant argued with this' : 'Nobody has argued with this yet' }}
                  </span>
                  <p v-if="challenge" class="brief__insight-text" data-testid="brief-challenge">
                    {{ challenge }}
                  </p>
                  <p v-else class="brief__insight-text">
                    A request often names a solution rather than the problem behind it, and this
                    Studio cannot tell you which this one is: nothing here has read it. Asking
                    puts the request and the problem statement to the assistant working on
                    {{ extension }} and asks it to write what it makes of them into this brief.
                  </p>
                  <p v-if="argued" class="brief__insight-note">
                    {{ argued === 'sent'
                      ? 'Asked. It edits the brief when it gets there, so re-read it in a moment.'
                      : 'The workspace session is not open yet, so this is the first thing it will be asked when it opens.' }}
                  </p>
                  <div class="brief__card-actions">
                    <SButton
                      variant="ghost"
                      size="sm"
                      icon="sparkle"
                      data-testid="brief-ask-challenge"
                      :loading="arguing"
                      :disabled="!problem.trim() && !request.trim()"
                      @click="askItToArgue"
                    >
                      {{ challenge ? 'Ask it again' : 'Ask it to argue with this' }}
                    </SButton>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <!-- What the assistant thinks you are solving (34:1017) -->
          <section class="brief__card">
            <header class="brief__card-head">
              <h2 class="brief__card-title">
                What the assistant thinks you are solving
              </h2>
              <p class="brief__card-note">
                Drafted from what you typed and from what is already in this Rancher. Edit
                anything - this is your brief, not its.
              </p>
            </header>
            <div class="brief__card-body">
              <SField
                v-model="problem"
                label="The problem"
                placeholder="What cannot be done today, in one sentence."
                multiline
                :rows="2"
              />
              <SField
                v-model="who"
                label="Who has it"
                placeholder="The person this is for, and when they hit it."
                multiline
                :rows="2"
              />

              <!--
                34:1030: who it is written for. Multi-select, because two of the four chips are
                drawn ticked, and written into the brief - the audience is half of what decides
                the interface, and the assistant reads the brief before it draws any of it.
              -->
              <div class="brief__roles">
                <SLabel text="Written for" />
                <div class="brief__role-row">
                  <SChip
                    v-for="role in roleOptions"
                    :key="role"
                    :label="role"
                    :icon="roles.includes(role) ? 'check' : ''"
                    :tone="roles.includes(role) ? 'info' : 'default'"
                    clickable
                    :data-testid="`brief-role-${ role.toLowerCase().replace(/ /g, '-') }`"
                    @click="toggleRole(role)"
                  />
                </div>
              </div>

              <SField
                v-model="changes"
                label="What changes for them"
                placeholder="What they will be able to do that they cannot now."
                multiline
                :rows="2"
              />
              <SField
                v-model="notDoing"
                label="What we are deliberately not doing"
                placeholder="The scope this is not taking on, so nobody has to ask twice."
                multiline
                :rows="2"
              />
            </div>
          </section>

          <!-- How we will know it worked (34:1048) -->
          <section class="brief__card">
            <header class="brief__card-head">
              <h2 class="brief__card-title">
                How we will know it worked
              </h2>
              <p class="brief__card-note">
                These become the checklist the reviewer and the requester tick off. Phrase each
                one as something you could watch a person do.
              </p>
            </header>
            <div class="brief__card-body">
              <div
                v-for="(_, i) in criteria"
                :key="i"
                class="brief__ac"
              >
                <span class="brief__ac-box">{{ i + 1 }}</span>
                <input
                  v-model="criteria[i]"
                  class="brief__ac-input"
                  :placeholder="`Acceptance criterion ${ i + 1 }`"
                >
                <SButton
                  v-if="criteria.length > 1"
                  variant="ghost"
                  size="sm"
                  icon="close"
                  icon-only
                  aria-label="Remove"
                  @click="removeCriterion(i)"
                />
                <!--
                  34:1057: the per-row menu. Reorder is what it is for - the order here is the
                  order screen 13 walks them in, and until this there was no way to change it.
                -->
                <SMenu
                  :items="criterionMenu(i)"
                  :aria-label="`Actions for criterion ${ i + 1 }`"
                  @select="onCriterion(i, $event)"
                />
              </div>

              <SButton variant="ghost" size="sm" icon="plus" @click="addCriterion">
                Add another
              </SButton>
            </div>
          </section>
        </div>

        <!-- side column (34:994) -->
        <div class="brief__side">
          <!-- What the assistant cannot decide (34:1085) -->
          <section class="brief__card">
            <header class="brief__card-head">
              <div class="brief__card-title-row">
                <h2 class="brief__card-title">
                  What the assistant cannot decide
                </h2>
                <SChip
                  v-if="questions.length"
                  data-testid="brief-open-count"
                  :label="openCount ? `${ openCount } open` : 'all answered'"
                  :icon="blockingCount ? 'alert' : 'check'"
                  :tone="blockingCount ? 'warning' : 'success'"
                />
              </div>
              <p class="brief__card-note">
                The most useful thing on this screen. Ask before you build, not after. Every
                question here lives in <code>BRIEF.md</code>, so it survives this page and is
                read by whatever reads the brief next.
              </p>
              <!--
                The design's "Send 3 questions to the requester" (34:980) and the per-question
                "Ask the requester" (34:1100) are both still absent, and this is why. There is
                now a requester - the brief records one - but nothing to send with: Rancher has
                no messaging between its users and this Studio has no ticket to comment on. A
                button that names a person it cannot reach is worse than no button.
              -->
              <p v-if="askedBy" class="brief__card-note" data-testid="brief-questions-for">
                These are for <strong>{{ askedBy.name || askedBy.principal }}</strong>, who asked
                for this. Nothing here can send them: Rancher has no messaging between users and
                this Studio has no ticket to comment on, so the brief is where they wait and the
                answers go back into the same file.
              </p>
            </header>
            <div class="brief__card-body">
              <SBanner v-if="!questions.length" type="info">
                Nothing is listed yet. Asking tells the assistant working on
                <strong>{{ extension }}</strong> to write what it cannot decide into this
                brief; it also answers in that extension's terminal, where you can argue with
                it. Or write a question yourself, below.
              </SBanner>

              <!-- 34:1090 / 34:1106: the cards, and the severity that separates them. -->
              <div
                v-for="q in openQuestions"
                :key="`open-${ q.index }`"
                class="brief__question"
                :class="{ 'brief__question--blocking': q.severity === 'Blocking' }"
                data-testid="brief-question"
              >
                <div class="brief__question-head">
                  <SChip
                    :label="q.severity"
                    :icon="q.severity === 'Blocking' ? 'alert' : 'search'"
                    :tone="q.severity === 'Blocking' ? 'error' : 'default'"
                    clickable
                    :title="q.severity === 'Blocking'
                      ? 'Blocking: nobody can start until this is answered. Click to downgrade it.'
                      : 'Worth asking: useful, but the build can start without it. Click to mark it blocking.'"
                    @click="toggleSeverity(q.index)"
                  />
                  <span class="brief__grow" />
                  <SButton
                    variant="ghost"
                    size="sm"
                    icon="close"
                    icon-only
                    aria-label="Remove this question"
                    @click="removeQuestion(q.index)"
                  />
                </div>

                <p class="brief__question-text">
                  {{ q.text }}
                </p>

                <!--
                  The second line the design draws under every question (34:1095 and the two
                  like it): the rationale on the blocking card, the evidence on the first
                  "Worth asking" one, the risk on the second. It is one field, because those
                  are one sentence in three moods, and it is only here when somebody or the
                  assistant wrote one - an empty line under every question would be the card
                  claiming a reason it does not have.
                -->
                <p v-if="q.why" class="brief__question-why" data-testid="brief-question-why">
                  {{ q.why }}
                </p>

                <div v-if="whyAt === q.index" class="brief__answer">
                  <SField
                    v-model="draftWhy"
                    label="Why it cannot be guessed"
                    placeholder="What made you ask, or what goes wrong if this is answered the wrong way."
                    multiline
                    :rows="2"
                    autofocus
                  />
                  <div class="brief__card-actions">
                    <SButton variant="ghost" size="sm" @click="whyAt = -1">
                      Cancel
                    </SButton>
                    <SButton
                      variant="secondary"
                      size="sm"
                      icon="check"
                      :data-testid="`brief-save-why-${ q.index }`"
                      @click="saveWhy(q.index)"
                    >
                      Save
                    </SButton>
                  </div>
                </div>

                <div v-else-if="answeringAt === q.index" class="brief__answer">
                  <SField
                    v-model="draftAnswer"
                    label="Your answer"
                    placeholder="What the answer is, so nobody has to ask again."
                    multiline
                    :rows="2"
                    autofocus
                  />
                  <div class="brief__card-actions">
                    <SButton variant="ghost" size="sm" @click="answeringAt = -1">
                      Cancel
                    </SButton>
                    <SButton
                      variant="secondary"
                      size="sm"
                      icon="check"
                      :disabled="!draftAnswer.trim()"
                      :data-testid="`brief-save-answer-${ q.index }`"
                      @click="saveAnswer(q.index)"
                    >
                      Save the answer
                    </SButton>
                  </div>
                </div>

                <div v-else class="brief__card-actions">
                  <!-- 34:1105 -->
                  <SButton
                    variant="ghost"
                    size="sm"
                    icon="user"
                    :data-testid="`brief-answer-myself-${ q.index }`"
                    @click="startAnswering(q.index)"
                  >
                    Answer it myself
                  </SButton>
                  <SButton
                    variant="ghost"
                    size="sm"
                    icon="info"
                    :data-testid="`brief-why-${ q.index }`"
                    @click="startWhy(q.index)"
                  >
                    {{ q.why ? 'Edit why it matters' : 'Say why it matters' }}
                  </SButton>
                </div>
              </div>

              <div
                v-for="q in answeredQuestions"
                :key="`done-${ q.index }`"
                class="brief__question brief__question--answered"
              >
                <div class="brief__question-head">
                  <SChip label="Answered" icon="check" tone="success" />
                  <span class="brief__grow" />
                  <SButton
                    variant="ghost"
                    size="sm"
                    @click="reopenQuestion(q.index)"
                  >
                    Reopen
                  </SButton>
                </div>
                <p class="brief__question-text">
                  {{ q.text }}
                </p>
                <p v-if="q.why" class="brief__question-why">
                  {{ q.why }}
                </p>
                <p class="brief__question-answer">
                  {{ q.answer }}
                </p>
              </div>

              <div class="brief__ask-row">
                <input
                  v-model="newQuestion"
                  class="brief__ask-input"
                  placeholder="A question nobody has answered yet"
                  aria-label="Add an open question"
                  data-testid="brief-new-question"
                  @keyup.enter="addQuestion"
                >
                <SButton
                  variant="ghost"
                  size="sm"
                  icon="plus"
                  icon-only
                  aria-label="Add this question"
                  :disabled="!newQuestion.trim()"
                  @click="addQuestion"
                />
              </div>

              <p v-if="asked" class="brief__asked">
                {{ asked === 'sent'
                  ? 'Asked. It edits the brief when it gets there, so re-read it in a moment.'
                  : 'The workspace session is not open yet, so this is the first thing it will be asked when it opens.' }}
              </p>

              <div class="brief__card-actions">
                <SButton
                  variant="ghost"
                  size="sm"
                  icon="sparkle"
                  data-testid="brief-ask-unclear"
                  :loading="asking"
                  :disabled="!problem.trim()"
                  @click="askWhatIsUnclear"
                >
                  Ask what is unclear
                </SButton>
                <SButton
                  variant="ghost"
                  size="sm"
                  icon="refresh"
                  data-testid="brief-reread"
                  :loading="rereading"
                  @click="rereadBrief"
                >
                  Re-read the brief
                </SButton>
                <SButton
                  v-if="asked"
                  variant="ghost"
                  size="sm"
                  icon="terminal"
                  @click="openWorkspace"
                >
                  Open the workspace
                </SButton>
              </div>
            </div>
          </section>

          <!-- This already exists, partly (34:1139) -->
          <section class="brief__card">
            <header class="brief__card-head">
              <h2 class="brief__card-title">
                This already exists, partly
              </h2>
              <p class="brief__card-note">
                A word search over the source of every extension in this Studio.
              </p>
            </header>
            <div class="brief__card-body">
              <SBanner v-if="priorArtError" type="error">
                {{ priorArtError }}
              </SBanner>

              <SBanner v-else-if="priorArt === null" type="info">
                Looks for <template v-if="priorArtTerms.length">
                  <code v-for="t in priorArtTerms" :key="t" class="brief__term">{{ t }}</code>
                </template>
                <template v-else>the words in the title and the problem</template>
                in every extension's source, and reports the file and line of each hit. It is a
                word search, not an understanding of them: no hits means nobody used these words.
              </SBanner>

              <SBanner v-else-if="!priorArt.length" type="success">
                No extension in this Studio mentions
                <code v-for="t in priorArtTerms" :key="t" class="brief__term">{{ t }}</code>.
                Nothing to reuse and nothing to collide with - on these words, at least.
              </SBanner>

              <div v-else class="brief__art">
                <div v-for="g in priorArtGroups" :key="g.extension" class="brief__art-group">
                  <div class="brief__art-head">
                    <SIcon name="puzzle" :size="13" />
                    <span class="brief__art-ext">{{ g.extension }}</span>
                    <span class="brief__art-count">{{ g.hits.length }}</span>
                  </div>
                  <div
                    v-for="(hit, i) in g.hits"
                    :key="`${ hit.path }:${ hit.line }:${ i }`"
                    class="brief__art-hit"
                  >
                    <span class="brief__art-where">{{ hit.path }}:{{ hit.line }}</span>
                    <code class="brief__art-text">{{ hit.text }}</code>
                    <div class="brief__art-actions">
                      <!-- 34:1145: go and judge the overlap yourself. -->
                      <SButton
                        variant="ghost"
                        size="sm"
                        icon="external"
                        data-testid="brief-look-at-it"
                        @click="lookAtHit(hit)"
                      >
                        Look at it
                      </SButton>
                      <!-- 34:1147: a decision that reaches the assistant, not a bookmark. -->
                      <SButton
                        variant="ghost"
                        size="sm"
                        :icon="isReused(hit) ? 'check' : 'plus'"
                        data-testid="brief-reuse"
                        @click="toggleReuse(hit)"
                      >
                        {{ isReused(hit) ? 'Reusing this' : 'Reuse this' }}
                      </SButton>
                    </div>
                  </div>
                </div>
              </div>

              <div v-if="reuse.length" class="brief__reusing" data-testid="brief-reusing">
                <SLabel text="This brief says to reuse" />
                <div v-for="r in reuse" :key="`${ r.extension } ${ r.where }`" class="brief__reuse-row">
                  <SIcon name="check" :size="13" />
                  <span class="brief__reuse-where">{{ r.extension }} · {{ r.where }}</span>
                </div>
                <p class="brief__reuse-note">
                  Written into <code>BRIEF.md</code>, which is the first thing the assistant
                  reads in this tree, so it is a decision rather than a note to self.
                </p>
              </div>

              <SButton
                variant="ghost"
                size="sm"
                icon="search"
                :loading="searching"
                :disabled="!priorArtTerms.length"
                @click="lookForPriorArt"
              >
                {{ priorArt === null ? 'Look for prior art' : 'Look again' }}
              </SButton>
            </div>
          </section>

          <div class="brief__footnote">
            <SLabel text="What happens next" />
            <p class="brief__footnote-text">
              Every edit on this screen is written into <code>BRIEF.md</code> in the extension a
              moment after you stop typing, and the masthead says when that last happened.
              Agreeing is the separate thing: it records the agreement in the file and hands the
              brief to the assistant as the first thing it reads.
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.brief {
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

  // A centred column, as node 34:991 has it, rather than a centred row: the 14px gap the node
  // carries is between stacked children, and a row lays them out along the axis that has none.
  &__scroll {
    display:        flex;
    flex-direction: column;
    align-items:    center;
    gap:            14px;
    flex:           1 1 auto;
    min-height:     0;
    overflow-y:     auto;
    padding:        18px var(--studio-space-24) var(--studio-space-24);
  }

  &__columns {
    display:   flex;
    gap:       14px;
    width:     1240px;
    max-width: 100%;
    align-items: flex-start;
  }

  &__main {
    display:        flex;
    flex-direction: column;
    gap:            14px;
    flex:           1 1 auto;
    min-width:      0;
  }

  &__side {
    display:        flex;
    flex-direction: column;
    gap:            14px;
    width:          430px;
    flex:           0 0 430px;
  }

  &__card {
    background:    var(--studio-surface);
    border:        1px solid var(--studio-border);
    border-radius: var(--studio-radius);
  }

  &__card-head {
    display:        flex;
    flex-direction: column;
    gap:            3px;
    padding:        13px 18px 11px;
    border-bottom:  1px solid var(--studio-border-subtle);
  }

  &__card-title {
    font:   var(--studio-heading-16);
    color:  var(--studio-text);
    margin: 0;
  }

  &__card-note {
    font:   var(--studio-caption-12);
    color:  var(--studio-text-secondary);
    margin: 0;
  }

  &__card-body {
    display:        flex;
    flex-direction: column;
    gap:            11px;
    padding:        13px 18px 15px;
  }

  &__ticket,
  &__insight {
    display:       flex;
    align-items:   flex-start;
    gap:           11px;
    padding:       11px 14px;
    border-radius: var(--studio-radius);
  }

  &__ticket {
    background: var(--studio-surface-subtle);
    border:     1px solid var(--studio-border);
    color:      var(--studio-text-tertiary);
  }

  // 34:1013 is an accent bar down the left edge of the callout, which is what marks it as the
  // assistant's voice rather than another quoted row.
  &__insight {
    background:  var(--studio-blue-050);
    color:       var(--studio-info);
    border-left: 3px solid var(--studio-info);
  }

  &__quote {
    display:        flex;
    flex-direction: column;
    gap:            2px;
    flex:           1 1 auto;
    min-width:      0;
  }

  &__quote-lead {
    font:  var(--studio-caption-12-semi);
    color: var(--studio-text-secondary);
  }

  &__insight-lead {
    font:  var(--studio-body-13-semi);
    color: var(--studio-text);
  }

  &__insight-note {
    margin: 0;
    font:   var(--studio-caption-12);
    color:  var(--studio-text-secondary);
  }

  // Who raised it and how long ago (34:999), on one line above the quoted request. A row
  // rather than a card, because it qualifies the request rather than being a second one.
  &__raised {
    display:     flex;
    align-items: center;
    flex-wrap:   wrap;
    gap:         var(--studio-space-6);
    font:        var(--studio-caption-12);
    color:       var(--studio-text-secondary);

    code { font: var(--studio-caption-12); }
  }

  &__raised-age,
  &__raised-id {
    color: var(--studio-text-tertiary);
  }

  &__raised-id {
    font:          var(--studio-mono-12);
    padding:       1px 6px;
    border:        1px solid var(--studio-border-subtle);
    border-radius: var(--studio-radius-control);
  }

  // The autosave readout, next to the chip it qualifies: the chip says what the brief is, this
  // says whether what is on the screen has reached the file yet.
  &__saved {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  &__ticket-text,
  &__insight-text {
    flex:   1 1 auto;
    font:   var(--studio-body-14);
    color:  var(--studio-text);
    margin: 0;
  }

  &__ac {
    display:       flex;
    align-items:   center;
    gap:           10px;
    padding:       9px var(--studio-space-12);
    background:    var(--studio-surface-subtle);
    border:        1px solid var(--studio-border-subtle);
    border-radius: var(--studio-radius-control);

    &:focus-within { border-color: var(--studio-border-focus); }
  }

  // 34:1054, and 34:1055 inside it: the box carries the criterion's number, in Caption/12
  // SemiBold. Empty it reads as a checkbox somebody forgot to wire up.
  &__ac-box {
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    width:           var(--studio-space-20);
    height:          var(--studio-space-20);
    flex:            0 0 var(--studio-space-20);
    border:          1px solid var(--studio-border-strong);
    border-radius:   var(--studio-radius-control);
    background:      var(--studio-surface);
    font:            var(--studio-caption-12-semi);
    color:           var(--studio-text-secondary);
  }

  &__ac-input {
    flex:       1 1 auto;
    min-width:  0;
    border:     none;
    outline:    none;
    background: transparent;
    padding:    0;
    font:       var(--studio-body-14);
    color:      var(--studio-text);

    &::placeholder { color: var(--studio-text-tertiary); }
  }

  &__card-actions {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
    flex-wrap:   wrap;
  }

  &__card-title-row {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
  }

  /* Who it is written for (34:1030). */
  &__roles {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-6);
  }

  &__role-row {
    display:   flex;
    flex-wrap: wrap;
    gap:       var(--studio-space-6);
  }

  /*
   * One open question (34:1090). The blocking ones carry a left bar as well as their chip,
   * because severity is the reason the list is sorted the way it is and a chip alone does not
   * survive being skimmed.
   */
  &__question {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-6);
    padding:        var(--studio-space-10) var(--studio-space-12);
    background:     var(--studio-surface-subtle);
    border:         1px solid var(--studio-border-subtle);
    border-radius:  var(--studio-radius-control);

    &--blocking {
      border-left: 3px solid var(--studio-error);
      background:  var(--studio-error-bg);
    }

    &--answered { opacity: 0.85; }
  }

  &__question-head {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-6);
  }

  &__question-text {
    margin: 0;
    font:   var(--studio-body-14);
    color:  var(--studio-text);
  }

  &__question-answer {
    margin:      0;
    padding-left: var(--studio-space-10);
    border-left: 2px solid var(--studio-border);
    font:        var(--studio-caption-12);
    color:       var(--studio-text-secondary);
  }

  // The design's second line under a question, set quieter than the question itself: it is the
  // reasoning, and the question is the thing being skimmed for.
  &__question-why {
    margin: 0;
    font:   var(--studio-caption-12);
    color:  var(--studio-text-tertiary);
  }

  &__answer {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-8);
  }

  &__ask-row {
    display:       flex;
    align-items:   center;
    gap:           var(--studio-space-6);
    padding:       5px var(--studio-space-10);
    border:        1px dashed var(--studio-border);
    border-radius: var(--studio-radius-control);

    &:focus-within { border-color: var(--studio-border-focus); }
  }

  &__ask-input {
    flex:       1 1 auto;
    min-width:  0;
    border:     none;
    outline:    none;
    background: transparent;
    padding:    0;
    font:       var(--studio-caption-12);
    color:      var(--studio-text);

    &::placeholder { color: var(--studio-text-tertiary); }
  }

  &__art-actions {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-4);
    margin-top:  var(--studio-space-4);
  }

  &__reusing {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-4);
    padding:        var(--studio-space-8) var(--studio-space-10);
    border:         1px solid var(--studio-border-subtle);
    border-radius:  var(--studio-radius-control);
    background:     var(--studio-success-bg);
  }

  &__reuse-row {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-6);
    min-width:   0;
  }

  &__reuse-where {
    flex:          1 1 auto;
    min-width:     0;
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
    font:          var(--studio-mono-12);
    color:         var(--studio-text);
  }

  &__reuse-note {
    margin: 0;
    font:   var(--studio-caption-12);
    color:  var(--studio-text-secondary);
  }

  &__asked {
    font:   var(--studio-caption-12);
    color:  var(--studio-text-secondary);
    margin: 0;
  }

  &__term {
    font:          var(--studio-mono-12);
    background:    var(--studio-surface-subtle);
    border:        1px solid var(--studio-border-subtle);
    border-radius: var(--studio-radius-control);
    padding:       1px 4px;
    margin:        0 2px;
  }

  // The hits, grouped by the extension they were found in.
  &__art {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-12);
  }

  &__art-group {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-4);
  }

  &__art-head {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-6);
    color:       var(--studio-text-tertiary);
  }

  &__art-ext {
    flex:  1 1 auto;
    font:  var(--studio-caption-12-semi);
    color: var(--studio-text);
  }

  &__art-count {
    padding:       0 var(--studio-space-6);
    border-radius: var(--studio-radius-pill);
    background:    var(--studio-neutral-bg);
    font:          var(--studio-caption-12);
    color:         var(--studio-text-secondary);
  }

  &__art-hit {
    display:        flex;
    flex-direction: column;
    gap:            1px;
    padding:        var(--studio-space-6) var(--studio-space-10);
    background:     var(--studio-surface-subtle);
    border:         1px solid var(--studio-border-subtle);
    border-radius:  var(--studio-radius-control);
    min-width:      0;
  }

  &__art-where {
    font:  var(--studio-caption-12);
    color: var(--studio-text-secondary);
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
    direction:     rtl;
    text-align:    left;
  }

  &__art-text {
    font:          var(--studio-mono-12);
    color:         var(--studio-text);
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  &__footnote {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-4);
  }

  &__footnote-text {
    font:   var(--studio-caption-12);
    color:  var(--studio-text-secondary);
    margin: 0;

    code {
      font:          var(--studio-mono-12);
      background:    var(--studio-surface-subtle);
      border:        1px solid var(--studio-border-subtle);
      border-radius: var(--studio-radius-control);
      padding:       1px 4px;
    }
  }
}
</style>
