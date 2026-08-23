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
//
// What the pod can actually fill in, and what it cannot:
//
//   `note` and `files` are new, and they are what the provenance hooks record - where a prompt
//   came from and who sent it, when a turn started and ended, and the files its commit
//   contains. They are drawn as plain lines and a plain list, deliberately not as steps: a
//   file in a turn's commit was left by the turn, which is not the same claim as "the agent
//   did this step to that file".
//
//   `steps` is still here and is still nothing's output. Nothing in the pod records a step, a
//   step's status or a step's duration - the hooks fire on a prompt, on a file-editing tool
//   and at the end of a turn, and nothing between - so no caller passes any, and the panel
//   says so under the stream rather than inventing four rows.
//
//   `pending` is a turn with no end recorded. It must not be drawn as a finished one, and it
//   must not be given a duration: the pod's claude can be signed out, in which case a prompt
//   is recorded and no Stop hook ever fires for it.
import { SIcon, SCard } from '../ui';

/** How many files a turn lists before the rest go behind "N more". */
const FILE_PREVIEW = 5;

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

    /**
     * The caption under the meta line: where the turn came from, or what it ended in.
     *
     * Only ever facts the pod recorded. A turn the product did not send carries no name, and
     * this line says that rather than filling the gap with whoever is signed in.
     */
    note: {
      type:    String,
      default: '',
    },

    /**
     * The turn has no end recorded, so it is not a finished one and has no duration.
     *
     * Drawn muted rather than with a spinner: "nothing recorded its end" is what is known, and
     * a spinner would claim it is running right now, which nothing here can see.
     */
    pending: {
      type:    Boolean,
      default: false,
    },

    /** Paths the turn left behind. Plain strings, relative to the package. */
    files: {
      type:    Array,
      default: () => [],
    },

    /** What that list is: a commit's files, or the ones an edit tool touched. Said, not implied. */
    filesLabel: {
      type:    String,
      default: '',
    },
  },

  emits: ['raw', 'step'],

  data() {
    return { allFiles: false };
  },

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

    /** A long list is cut rather than scrolled, because the stream itself is the scroller. */
    shownFiles() {
      return this.allFiles ? this.files : this.files.slice(0, FILE_PREVIEW);
    },

    moreFiles() {
      return Math.max(0, this.files.length - this.shownFiles.length);
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
  <div
    class="turn"
    :class="[`turn--${ role }`, { 'turn--pending': pending }]"
  >
    <!-- meta (11:235 / 11:243) -->
    <div class="turn__meta">
      <!--
        The role's own glyph either way. A clock here would read better for an unfinished turn
        and would cost the meta line the thing that says whose turn it is, which is the half of
        it the design is built on; unfinished is said in the sentence and in its colour instead.
      -->
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

    <!--
      Where it came from, or what it ended in. One line of recorded fact, never an inference:
      a turn with no origin stamp says it has none.
    -->
    <div v-if="note" class="turn__note">
      {{ note }}
    </div>

    <!--
      The files the turn left. Not steps: nothing recorded a status or a duration for any of
      them, and drawing them in a step row would imply both.
    -->
    <div v-if="files.length" class="turn__files">
      <span v-if="filesLabel" class="turn__files-label">{{ filesLabel }}</span>
      <SCard flush class="turn__files-list">
        <div
          v-for="path in shownFiles"
          :key="path"
          class="turn__file"
        >
          <SIcon name="file" :size="12" />
          <span class="turn__file-path" :title="path">{{ path }}</span>
        </div>
      </SCard>
      <button
        v-if="moreFiles"
        type="button"
        class="turn__more"
        @click="allFiles = true"
      >
        {{ moreFiles }} more
      </button>
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

  // A turn with no end recorded reads as unfinished rather than as a result.
  &--pending &__text {
    color: var(--studio-text-secondary);
  }

  &__note {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  &__files {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-2);
    align-items:    flex-start;
  }

  &__files-label {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  &__files-list { width: 100%; }

  &__file {
    display:     flex;
    align-items: center;
    gap:         6px;
    padding:     5px var(--studio-space-10);
    color:       var(--studio-text-tertiary);

    &:not(:last-child) { border-bottom: 1px solid var(--studio-border-subtle); }
  }

  &__file-path {
    font:          var(--studio-mono-12);
    color:         var(--studio-text-secondary);
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  &__more {
    padding:    0;
    background: none;
    border:     none;
    font:       var(--studio-caption-12);
    color:      var(--studio-blue-600);
    cursor:     pointer;

    &:hover { text-decoration: underline; }
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
