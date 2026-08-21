<script>
// One turn in the activity stream (Figma nodes 11:234 user, 11:242 assistant).
//
// A user turn is a meta line over a bubble. An assistant turn is a meta line, a sentence, a
// bordered list of steps, and a collapsed strip that opens the raw output. The steps are the
// interesting part: each is a status pill, a title with a detail line under it, and a duration
// - and the running one is tinted blue with a spinner where the tick goes, which is what makes
// the stream readable at a glance rather than a wall of prose.
//
// It is a separate component because screens 12 and 13 show the same block: a change's intent
// and the steps that produced it.
import { SIcon, SCard } from '../ui';

export default {
  name: 'ActivityTurn',

  components: { SIcon, SCard },

  props: {
    /** user | assistant */
    role: {
      type:      String,
      default:   'assistant',
      validator: (v) => ['user', 'assistant'].includes(v),
    },

    /** The meta line's right half - "2 minutes ago", or a timestamp. */
    when: {
      type:    String,
      default: '',
    },

    /** The bubble (user) or the lead sentence (assistant). */
    text: {
      type:    String,
      default: '',
    },

    /** `{ state, title, detail, duration }`. state: done | running | failed | pending. */
    steps: {
      type:    Array,
      default: () => [],
    },

    /** The label on the collapsed raw-output strip. Omit it and the strip is not drawn. */
    rawLabel: {
      type:    String,
      default: '',
    },

    /** The right-hand note on that strip - the design's "the terminal is still here". */
    rawNote: {
      type:    String,
      default: '',
    },
  },

  emits: ['raw', 'step'],

  computed: {
    who() {
      return this.role === 'user' ? 'You' : 'Assistant';
    },

    icon() {
      return this.role === 'user' ? 'user' : 'sparkle';
    },

    metaLine() {
      return this.when ? `${ this.who } · ${ this.when }` : this.who;
    },
  },

  methods: {
    stepIcon(state) {
      return {
        done: 'check', failed: 'close', running: 'spinner', pending: 'clock',
      }[state] || 'clock';
    },
  },
};
</script>

<template>
  <div class="turn" :class="`turn--${ role }`">
    <!-- meta (11:235 / 11:243) -->
    <div class="turn__meta">
      <SIcon :name="icon" :size="13" />
      <span class="turn__who">{{ metaLine }}</span>
    </div>

    <!-- user: bubble (11:240) -->
    <div v-if="role === 'user'" class="turn__bubble">
      <slot>{{ text }}</slot>
    </div>

    <!-- assistant: lead sentence (11:249) -->
    <div v-else-if="text || $slots.default" class="turn__text">
      <slot>{{ text }}</slot>
    </div>

    <!-- steps (11:250) -->
    <SCard v-if="steps.length" flush class="turn__steps">
      <div
        v-for="(step, i) in steps"
        :key="i"
        class="turn__step"
        :class="{ 'turn__step--running': step.state === 'running' }"
        @click="$emit('step', step)"
      >
        <span
          class="turn__status"
          :class="`turn__status--${ step.state || 'pending' }`"
        >
          <SIcon
            :name="stepIcon(step.state)"
            :size="12"
            :class="{ 'turn__spin': step.state === 'running' }"
          />
        </span>

        <span class="turn__step-text">
          <span class="turn__step-title">{{ step.title }}</span>
          <span v-if="step.detail" class="turn__step-detail">{{ step.detail }}</span>
        </span>

        <span class="turn__step-right">
          <span v-if="step.duration" class="turn__step-duration">{{ step.duration }}</span>
          <SIcon name="chevronDown" :size="13" />
        </span>
      </div>
    </SCard>

    <!-- raw output, collapsed (32:893) -->
    <button
      v-if="rawLabel"
      type="button"
      class="turn__raw"
      @click="$emit('raw')"
    >
      <SIcon name="terminal" :size="14" />
      <span class="turn__raw-label">{{ rawLabel }}</span>
      <span class="turn__raw-grow" />
      <span v-if="rawNote" class="turn__raw-note">{{ rawNote }}</span>
      <SIcon name="chevronDown" :size="13" />
    </button>
  </div>
</template>

<style lang="scss" scoped>
.turn {
  display:        flex;
  flex-direction: column;
  gap:            6px;

  // The assistant turn is looser than the user turn: 10px between its parts, 6px between
  // the user's two.
  &--assistant { gap: var(--studio-space-8); }

  &__meta {
    display:     flex;
    align-items: center;
    gap:         6px;
    color:       var(--studio-text-tertiary);
  }

  &__who {
    font: var(--studio-caption-12-semi);
  }

  &__bubble {
    padding:       10px var(--studio-space-12);
    background:    var(--studio-surface-subtle);
    border:        1px solid var(--studio-border-subtle);
    border-radius: var(--studio-radius);
    font:          var(--studio-body-14);
    color:         var(--studio-text);
  }

  &__text {
    font:  var(--studio-body-14);
    color: var(--studio-text);
  }

  &__steps { overflow: visible; }

  &__step {
    display:     flex;
    align-items: flex-start;
    gap:         10px;
    padding:     10px var(--studio-space-12);
    cursor:      pointer;

    &:not(:last-child) { border-bottom: 1px solid var(--studio-border-subtle); }

    &:hover { background: var(--studio-surface-subtle); }

    // The running step is tinted, and stays tinted on hover so it does not flicker
    // between two blues as the pointer crosses it.
    &--running,
    &--running:hover { background: var(--studio-info-bg); }
  }

  &__status {
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    padding:         2px;
    border-radius:   var(--studio-radius-pill);
    flex:            0 0 auto;
    margin-top:      1px;

    &--done    { background: var(--studio-success-bg); color: var(--studio-success); }
    &--running { background: transparent; color: var(--studio-info); }
    &--failed  { background: var(--studio-error-bg); color: var(--studio-error); }
    &--pending { background: var(--studio-neutral-bg); color: var(--studio-text-tertiary); }
  }

  &__step-text {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-2);
    flex:           1 1 auto;
    min-width:      0;
  }

  &__step-title {
    font:  var(--studio-heading-14);
    color: var(--studio-text);
  }

  &__step-detail {
    font:  var(--studio-caption-12);
    color: var(--studio-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &__step-right {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
    flex:        0 0 auto;
    color:       var(--studio-text-tertiary);
  }

  &__step-duration { font: var(--studio-caption-12); }

  &__raw {
    display:       flex;
    align-items:   center;
    gap:           var(--studio-space-8);
    width:         100%;
    padding:       9px var(--studio-space-12);
    background:    var(--studio-surface-subtle);
    border:        1px solid var(--studio-border);
    border-radius: var(--studio-radius);
    color:         var(--studio-text-secondary);
    cursor:        pointer;
    text-align:    left;

    &:hover { border-color: var(--studio-border-strong); }
  }

  &__raw-label { font: var(--studio-caption-12-semi); }
  &__raw-grow  { flex: 1 1 auto; }
  &__raw-note  { font: var(--studio-caption-12); color: var(--studio-text-tertiary); }

  &__spin { animation: turn-spin 0.9s linear infinite; }
}

@keyframes turn-spin {
  to { transform: rotate(360deg); }
}
</style>
