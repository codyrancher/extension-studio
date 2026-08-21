<script>
// One line of a list or table.
//
// The density spec is the whole content of this component: "Rows are 11-14px of vertical
// padding, not 20 - matching it matters more than breathing room", and "11px vertical padding,
// 1px subtle divider". Getting that wrong by 9px on every row is what makes a concept look
// like it belongs in a different product.
export default {
  name: 'SRow',

  props: {
    selectable: {
      type:    Boolean,
      default: false,
    },

    selected: {
      type:    Boolean,
      default: false,
    },

    /** Drops the divider, for the last row or a standalone one. */
    divider: {
      type:    Boolean,
      default: true,
    },
  },

  emits: ['click'],
};
</script>

<template>
  <component
    :is="selectable ? 'button' : 'div'"
    class="s-row"
    :class="{
      's-row--selectable': selectable,
      's-row--selected': selected,
      's-row--divider': divider,
    }"
    :type="selectable ? 'button' : null"
    @click="selectable && $emit('click', $event)"
  >
    <slot />
  </component>
</template>

<style lang="scss" scoped>
.s-row {
  display:     flex;
  align-items: center;
  gap:         var(--studio-space-8);
  padding:     var(--studio-row-pad-y) var(--studio-row-pad-x);
  width:       100%;
  text-align:  left;
  background:  none;
  border:      none;
  color:       var(--studio-text);
  font:        var(--studio-body-14);
  min-width:   0;

  &--divider { border-bottom: 1px solid var(--studio-border-subtle); }

  &--selectable {
    cursor: pointer;

    &:hover { background: var(--studio-surface-subtle); }
  }

  &--selected {
    background:  var(--studio-green-050);
    box-shadow:  inset 2px 0 0 var(--studio-green-500);
  }
}
</style>
