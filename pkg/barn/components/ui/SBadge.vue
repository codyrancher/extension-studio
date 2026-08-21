<script>
// The design's State Badge (Figma component set 3:42).
//
// Its description is the reason it exists rather than being a coloured span: "Mirrors the
// Rancher cluster-state pill so extension state reads the same way cluster state does." The six
// states in the set are the six an extension can be in, and each pairs a `status/*` tint with
// its `status/*` hue - the same pairing the cluster table uses.
const STATES = {
  live:      { tone: 'success', label: 'Live' },
  draft:     { tone: 'neutral', label: 'Draft' },
  building:  { tone: 'info', label: 'Building' },
  unsaved:   { tone: 'warning', label: 'Unsaved' },
  failed:    { tone: 'error', label: 'Failed' },
  published: { tone: 'published', label: 'Published' },
};

export default {
  name: 'SBadge',

  props: {
    /**
     * live | draft | building | unsaved | failed | published
     *
     * Named `status` rather than the obvious `state`, and that is not a preference. Inside
     * Rancher's dashboard a component's `this.state` does not resolve to a prop called `state`
     * - something in the shell's own layer occupies that name on every instance - so the
     * template read the prop correctly while this component's computeds read something else
     * entirely, and every badge in the product rendered "Draft" no matter what it was handed.
     * The template said `live`, the computed said `neutral`, and both were telling the truth.
     */
    status: {
      type:      String,
      default:   'draft',
      validator: (v) => Object.keys(STATES).includes(v),
    },

    /** Overrides the state's own word. The tint still comes from `state`. */
    label: {
      type:    String,
      default: '',
    },

    /** Draws the small filled dot the session status row uses. */
    dot: {
      type:    Boolean,
      default: false,
    },
  },

  computed: {
    tone() {
      return (STATES[this.status] || STATES.draft).tone;
    },

    text() {
      return this.label || (STATES[this.status] || STATES.draft).label;
    },
  },
};
</script>

<template>
  <span class="s-badge" :class="`s-badge--${ tone }`">
    <span v-if="dot" class="s-badge__dot" />
    {{ text }}
  </span>
</template>

<style lang="scss" scoped>
.s-badge {
  display:       inline-flex;
  align-items:   center;
  gap:           6px;
  padding:       var(--studio-space-4) 9px;
  border-radius: var(--studio-radius);
  font:          var(--studio-caption-12);
  white-space:   nowrap;

  &__dot {
    width:         7px;
    height:        7px;
    border-radius: var(--studio-radius-pill);
    background:    currentColor;
    flex:          0 0 auto;
  }

  &--success   { background: var(--studio-success-bg); color: var(--studio-success); }
  &--neutral   { background: var(--studio-neutral-bg); color: var(--studio-neutral); }
  &--info      { background: var(--studio-info-bg); color: var(--studio-info); }
  &--warning   { background: var(--studio-warning-bg); color: var(--studio-warning); }
  &--error     { background: var(--studio-error-bg); color: var(--studio-error); }
  &--published { background: var(--studio-blue-050); color: var(--studio-blue-600); }
}
</style>
