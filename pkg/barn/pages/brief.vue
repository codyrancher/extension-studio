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
// Placeholder. The two cards on the right. "What the assistant cannot decide" would need the
// assistant to have read the brief and formed questions about it, and "This already exists,
// partly" would need a search across the extensions and pages on this instance. Both are drawn
// with what they would hold and say so, rather than inventing questions nobody asked.
import {
  SButton, SChip, SIcon, SBanner, SField, SLabel
} from '../components/ui';
import { toastNotYet, toastError } from '../toast';
import { writeExtensionFile, DEFAULT_EXTENSION } from '../extensions';
import { EDITOR_ROUTE, STUDIO_ROUTE } from '../editor-product';
import '../design/tokens';
import fullBleed from '../design/full-bleed';

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

    notYet(what) {
      toastNotYet(this.$store, what);
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
        variant="neutral"
        size="sm"
        icon="arrowRight"
        @click="notYet('sending the open questions to the requester')"
      >
        Send questions to the requester
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
                The most useful thing on this screen. Send these before you build, not after.
              </p>
            </header>
            <div class="brief__card-body">
              <SBanner type="warning">
                The assistant does not yet read the brief and come back with questions about it.
                When it does, the things it cannot decide for you — an empty state, a default
                window, whether to replace something or sit beside it — are listed here for you
                to answer or forward.
              </SBanner>
              <SButton
                variant="ghost"
                size="sm"
                icon="sparkle"
                @click="notYet('asking the assistant what it cannot decide')"
              >
                Ask what is unclear
              </SButton>
            </div>
          </section>

          <!-- This already exists, partly (34:1139) -->
          <section class="brief__card">
            <header class="brief__card-head">
              <h2 class="brief__card-title">
                This already exists, partly
              </h2>
              <p class="brief__card-note">
                Checked against every extension and Rancher page on this instance.
              </p>
            </header>
            <div class="brief__card-body">
              <SBanner type="info">
                Nothing searches this Rancher for prior art yet. When it does, the pages and
                extensions that already do part of this appear here, so the brief can say what
                is genuinely new.
              </SBanner>
              <SButton
                variant="ghost"
                size="sm"
                icon="search"
                @click="notYet('the prior-art search')"
              >
                Look for prior art
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
