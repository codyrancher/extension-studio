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
      :size="size === 'sm' ? 13 : 14"
      class="s-btn__spin"
    />
    <SIcon
      v-else-if="icon"
      :name="icon"
      :size="size === 'sm' ? 13 : 14"
    />

    <span v-if="!iconOnly" class="s-btn__label"><slot /></span>
  </button>
</template>

<style lang="scss" scoped>
.s-btn {
  display:         inline-flex;
  align-items:     center;
  justify-content: center;
  gap:             var(--studio-space-8);
  padding:         var(--studio-space-8) var(--studio-space-16);
  border:          1px solid transparent;
  border-radius:   var(--studio-radius);
  font:            var(--studio-heading-14);
  cursor:          pointer;
  white-space:     nowrap;
  transition:      background-color 0.1s ease, border-color 0.1s ease, color 0.1s ease;

  &--sm {
    padding: 5px 11px;
    gap:     7px;
  }

  &--icon-only {
    padding: var(--studio-space-8);

    &.s-btn--sm {
      padding: 5px;
    }
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
  &--neutral {
    background:   var(--studio-surface);
    border-color: var(--studio-border-strong);
    color:        var(--studio-text);

    &:hover:not(:disabled) { background: var(--studio-surface-subtle); }
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
