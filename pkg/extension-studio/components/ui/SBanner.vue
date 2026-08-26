<script>
// The design's Banner (Figma component set 4:51).
//
// Four types, each a `status/*-bg` wash with a 4px `status/*` bar down the left edge and no
// border of its own. The bar is the whole identity of the component - it is why the padding in
// the set is `12px 16px 12px 0`, with the zero on the left so the bar sits flush.
import SIcon from './SIcon.vue';
import SButton from './SButton.vue';

const ICONS = {
  info:    'info',
  success: 'check',
  warning: 'warning',
  error:   'error',
};

export default {
  name: 'SBanner',

  components: { SIcon, SButton },

  props: {
    /** info | success | warning | error */
    type: {
      type:      String,
      default:   'info',
      validator: (v) => ['info', 'success', 'warning', 'error'].includes(v),
    },

    /** The message. The default slot overrides it when the text needs markup. */
    message: {
      type:    String,
      default: '',
    },

    /** The set draws no icon; screens that want one opt in. */
    withIcon: {
      type:    Boolean,
      default: false,
    },

    /** Adds a close control on the right. */
    closable: {
      type:    Boolean,
      default: false,
    },
  },

  emits: ['close'],

  computed: {
    icon() {
      return ICONS[this.type] || 'info';
    },
  },
};
</script>

<template>
  <div class="s-banner" :class="`s-banner--${ type }`">
    <span class="s-banner__bar" />

    <SIcon
      v-if="withIcon"
      :name="icon"
      :size="16"
      class="s-banner__icon"
    />

    <div class="s-banner__body">
      <slot>{{ message }}</slot>
    </div>

    <div v-if="$slots.actions" class="s-banner__actions">
      <slot name="actions" />
    </div>

    <SButton
      v-if="closable"
      variant="ghost"
      size="sm"
      icon="close"
      icon-only
      class="s-banner__close"
      @click="$emit('close')"
    />
  </div>
</template>

<style lang="scss" scoped>
.s-banner {
  display:       flex;
  align-items:   flex-start;
  gap:           var(--studio-space-12);
  padding:       var(--studio-space-12) var(--studio-space-16) var(--studio-space-12) 0;
  border-radius: var(--studio-radius-control);
  font:          var(--studio-body-13);
  color:         var(--studio-text);
  overflow:      hidden;

  &__bar {
    align-self: stretch;
    width:      4px;
    flex:       0 0 4px;
    background: currentColor;
  }

  // The bar and the icon take the type's hue; the body text stays primary so the
  // message reads as text rather than as a coloured alert.
  &__icon { margin-top: 1px; }

  &__body {
    flex:      1 1 auto;
    min-width: 0;
    color:     var(--studio-text);
  }

  &__actions {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
    flex:        0 0 auto;
  }

  &__close {
    margin: -4px -6px 0 0;
  }

  &--info    { background: var(--studio-info-bg); color: var(--studio-info); }
  &--success { background: var(--studio-success-bg); color: var(--studio-success); }
  &--warning { background: var(--studio-warning-bg); color: var(--studio-warning); }
  &--error   { background: var(--studio-error-bg); color: var(--studio-error); }
}
</style>
