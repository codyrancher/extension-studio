<script>
// A bordered, rounded block with an optional header row - the assistant's steps box (11:250),
// the collapsed raw-output block (32:893), the spec cards on Foundations, the repo cards on
// the import screen. 4px radius, 1px default border, surface or sunken fill.
import SIcon from './SIcon.vue';

export default {
  name: 'SCard',

  components: { SIcon },

  props: {
    title: {
      type:    String,
      default: '',
    },

    icon: {
      type:    String,
      default: '',
    },

    /** surface | subtle */
    surface: {
      type:    String,
      default: 'surface',
    },

    /** Removes the inner padding, for cards whose content draws its own rows. */
    flush: {
      type:    Boolean,
      default: false,
    },

    /** Turns the header into a disclosure control. */
    collapsible: {
      type:    Boolean,
      default: false,
    },

    /** Only meaningful with `collapsible`. */
    open: {
      type:    Boolean,
      default: true,
    },

    /** Draws the card as pressable and emits `click`. */
    selectable: {
      type:    Boolean,
      default: false,
    },

    selected: {
      type:    Boolean,
      default: false,
    },
  },

  emits: ['toggle', 'click'],

  data() {
    return { localOpen: this.open };
  },

  computed: {
    isOpen() {
      return this.collapsible ? this.localOpen : true;
    },
  },

  watch: {
    open(v) {
      this.localOpen = v;
    },
  },

  methods: {
    toggle() {
      if (!this.collapsible) {
        return;
      }

      this.localOpen = !this.localOpen;
      this.$emit('toggle', this.localOpen);
    },
  },
};
</script>

<template>
  <div
    class="s-card"
    :class="[
      `s-card--${ surface }`,
      { 's-card--selectable': selectable, 's-card--selected': selected },
    ]"
    @click="selectable && $emit('click', $event)"
  >
    <component
      :is="collapsible ? 'button' : 'div'"
      v-if="title || $slots.header"
      class="s-card__header"
      :class="{ 's-card__header--button': collapsible }"
      :type="collapsible ? 'button' : null"
      @click.stop="toggle"
    >
      <SIcon
        v-if="collapsible"
        :name="isOpen ? 'chevronDown' : 'chevronRight'"
        :size="13"
      />
      <SIcon v-else-if="icon" :name="icon" :size="14" />

      <slot name="header">
        <span class="s-card__title">{{ title }}</span>
      </slot>
    </component>

    <div
      v-if="isOpen && $slots.default"
      class="s-card__body"
      :class="{ 's-card__body--flush': flush }"
    >
      <slot />
    </div>

    <div v-if="isOpen && $slots.footer" class="s-card__footer">
      <slot name="footer" />
    </div>
  </div>
</template>

<style lang="scss" scoped>
.s-card {
  display:        flex;
  flex-direction: column;
  border:         1px solid var(--studio-border);
  border-radius:  var(--studio-radius);
  overflow:       hidden;
  min-width:      0;

  &--surface { background: var(--studio-surface); }
  &--subtle  { background: var(--studio-surface-subtle); }

  &--selectable {
    cursor: pointer;

    &:hover { border-color: var(--studio-border-strong); }
  }

  &--selected {
    border-color: var(--studio-green-500);
    box-shadow:   inset 0 0 0 1px var(--studio-green-500);
  }

  &__header {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
    padding:     9px var(--studio-space-12);
    width:       100%;
    text-align:  left;
    color:       var(--studio-text);
    background:  none;
    border:      none;
    font:        var(--studio-heading-14);

    &--button {
      cursor: pointer;

      &:hover { background: var(--studio-surface-subtle); }
    }

    // A header sitting above content needs the divider; a header that is the whole
    // card (collapsed) must not draw one.
    &:not(:last-child) { border-bottom: 1px solid var(--studio-border); }
  }

  &__title { font: var(--studio-heading-14); }

  &__body {
    padding:   var(--studio-space-12);
    min-width: 0;

    &--flush { padding: 0; }
  }

  &__footer {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
    padding:     var(--studio-space-8) var(--studio-space-12);
    border-top:  1px solid var(--studio-border);
    background:  var(--studio-surface-subtle);
  }
}
</style>
