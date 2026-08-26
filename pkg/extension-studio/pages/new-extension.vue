<script>
// Screen 02 · New extension - describe it (Figma node 13:235).
//
// A single 820px card on a centred canvas. Everything the card asks for is kept and used:
//
//   Real. The name (which is what the extension is actually created as, and is suggested from
//   the description until somebody edits it), the template it starts from, "Import a repo
//   instead" and Create - which creates the extension, writes what
//   was typed here into its BRIEF.md, and writes the placement into its code.
//
//   Two of those used to be promises rather than facts, and both were the same mistake: the
//   answer was collected and then had nowhere to go, because at the moment the button is
//   pressed the pod that would take it is minutes from existing.
//
//     The placement changed no code. Every extension got the base seed's product.ts byte for
//     byte whichever card was chosen, and the decision the screen calls "the single hardest
//     thing to fix later" survived only as one line in BRIEF.md. It is now generated into the
//     seed itself (extension-placement.ts), so the extension really is registered where the
//     card said it would be.
//
//     The two textareas reached BRIEF.md only if the next screen's "Agree and start building"
//     was pressed. Its "Skip the brief" button wrote nothing anywhere, so skipping threw away
//     everything typed here. The brief is now drafted at creation time and seeded with the
//     tree, which is also what screen 10 reads on mount - so skipping loses nothing.
//
//   Recorded rather than asked for. Whoever presses the button is written into the brief as the
//   person who asked, under `## Who asked`, with their Rancher principal id. It is not a
//   question on this form because the answer is already known: at creation the person
//   describing the extension is the person who wants it. Nothing else in the product knew this,
//   and `review.ts` has always refused an outcome sign-off from anybody but the requester - a
//   rule that did nothing at all until something wrote the section it reads. Creation is also
//   the only moment it can be written: the next screen has a "Skip the brief" button.
//
//   The build target is not shown at all: it has one possible value
//   and it is now read rather than typed: the cluster's own name and the Kubernetes version it
//   reports, off Rancher's API. It is not a picker and does not pretend to be one - every pod
//   this Studio creates is created in the `local` cluster, because that is where the Studio's
//   namespace, its service proxy and every path in `extensions.ts` are - so a list of other
//   clusters would be a list of places the build cannot go. The line under it says so, and it
//   reads the cluster list to say it, so "there is nothing else to choose" is a reading rather
//   than an assertion and stops being one the day this Rancher gains a second cluster. The
//   reassurance the design puts there - changes only ever run here until you publish - is the
//   same sentence either way.
import {
  SButton, SField
} from '../components/ui';
import ImportExtensionModal from '../components/ImportExtensionModal.vue';
import { toastError } from '../toast';
import {
  ensureExtension, normalizeExtensionName, BUILT_IN_SEEDS, DEFAULT_SEED
} from '../extensions';
import { currentSigner } from '../review';
import {
  PLACEMENTS, placementById, placementFiles, normalizeResource
} from '../extension-placement';
import {
  STUDIO_ROUTE, BRIEF_ROUTE, STUDIO_PAGE_ACTIONS, handleStudioPageAction
} from '../editor-product';
import pageActionsMixin from '@shell/mixins/page-actions';
import '../design/tokens';
import fullBleed from '../design/full-bleed';

const EXAMPLES = [
  'a cost report per namespace',
  'a Longhorn volume health tab',
  'a fleet drift dashboard',
];

