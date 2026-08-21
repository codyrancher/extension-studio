<script>
// The horizontal strip above a panel's content: the preview toolbar (9:234), the files
// header, the review filters. Row, 8/12 padding, 8px gap, divider underneath.
export default {
  name: 'SToolbar',

  props: {
    /** subtle draws it on the sunken surface, which is what the session status row uses. */
    surface: {
      type:    String,
      default: 'surface',
    },

    border: {
      type:    String,
      default: 'bottom',
    },
  },
};
</script>

<template>
  <div
    class="s-toolbar"
    :class="[`s-toolbar--${ surface }`, `s-toolbar--border-${ border }`]"
  >
    <slot />
  </div>
</template>

<style lang="scss" scoped>
.s-toolbar {
  display:     flex;
  align-items: center;
  gap:         var(--studio-space-8);
  padding:     var(--studio-space-8) var(--studio-space-12);
  flex:        0 0 auto;
  min-height:  0;

  &--surface { background: var(--studio-surface); }
  &--subtle  { background: var(--studio-surface-subtle); }

  &--border-bottom { border-bottom: 1px solid var(--studio-border); }
  &--border-top    { border-top: 1px solid var(--studio-border); }
  &--border-none   { border: none; }

  // The file uses a zero-width grow spacer to push the right-hand controls out.
  :deep(.s-toolbar__grow) { flex: 1 1 auto; }
}
</style>
