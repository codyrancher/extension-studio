<script>
// A bordered column region - the shape every screen is assembled from.
//
// The workspace is three of these side by side (assistant, preview, and on screen 05 the file
// tree); the settings and review screens stack them. The border side is a prop because the
// file draws the divider on whichever edge faces the next panel rather than boxing each one.
export default {
  name: 'SPanel',

  props: {
    /** none | right | left | top | bottom | all */
    border: {
      type:    String,
      default: 'none',
    },

    /** canvas | surface | subtle | nav */
    surface: {
      type:    String,
      default: 'surface',
    },

    /** Fixed width in px. The file's panel widths are 520, 288 and 340. */
    width: {
      type:    [Number, String],
      default: null,
    },

    /** Lets the panel take the remaining space on its axis. */
    grow: {
      type:    Boolean,
      default: false,
    },

    /** Scrolls its own content rather than the page. */
    scroll: {
      type:    Boolean,
      default: false,
    },
  },

  computed: {
    style() {
      const s = {};

      if (this.width != null) {
        s.width = typeof this.width === 'number' ? `${ this.width }px` : this.width;
        s.flex = `0 0 ${ s.width }`;
      }

      return s;
    },
  },
};
</script>

<template>
  <div
    class="s-panel"
    :class="[
      `s-panel--border-${ border }`,
      `s-panel--${ surface }`,
      { 's-panel--grow': grow, 's-panel--scroll': scroll },
    ]"
    :style="style"
  >
    <slot />
  </div>
</template>

<style lang="scss" scoped>
.s-panel {
  display:        flex;
  flex-direction: column;
  min-width:      0;
  min-height:     0;

  &--grow   { flex: 1 1 auto; }
  &--scroll { overflow-y: auto; }

  &--surface { background: var(--studio-surface); }
  &--canvas  { background: var(--studio-surface); }
  &--subtle  { background: var(--studio-surface-subtle); }
  &--nav     { background: var(--studio-surface-nav); }

  &--border-right  { border-right: 1px solid var(--studio-border); }
  &--border-left   { border-left: 1px solid var(--studio-border); }
  &--border-top    { border-top: 1px solid var(--studio-border); }
  &--border-bottom { border-bottom: 1px solid var(--studio-border); }
  &--border-all    { border: 1px solid var(--studio-border); }
}
</style>