export default {
  name: 'BarnNewExtension',

  components: {
    SButton, SField, ImportExtensionModal
  },

  mixins: [fullBleed, pageActionsMixin],

  data() {
    return {
      prompt:    '',
      outcome:   '',
      placement: 'cluster',
      // Which resource's detail page the tab attaches to, asked only when "On a resource" is
      // chosen. The design does not draw this question, but the placement it describes cannot
      // be written without an answer to it - a tab has to be a tab on something.
      resource:  'node',
      name:      '',
      // Whether the name has been typed rather than suggested. Once it has, the suggestion
      // stops overwriting it - a name that keeps changing under the cursor is maddening.
      nameEdited: false,
      seed:       DEFAULT_SEED,
      importing:  false,
      creating:   false,
      error:      '',
      // Where the build runs, read from Rancher rather than written into the template. Starts
      // as the cluster's id, which is true before the reading arrives and stays true if it
      // never does.
      // How many other clusters this Rancher manages, which is what decides whether the line
      // under the box is a statement about a choice or about the absence of one. `null` until
      // the reading arrives, and if it never does the line says nothing it cannot back.
    };
  },

  computed: {
    placements() {
      return PLACEMENTS;
    },

    /** True while the card that needs a follow-up question is the selected one. */
    asksResource() {
      return !!placementById(this.placement).asksResource;
    },

    /**
     * What Rancher's header kebab offers on this screen (Figma 53:1430).
     *
     * Read by @shell/mixins/page-actions, which commits it on `created` and clears it on
     * `beforeUnmount`, so the menu is this page's rather than every page in Rancher's. The
     * list lives in editor-product.ts; see the note there for why these three.
     */
    pageActions() {
      return STUDIO_PAGE_ACTIONS;
    },

    /** One of the header kebab's items was chosen. Dispatched here by the same mixin. */
    handlePageAction(action) {
      handleStudioPageAction(this, action);
    },

    /**
     * Make the extension, then go and agree the brief.
     *
     * The extension is created here rather than on the brief screen because everything after
     * this point - the brief, the workspace, the preview - is a view of a pod, and the pod
     * takes minutes to compile the first time. Starting it now means those minutes overlap
     * with the brief rather than following it.
     *
     * Which is also why the answers go in through the seed rather than through the pod. There
     * is no pod yet to write a file into, and both things this form collects have to survive
     * to the tree whatever the next screen does with them: the placement is code, and the two
     * textareas are the brief, which the next screen has a button that skips.
     */
    async submit() {
      if (!this.canSubmit) {
        return;
      }

      this.creating = true;
      this.error = '';

      const name = normalizeExtensionName(this.name);
      const spec = placementById(this.placement);
      // Who to record as having asked. `currentSigner` rather than a second reading of
      // Rancher's user API, so the principal in the brief is the exact string `signOutcome`
      // compares against later - two derivations of "who am I" are two chances to disagree,
      // and the gate would then refuse the person it was written for. It throws when Rancher
      // will not say; that is not a reason to fail the creation, and a brief with no
      // `## Who asked` reads back as "the requester was never recorded", which is true.
      const asked = await currentSigner().catch(() => null);
      const plan = {
        name,
        placement: this.placement,
        resource:  normalizeResource(this.resource),
        prompt:    this.prompt.trim(),
        outcome:   this.outcome.trim(),
        asked,
      };

      try {
        await ensureExtension(name, this.seed, placementFiles(plan, this.seed));

        this.$router.push({
          name:   BRIEF_ROUTE,
          params: { extension: name },
          query:  {
            prompt:    plan.prompt,
            outcome:   plan.outcome,
            placement: spec.route,
          },
        });
      } catch (e) {
        this.error = e?.message || String(e);
        toastError(this.$store, 'Could not create the extension', this.error);
        this.creating = false;
      }
    },

    onImported({ name, source, done }) {
      this.importing = false;
      ensureExtension(name, source)
        .then(() => {
          done(true);
          this.$router.push({ name: STUDIO_ROUTE });
        })
        .catch((e) => {
          done(false);
          this.error = e?.message || String(e);
        });
    },
  },
};
</script>

