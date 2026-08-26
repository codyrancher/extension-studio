<script>
// The design's Button (Figma component set 3:17).
//
// Its description is the rule the variants encode: "Primary = the one committing action per
// view. Secondary = green-outlined alternate. Neutral = cancel/dismiss. Ghost = inline/toolbar."
// Danger is the fifth variant in the set.
//
// This is deliberately not `RcButton` from the shell. The design gives these their own padding,
// radius and type ramp, and wrapping RcButton to override all three leaves a component that
// fights its own base stylesheet on every screen. Where a screen wants Rancher's button rather
// than the Studio's, it should import RcButton directly and mean it.
import SIcon from './SIcon.vue';

export default {
  name: 'SButton',

  components: { SIcon },

  props: {
    /** primary | secondary | neutral | danger | ghost */
    variant: {
      type:      String,
      default:   'neutral',
      validator: (v) => ['primary', 'secondary', 'neutral', 'danger', 'ghost'].includes(v),
    },

    /** An icon name from SIcon, drawn before the label. */
    icon: {
      type:    String,
      default: '',
    },

    /** Renders the icon with no label, squared off. For toolbars. */
    iconOnly: {
      type:    Boolean,
      default: false,
    },

    /** Swaps the icon for a spinner and blocks the click. */
    loading: {
      type:    Boolean,
      default: false,
    },

    disabled: {
      type:    Boolean,
      default: false,
    },

    /** `sm` matches the toolbar rows, which are tighter than the 8/16 the set draws. */
    size: {
      type:      String,
      default:   'md',
      validator: (v) => ['sm', 'md'].includes(v),
    },

    /**
     * Override the glyph size, for the few places the design draws a bare icon at a size of
     * its own rather than a button's icon. The masthead's back arrow and kebab are both
     * icon/16 in the file (9:178, 9:227) while a button's icon is 15.
     */
    iconSize: {
      type:    Number,
      default: 0,
    },

    type: {
      type:    String,
      default: 'button',
    },
  },

  emits: ['click'],

  computed: {
    inert() {
      return this.disabled || this.loading;
    },

    /**
     * The glyph size. 15 at `sm` is the file's own measurement - layout_FNBL51, on all three
     * masthead buttons. It used to be 13, which is the chip's size, so the action bar drew a
     * glyph two pixels small beside a 14px label.
     */
    glyph() {
      return this.iconSize || (this.size === 'sm' ? 15 : 14);
    },
  },

  methods: {
    onClick(e) {
      if (this.inert) {
        return;
      }

      this.$emit('click', e);
    },
  },
};
</script>

<template>
  <button
    :type="type"
    class="s-btn"
    :class="[
      `s-btn--${ variant }`,
      `s-btn--${ size }`,
      { 's-btn--icon-only': iconOnly, 's-btn--loading': loading },
    ]"
    :disabled="inert"
    @click="onClick"
  >
    <SIcon
      v-if="loading"
      name="spinner"
      :size="glyph"
      class="s-btn__spin"
    />
    <SIcon
      v-else-if="icon"
      :name="icon"
      :size="glyph"
    />

    <span v-if="!iconOnly" class="s-btn__label"><slot /></span>
  </button>
</template>

