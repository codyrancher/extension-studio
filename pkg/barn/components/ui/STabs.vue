<script>
// The design's Tab (Figma component set 4:34), as a strip.
//
// The set defines one tab: a label row over a 2px indicator, the indicator green when selected
// and the surface colour when not, and the label stepping from Body/14 Regular to Heading/14
// SemiBold with it. Drawing the unselected indicator rather than hiding it is what keeps the
// labels from shifting a pixel as selection moves.
//
// Two densities, because the file uses two. `default` is the component set's own 8px gap;
// `panel` is the assistant panel's strip (node 11:188), which sits on a bottom border with a
// wider 22px gap and 12px of lead-in above each label.
import SIcon from './SIcon.vue';

export default {
  name: 'STabs',

  components: { SIcon },

  props: {
    /** `{ id, label, icon?, count? }` per tab. */
    tabs: {
      type:    Array,
      default: () => [],
    },

    /** The selected tab's id. */
    modelValue: {
      type:    [String, Number],
      default: '',
    },

    /** default | panel */
    variant: {
      type:      String,
      default:   'default',
      validator: (v) => ['default', 'panel'].includes(v),
    },
  },

  emits: ['update:modelValue', 'select'],

  methods: {
    select(tab) {
      if (tab.disabled || tab.id === this.modelValue) {
        return;
      }

      this.$emit('update:modelValue', tab.id);
      this.$emit('select', tab.id);
    },
  },
};
</script>

<template>
  <div class="s-tabs" :class="`s-tabs--${ variant }`" role="tablist">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      type="button"
      role="tab"
      class="s-tab"
      :class="{ 's-tab--selected': tab.id === modelValue, 's-tab--disabled': tab.disabled }"
      :aria-selected="tab.id === modelValue"
      :disabled="tab.disabled"
      @click="select(tab)"
    >
      <span class="s-tab__row">
        <SIcon v-if="tab.icon" :name="tab.icon" :size="13" />
        <span class="s-tab__label">{{ tab.label }}</span>
        <span v-if="tab.count != null" class="s-tab__count">{{ tab.count }}</span>
      </span>

      <span class="s-tab__indicator" />
    </button>
  </div>
</template>

<style lang="scss" scoped>
.s-tabs {
  display:     flex;
  align-items: flex-end;

  &--default { gap: var(--studio-space-24); }

  &--panel {
    gap:           22px;
    padding:       0 var(--studio-space-16);
    border-bottom: 1px solid var(--studio-border);
  }
}

.s-tab {
  display:         flex;
  flex-direction:  column;
  align-items:     center;
  gap:             var(--studio-space-8);
  padding:         0;
  border:          none;
  background:      none;
  cursor:          pointer;
  color:           var(--studio-text-secondary);
  font:            var(--studio-body-14);

  .s-tabs--panel & {
    padding: var(--studio-space-12) 0 0;
    gap:     9px;
  }

  &__row {
    display:     flex;
    align-items: center;
    gap:         6px;
    padding:     0 var(--studio-space-4);
  }

  &__count {
    padding:       0 5px;
    border-radius: var(--studio-radius-pill);
    background:    var(--studio-neutral-bg);
    color:         var(--studio-text-secondary);
    font:          var(--studio-caption-12);
  }

  &__indicator {
    width:      100%;
    height:     2px;
    background: transparent;
  }

  &:hover:not(.s-tab--disabled):not(.s-tab--selected) {
    color: var(--studio-text);
  }

  &--selected {
    color: var(--studio-text);
    font:  var(--studio-heading-14);

    .s-tab__indicator { background: var(--studio-green-500); }
    .s-tab__count {
      background: var(--studio-green-050);
      color:      var(--studio-green-600);
    }
  }

  &--disabled {
    opacity: 0.45;
    cursor:  not-allowed;
  }
}
</style>