<template>
  <div class="new-ext">
    <div class="new-ext__wrap">
      <div class="new-ext__card">
        <!-- head (13:308) -->
        <div class="new-ext__head">
          <h1 class="new-ext__title">
            New extension
          </h1>
          <p class="new-ext__lede">
            Name it and say where it goes. The assistant writes the code, runs it against this
            Rancher, and shows you the result before anything is shared - and what it should do
            is the first thing you ask it, in the conversation.
          </p>
        </div>

        <!-- where (13:324) -->
        <div class="new-ext__section">
          <div class="new-ext__section-head">
            <span class="new-ext__label">Where should it appear?</span>
            <span class="new-ext__hint">
              This decides the parent route - the single hardest thing to fix later.
            </span>
          </div>
          <div class="new-ext__options">
            <button
              v-for="opt in placements"
              :key="opt.id"
              type="button"
              class="new-ext__option"
              :class="{ 'new-ext__option--selected': placement === opt.id }"
              :aria-pressed="placement === opt.id"
              :data-testid="`new-ext-placement-${ opt.id }`"
              @click="placement = opt.id"
            >
              <span class="new-ext__option-row">
                <span class="new-ext__radio" :class="{ 'new-ext__radio--on': placement === opt.id }" />
                <span class="new-ext__option-label">{{ opt.label }}</span>
              </span>
              <span class="new-ext__option-note">{{ opt.note }}</span>
            </button>
          </div>

          <!--
            The follow-up the promise implies. A tab has to be a tab on something, and until
            this was asked the answer was guessed at write time - which is the one thing this
            product does not do.
          -->
          <div v-if="asksResource" class="new-ext__follow">
            <div class="new-ext__box">
              <span class="new-ext__box-label">On which resource?</span>
              <!--
                A plain input rather than SField: the test id has to sit on the control the
                verifier types into, and SField has no way to pass one through to its own
                input - an attribute given to it lands on its wrapper div instead.
              -->
              <input
                v-model="resource"
                class="new-ext__box-input"
                placeholder="node"
                aria-label="On which resource?"
                data-testid="new-ext-resource"
              >
            </div>
            <span class="new-ext__hint">
              The Kubernetes type whose detail page carries the tab - node, pod,
              apps.deployment
            </span>
          </div>
        </div>

        <!-- details (13:366) -->
        <div class="new-ext__details">
          <SField
            :model-value="name"
            label="Name"
            placeholder="node-health-panel"
            hint="What the package and its route are called - editable"
            @update:model-value="onNameInput"
          />
        </div>

        <!-- footer (13:384) -->
        <div class="new-ext__footer">
          <span v-if="error" class="new-ext__error">{{ error }}</span>


          <div class="new-ext__buttons">
            <SButton variant="ghost" @click="cancel">
              Cancel
            </SButton>
            <SButton variant="neutral" icon="github" @click="importing = true">
              Import a repo instead
            </SButton>
            <SButton
              variant="primary"
              icon="sparkle"
              :loading="creating"
              :disabled="!canSubmit"
              @click="submit"
            >
              Create
            </SButton>
          </div>
        </div>
      </div>
    </div>

    <ImportExtensionModal
      v-if="importing"
      @close="importing = false"
      @create="onImported"
    />

  </div>
</template>