<style lang="scss" scoped>
.s-btn {
  display:         inline-flex;
  align-items:     center;
  justify-content: center;
  // The height below is a border-box height, so a bordered variant is the same height as a
  // ghost one rather than two pixels taller.
  box-sizing:      border-box;
  gap:             var(--studio-space-8);
  padding:         var(--studio-space-8) var(--studio-space-16);
  border:          1px solid transparent;
  border-radius:   var(--studio-radius);
  font:            var(--studio-heading-14);
  // Both of these exist to beat the shell's own button rule, which is
  //
  //   .btn, button, [class^='btn-'] { line-height: 40px; min-height: 40px; }
  //
  // in global/_button.scss, on a bare element selector, so it applies to every button this
  // design system draws. `min-height` wins over `height` whatever the height says, so until
  // this was here a Studio button was 40px tall no matter what it was told - which is why
  // successive attempts to shrink the action bar changed its width and never its height.
  //
  // `min-height: 0` on the base rather than a number, so a size class is free to state its
  // own; the class selectors below beat the element selector on specificity.
  min-height:      0;
  cursor:          pointer;
  white-space:     nowrap;
  transition:      background-color 0.1s ease, border-color 0.1s ease, color 0.1s ease;

  // The file's Button, measured off 9:177 in dev mode: content 68x20, padding 5px 11px,
  // gap 7px, radius 4px. 20 + 5 + 5 is the 30px below.
  //
  // Stated as a height rather than as vertical padding, and with `min-height` beside it, for
  // the reason in the base rule above: the shell floors every button at 40px, and a padding
  // that adds up to 30 loses to it silently. A border-box height with the label centred is
  // the same 30px the file draws and cannot be floored.
  &--sm {
    height:     var(--studio-control-sm, 30px);
    min-height: var(--studio-control-sm, 30px);
    padding:    0 11px;
    gap:        7px;
  }

  &--icon-only {
    padding: var(--studio-space-8);

    // Square, so a toolbar of icons is a row of equal boxes.
    &.s-btn--sm {
      width:   var(--studio-control-sm, 30px);
      padding: 0;
    }

    &.s-btn--md { min-height: 0; }
  }

  &:disabled {
    opacity: 0.5;
    cursor:  not-allowed;
  }

  // Primary: the one committing action per view.
  &--primary {
    background: var(--studio-green-500);
    color:      var(--studio-text-inverse);

    &:hover:not(:disabled) { background: var(--studio-green-600); }
    &:active:not(:disabled) { background: var(--studio-green-700); }
  }

  // Secondary: green-outlined alternate.
  &--secondary {
    background:   var(--studio-surface);
    border-color: var(--studio-green-500);
    color:        var(--studio-green-600);

    &:hover:not(:disabled) { background: var(--studio-green-050); }
  }

  // Neutral: cancel/dismiss.
  //
  // The quietest of the two bordered variants, and it has to stay quieter than whatever it
  // sits beside - the set's description makes it the dismissive one, so it is never the thing
  // a screen is for. It was not: on the border/strong tier with body ink it outweighed the
  // control it accompanies, worst on 13-verify where "Show me" (a placeholder that raises a
  // toast) shouted over the verdict segments the whole screen exists to collect. That is our
  // reading of Button/Neutral rather than the frame's - 3:17 strokes #B4B5BE, and
  // --studio-border-strong is the tier *past* it: #909199 in Rancher's light theme, and in
  // dark it mixes toward the near-white body text and comes out at #84878E, 4.1:1 against
  // the panel - a stronger edge than the design draws anywhere (3:17's own is 2.04:1 on the
  // page it sits on, and --studio-border is 1.34 light / 1.41 dark).
  //
  // So: the default border tier, and secondary ink. Still a bordered button, no longer a loud
  // one, and the label clears 4.5:1 in both themes (4.86 light, 4.62 dark).
  &--neutral {
    background:   var(--studio-surface);
    border-color: var(--studio-border);
    color:        var(--studio-text-secondary);

    &:hover:not(:disabled) {
      background:   var(--studio-surface-subtle);
      border-color: var(--studio-border-strong);
      color:        var(--studio-text);
    }
  }

  &--danger {
    background: var(--studio-error);
    color:      var(--studio-text-inverse);

    &:hover:not(:disabled) { filter: brightness(0.93); }
  }

  // Ghost: inline/toolbar.
  &--ghost {
    background: transparent;
    color:      var(--studio-text-secondary);

    &:hover:not(:disabled) {
      background: var(--studio-surface-subtle);
      color:      var(--studio-text);
    }
  }

  &__spin {
    animation: s-btn-spin 0.9s linear infinite;
  }
}

@keyframes s-btn-spin {
  to { transform: rotate(360deg); }
}
</style>
