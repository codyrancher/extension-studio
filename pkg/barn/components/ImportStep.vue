<script>
// One numbered step of the import wizard (Figma 15:540 in screen 06, 15:640 in 06a).
//
// A 22px round marker and a heading, with whatever the step asks for underneath. The marker
// carries the whole of the progress the design draws, in three states:
//
//   done   - a solid green check. The step is satisfied and nothing in it needs answering.
//   active - a blue disc with the step's number. Open for input.
//   locked - a flat grey disc with a grey number, and a grey heading. Not reachable yet, and
//            drawn collapsed rather than as a disabled copy of its contents, because the
//            design swaps the content out rather than dimming it.
//
// Only used by ImportExtensionModal today, which is why it lives beside it rather than in
// components/ui: it is one screen's wizard chrome, not a primitive the product repeats.
import SIcon from './ui/SIcon.vue';

export default {
  name: 'ImportStep',

  components: { SIcon },

  props: {
    /** The digit in the marker, and the number the heading is announced with. */
    index: {
      type:     Number,
      required: true,
    },

    /** done | active | locked */
    state: {
      type:      String,
      default:   'active',
      validator: (v) => ['done', 'active', 'locked'].includes(v),
    },

    title: {
      type:     String,
      required: true,
    },
  },
};
</script>

<template>
  <section
    class="import-step"
    :class="`import-step--${ state }`"
    :data-testid="`barn-import-step-${ index }`"
    :data-state="state"
  >
    <div class="import-step__marker" aria-hidden="true">
      <SIcon v-if="state === 'done'" name="check" :size="13" />
      <template v-else>{{ index }}</template>
    </div>

    <div class="import-step__body">
      <h3 class="import-step__title">
        <span class="import-step__count">Step {{ index }}.</span> {{ title }}
      </h3>

      <div v-if="state !== 'locked' || $slots.locked" class="import-step__content">
        <slot v-if="state === 'locked'" name="locked" />
        <slot v-else />
      </div>
    </div>
  </section>
</template>

<style lang="scss" scoped>
.import-step {
  display:               grid;
  grid-template-columns: 22px 1fr;
  gap:                   var(--studio-space-12);
  align-items:           start;

  &__marker {
    display:         flex;
    align-items:     center;
    justify-content: center;
    width:           22px;
    height:          22px;
    border-radius:   var(--studio-radius-pill);
    font:            var(--studio-caption-12-semi);
    // The digit is optically low in a disc when it sits on the text baseline.
    line-height:     1;
    background:      var(--studio-blue-500);
    color:           var(--studio-text-inverse);
  }

  &--done &__marker {
    background: var(--studio-success);
    color:      var(--studio-on-success);
  }

  &--locked &__marker {
    background: var(--studio-neutral-bg);
    color:      var(--studio-text-tertiary);
  }

  &__body {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-8);
    // Without this a long branch name or a wide select stretches the grid column instead of
    // wrapping, and the dialog grows past the 680px the design draws.
    min-width:      0;
  }

  &__title {
    font:        var(--studio-body-13-semi);
    color:       var(--studio-text);
    margin:      0;
    // The marker is 22px and the heading is 13px; centring the text on the marker is what
    // stops the row reading as a hanging indent.
    line-height: 22px;
  }

  &--locked &__title { color: var(--studio-text-tertiary); }

  // "Step 2." is for a screen reader and for anybody scanning the left column; the marker
  // repeats it visually, so it is not drawn twice.
  &__count {
    position: absolute;
    width:    1px;
    height:   1px;
    overflow: hidden;
    clip:     rect(0 0 0 0);
  }

  &__content {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-8);
  }
}
</style>