<style lang="scss" scoped>
.new-ext {
  height:     100%;
  overflow-y: auto;
  background: var(--studio-surface);

  &__wrap {
    display:         flex;
    justify-content: center;
    padding:         14px var(--studio-space-24);
  }

  &__card {
    display:        flex;
    flex-direction: column;
    width:          820px;
    max-width:      100%;
    background:     var(--studio-surface);
    border:         1px solid var(--studio-border);
    border-radius:  var(--studio-radius);
    box-shadow:     0 2px 8px rgba(0, 0, 0, 0.06);
  }

  &__head {
    display:        flex;
    flex-direction: column;
    gap:            6px;
    padding:        var(--studio-space-20) 28px 14px;
  }

  &__title {
    font:           var(--studio-heading-24);
    letter-spacing: var(--studio-tracking-heading);
    color:          var(--studio-text);
    margin:         0;
  }

  &__lede {
    font:   var(--studio-body-14);
    color:  var(--studio-text-secondary);
    margin: 0;
  }

  &__follow {
    // The question only exists while one card is selected, so it sits under the row of cards
    // rather than in the grid with them - it belongs to the answer above it.
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-4);
    margin-top:     var(--studio-space-4);
    max-width:      420px;
  }

  &__section {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-8);
    padding:        22px 28px 0;

    &--tight { padding-top: 0; }
    &--row   { padding-top: 18px; }
  }

  &__section-head {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
    flex-wrap:   wrap;
  }

  &__label {
    font:  var(--studio-heading-14);
    color: var(--studio-text);
  }

  &__hint {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  // The design draws this field already focused, which is the state it is in when the screen
  // opens - so it keeps the 2px blue border rather than only taking it on focus.
  &__prompt {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-6);
    padding:       var(--studio-space-12) 14px;
    background:    var(--studio-surface);
    border:        2px solid var(--studio-border-focus);
    border-radius: var(--studio-radius);
  }

  &__prompt-input {
    width:      100%;
    border:     none;
    outline:    none;
    background: transparent;
    padding:    0;
    resize:     vertical;
    font:       var(--studio-body-16);
    color:      var(--studio-text);

    &::placeholder { color: var(--studio-text-tertiary); }
  }

  &__examples {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
    flex-wrap:   wrap;
  }

  &__example {
    padding:       var(--studio-space-4) 9px;
    border:        none;
    border-radius: var(--studio-radius-pill);
    background:    var(--studio-blue-050);
    color:         var(--studio-blue-600);
    font:          var(--studio-caption-12);
    cursor:        pointer;

    &:hover { background: var(--studio-info-bg); }
  }

  &__box {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-2);
    padding:        9px var(--studio-space-12);
    background:     var(--studio-surface);
    border:         1px solid var(--studio-border);
    border-radius:  var(--studio-radius-control);

    &--static { padding: var(--studio-space-8) var(--studio-space-12); }

    &:focus-within { border-color: var(--studio-border-focus); }
  }

  &__box-input {
    width:      100%;
    border:     none;
    outline:    none;
    background: transparent;
    padding:    0;
    resize:     vertical;
    font:       var(--studio-body-14);
    color:      var(--studio-text);

    &::placeholder { color: var(--studio-text-tertiary); }
  }

  &__box-label {
    font:  var(--studio-caption-12);
    color: var(--studio-text-secondary);
  }

  &__box-value {
    font:  var(--studio-body-14);
    color: var(--studio-text);
  }

  &__note {
    display:     flex;
    align-items: flex-start;
    gap:         7px;
    font:        var(--studio-caption-12);
    color:       var(--studio-text-secondary);

    :deep(.s-icon) {
      color:      var(--studio-info);
      margin-top: 1px;
    }
  }

  // A grid, not a flex row.
  //
  // Four cards had to share whatever width the card gave them, and as a flex row they did not:
  // a flex item will not shrink below its own content, so the longest note in them ("A new tab
  // on a resource detail page") set a floor and the row ran off the right edge. Giving them a
  // basis to wrap at fixed the overflow and made the wrapping lumpy - three on one line, one
  // on the next, widths differing by whatever their text happened to need.
  //
  // `auto-fit` with a `minmax` floor says the thing that was actually meant: as many equal
  // columns as fit at eleven rem or wider, and the rest wrap. The columns are equal by
  // construction rather than by every card happening to hold a similar sentence.
  &__options {
    display:               grid;
    grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
    gap:                   10px;
  }

  &__option {
    display:        flex;
    flex-direction: column;
    gap:            5px;
    // A grid item's `min-width` is `auto` too, so without this the column floor is the card's
    // longest line rather than the 11rem the grid was told.
    min-width:      0;
    padding:        11px var(--studio-space-12);
    text-align:     left;
    background:     var(--studio-surface);
    border:         1px solid var(--studio-border);
    border-radius:  var(--studio-radius);
    cursor:         pointer;

    &:hover { border-color: var(--studio-border-strong); }

    // The selected card is a 2px green border in the design (13:329). The negative margin
    // is what keeps that from reflowing the row: the extra pixel of border on each side is
    // taken back off the outer box, so the card grows inward and its neighbours do not move.
    &--selected,
    &--selected:hover {
      background:   var(--studio-green-050);
      border-color: var(--studio-green-500);
      border-width: 2px;
      margin:       -1px;
    }
  }

  &__option-row {
    display:     flex;
    align-items: center;
    gap:         7px;
  }

  &__radio {
    width:         13px;
    height:        13px;
    flex:          0 0 13px;
    border:        1px solid var(--studio-border-strong);
    border-radius: var(--studio-radius-pill);
    background:    var(--studio-surface);

    &--on {
      border-color: var(--studio-green-500);
      border-width: 4px;
    }
  }

  &__option-label {
    font:      var(--studio-heading-14);
    color:     var(--studio-text);
    // The label sits beside a radio in a flex row, so it needs its own floor removed too.
    min-width: 0;
  }

  &__option-note {
    font:          var(--studio-caption-12);
    color:         var(--studio-text-secondary);
    // Prose: it wraps rather than setting the card's width.
    overflow-wrap: anywhere;
  }

  &__field {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-4);
  }

  &__git {
    display:       flex;
    align-items:   center;
    gap:           10px;
    flex:          1 1 auto;
    padding:       10px var(--studio-space-12);
    background:    var(--studio-surface-subtle);
    border:        1px solid var(--studio-border-subtle);
    border-radius: var(--studio-radius);
    color:         var(--studio-text-tertiary);
  }

  &__git-text {
    flex:  1 1 auto;
    font:  var(--studio-caption-12);
    color: var(--studio-text-secondary);
  }

  &__details {
    display: flex;
    gap:     14px;
    padding: 22px 28px 0;

    > * { flex: 1 1 0; }
  }

  &__footer {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-12);
    padding:        var(--studio-space-16) 28px 18px;
  }

  &__buttons {
    display:         flex;
    justify-content: flex-end;
    align-items:     center;
    gap:             10px;
  }

  &__error {
    font:  var(--studio-caption-12);
    color: var(--studio-error);
  }
}
</style>
