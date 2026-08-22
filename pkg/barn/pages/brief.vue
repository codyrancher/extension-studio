<script>
// Screen 10 · The brief — what are we actually trying to do? (Figma node 34:894).
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
// Gone. The masthead's "Send questions to the requester". There is no requester in this product
// - no ticket, no reporter, no messaging - and no list of questions to send either, since the
// answers to the card above arrive in a terminal. A button that cannot name who it sends to is
// not a feature waiting on plumbing, it is a promise about a workflow this product does not
// have, so it is removed rather than reinterpreted into something else wearing its label.
import {
  SButton, SChip, SIcon, SBanner, SField, SLabel
} from '../components/ui';
import { toastSuccess, toastError } from '../toast';
import {
  writeExtensionFile, askAssistant, findPriorArt, DEFAULT_EXTENSION
} from '../extensions';
import { EDITOR_ROUTE, STUDIO_ROUTE } from '../editor-product';
import '../design/tokens';
import fullBleed from '../design/full-bleed';

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
    SButton, SChip, SIcon, SBanner, SField, SLabel
  },

  mixins: [fullBleed],

  data() {
    return {
      problem:  '',
      who:      '',
      changes:  '',
      notDoing: '',
      criteria: ['', '', ''],
      saving:   false,
      asking:   false,
      // '' until the question has been put to the pod; then what happened to it, so the card
      // can say where the answer is rather than looking like nothing happened.
      asked:    '',
      searching: false,
      // null is "nobody has looked yet", [] is "looked, found nothing" - and those are
      // different sentences.
      priorArt: null,
      priorArtError: '',
    };
  },

  computed: {
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

    canAgree() {
      return !!this.problem.trim() && !this.saving;
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

  mounted() {
    // Prefill from what screen 02 collected. These are the person's own words moved into the
    // right boxes, not the assistant's guess at them - which is why they are editable and why
    // nothing is invented for the boxes there is no answer for.
    this.problem = this.outcome || this.handed;
    this.changes = this.handed;
  },

  methods: {
    addCriterion() {
      this.criteria.push('');
    },

    removeCriterion(i) {
      this.criteria.splice(i, 1);
    },

    /**
     * The brief as a document.
     *
     * Markdown because it is going into a git repository next to the code it describes, and
     * because the thing that reads it first is a language model.
     */
    briefMarkdown() {
      const lines = [
        `# ${ this.extension }`,
        '',
        '## The problem',
        this.problem.trim() || '_not stated_',
        '',
        '## Who has it',
        this.who.trim() || '_not stated_',
        '',
        '## What changes for them',
        this.changes.trim() || '_not stated_',
        '',
        '## What we are deliberately not doing',
        this.notDoing.trim() || '_not stated_',
        '',
        '## How we will know it worked',
      ];

      if (this.filledCriteria.length) {
        this.filledCriteria.forEach((c) => lines.push(`- [ ] ${ c }`));
      } else {
        lines.push('_not stated_');
      }

      if (this.placement) {
        lines.push('', '## Where it appears', `Parent route: \`${ this.placement }\``);
      }

      lines.push('', '---', '', 'Written in the Extension Studio before any code existed.');

      return lines.join('\n');
    },

    async agree() {
      if (!this.canAgree) {
        return;
      }

      this.saving = true;

      try {
        await writeExtensionFile(this.extension, 'BRIEF.md', this.briefMarkdown());

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
     * The brief goes with the question, as it stands in the form right now - unsaved, because a
     * question about a draft is about the draft. It goes to the one claude this extension has,
     * so what it answers it answers in that conversation, in the workspace's terminal. This page
     * does not move: the form is full of typing nobody has saved yet, and navigating away from
     * it to show an answer would cost more than the answer is worth. The card says where to
     * find it and offers the door.
     */
    async askWhatIsUnclear() {
      if (this.asking) {
        return;
      }

      this.asking = true;

      try {
        const how = await askAssistant(this.extension, [
          `Here is the draft brief for the ${ this.extension } extension, written before any code exists.`,
          'Read it and tell me only the decisions you cannot make from it - the choices where',
          'guessing would waste the build: empty states, defaults, whether to replace something',
          'or sit beside it. List them as questions. Do not write any code yet.',
          '---',
          this.briefMarkdown(),
        ].join(' '));

        this.asked = how;
        toastSuccess(
          this.$store,
          how === 'sent'
            ? 'The answer arrives in the workspace terminal for this extension.'
            : 'The workspace session is not open yet, so this is the first thing it will be asked when it opens.',
          { title: 'Asked the assistant' }
        );
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'Could not ask the assistant' });
      } finally {
        this.asking = false;
      }
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
        @click="$router.push({ name: STUDIO_ROUTE })"
      />

      <div class="brief__name">
        <div class="brief__title">
          {{ extension }}
        </div>
        <div class="brief__eyebrow">
          Brief · step 1 of 2 before any code is written
        </div>
      </div>

      <SChip label="Draft — not yet agreed" icon="clock" tone="warning" />

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
            </header>
            <div class="brief__card-body">
              <div class="brief__ticket">
                <SIcon name="book" :size="15" />
                <p class="brief__ticket-text">
                  {{ handed || 'Nothing was carried through from the description step.' }}
                </p>
              </div>

              <div v-if="outcome" class="brief__insight">
                <SIcon name="sparkle" :size="15" />
                <p class="brief__insight-text">
                  {{ outcome }}
                </p>
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
                anything — this is your brief, not its.
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
              <h2 class="brief__card-title">
                What the assistant cannot decide
              </h2>
              <p class="brief__card-note">
                The most useful thing on this screen. Ask before you build, not after.
              </p>
            </header>
            <div class="brief__card-body">
              <SBanner type="warning">
                The answer does not appear here. Asking sends this brief, as it stands, to the
                assistant working on <strong>{{ extension }}</strong>, and it replies in that
                extension's terminal in the workspace — where you can argue with it, which is
                the half of this a list on a page cannot do.
              </SBanner>

              <p v-if="asked" class="brief__asked">
                {{ asked === 'sent'
                  ? 'Sent. The answer is being written in the workspace terminal.'
                  : 'The workspace session is not open yet, so this is the first thing it will be asked when it opens.' }}
              </p>

              <div class="brief__card-actions">
                <SButton
                  variant="ghost"
                  size="sm"
                  icon="sparkle"
                  :loading="asking"
                  :disabled="!problem.trim()"
                  @click="askWhatIsUnclear"
                >
                  Ask what is unclear
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
                Nothing to reuse and nothing to collide with — on these words, at least.
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
                  </div>
                </div>
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
              Agreeing writes <code>BRIEF.md</code> into the extension and hands it to the
              assistant as the first thing it reads.
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

  &__insight {
    background: var(--studio-blue-050);
    color:      var(--studio-info);
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
