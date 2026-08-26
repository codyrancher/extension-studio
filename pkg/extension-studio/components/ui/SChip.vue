<script>
// The small bordered chip the screens use for context, filters and inline state.
//
// Not a component in the Figma file - it is drawn inline on several screens (the composer's
// context chips at 11:320, the session status row's "Ask before each file edit" at 11:226, the
// masthead's phase chip) with identical geometry each time: 4/8 padding, 6px gap, 3px radius,
// 1px border, Caption/12. Same shape three times is a component.
import SIcon from './SIcon.vue';

export default {
  name: 'SChip',

  components: { SIcon },

  props: {
    label: {
      type:    String,
      default: '',
    },

    icon: {
      type:    String,
      default: '',
    },

    /** default | subtle | info | success | warning | error */
    tone: {
      type:    String,
      default: 'default',
    },

    /** Draws an x on the right and emits `remove`. */
    removable: {
      type:    Boolean,
      default: false,
    },

    /** Makes it a button rather than a span. */
    clickable: {
      type:    Boolean,
      default: false,
    },
  },

  emits: ['click', 'remove'],
};
</script>

<template>
  <component
    :is="clickable ? 'button' : 'span'"
    class="s-chip"
    :class="[`s-chip--${ tone }`, { 's-chip--clickable': clickable }]"
    :type="clickable ? 'button' : null"
    @click="clickable && $emit('click', $event)"
  >
    <SIcon v-if="icon" :name="icon" :size="13" />
    <span class="s-chip__label"><slot>{{ label }}</slot></span>
    <SIcon
      v-if="removable"
      name="close"
      :size="12"
      class="s-chip__remove"
      @click.stop="$emit('remove')"
    />
  </component>
</template>

<style lang="scss" scoped>
.s-chip {
  display:       inline-flex;
  align-items:   center;
  box-sizing:    border-box;
  gap:           6px;
  padding:       var(--studio-space-4) var(--studio-space-8);
  border:        1px solid var(--studio-border);
  border-radius: var(--studio-radius-control);
  background:    var(--studio-surface);
  color:         var(--studio-text-secondary);
  font:          var(--studio-caption-12);
  white-space:   nowrap;

  // A clickable chip is a <button>, and the shell floors every button in the dashboard:
  //
  //   .btn, button, [class^='btn-'] { line-height: 40px; min-height: 40px; }
  //
  // (global/_button.scss, on a bare element selector). So the one chip in a row that happened
  // to be clickable came out 40px tall beside four 24px spans - the same failure the action
  // bar had. Both properties are restated here so a chip is the same size whichever element
  // it renders as. `line-height` after the `font` shorthand, which carries its own.
  min-height:    0;
  line-height:   1.3333;

  &--subtle  { background: var(--studio-surface-subtle); }
  &--info    { background: var(--studio-info-bg); border-color: transparent; color: var(--studio-blue-600); }
  &--success { background: var(--studio-success-bg); border-color: transparent; color: var(--studio-success); }
  &--warning { background: var(--studio-warning-bg); border-color: transparent; color: var(--studio-warning); }
  &--error   { background: var(--studio-error-bg); border-color: transparent; color: var(--studio-error); }

  &--clickable {
    cursor: pointer;

    &:hover {
      background:   var(--studio-surface-subtle);
      border-color: var(--studio-border-strong);
      color:        var(--studio-text);
    }
  }

  &__remove {
    cursor:  pointer;
    opacity: 0.6;

    &:hover { opacity: 1; }
  }
}
</style>
