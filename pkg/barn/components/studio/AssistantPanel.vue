<script>
// The assistant panel from the Studio design (Figma frame 03, node 9:232).
//
// Five parts, top to bottom: the tab strip (11:188), the session status row (11:222), the
// content area - which in the design is always the activity stream (11:233) - the changes
// summary (11:305), and the composer (11:317).
//
// Which of them are real is worth being exact about, because the panel looks finished either
// way:
//
//   Real. The tabs, and three of the four things behind them: Files and Changes and Terminal
//   are views this extension already had. The changes summary counts actual working-tree
//   changes with `git status` in the pod and reads the published version off the UIPlugin, so
//   "14 changes since v0.1.0" is two live readings rather than a caption. The composer sends
//   what you type to the claude in the pod, which is the same thing as typing it into the
//   terminal, and switches to the terminal so the reply is visible.
//
//   Not real. The activity stream itself. The design shows the assistant's work as structured
//   turns with steps and durations, and what we have is a terminal - claude's output is a
//   character stream, not a sequence of typed events, and turning one into the other is a
//   parser nobody has written. So the Assistant tab renders the stream when it is given turns
//   and otherwise says plainly that the structured view is not wired and offers the terminal,
//   rather than showing an invented conversation that reads as real.
//
//   Not real. The permission chip and the context chips, which toast.
import { SIcon, SChip, SLabel, SButton, STabs, SEmpty } from '../ui';
import ActivityTurn from './ActivityTurn.vue';
import { toastNotYet } from '../../toast';
import { countChanges, publishedVersion } from '../../extensions';

export default {
  name: 'AssistantPanel',

  components: {
    SIcon, SChip, SLabel, SButton, STabs, SEmpty, ActivityTurn
  },

  props: {
    extension: {
      type:     String,
      required: true,
    },

    /** assistant | files | changes | terminal */
    tab: {
      type:    String,
      default: 'assistant',
    },

    /**
     * The activity stream, when there is one. Shape per ActivityTurn's props. Empty is the
     * normal case today - see the note at the top.
     */
    turns: {
      type:    Array,
      default: () => [],
    },

    /** Whether the pod's terminal is connected, for the status row's dot. */
    connected: {
      type:    Boolean,
      default: false,
    },
  },

  emits: ['update:tab', 'send', 'review'],

  data() {
    return {
      draft:      '',
      changes:    0,
      version:    '',
      countTimer: null,
    };
  },

  computed: {
    tabs() {
      return [
        { id: 'assistant', label: 'Assistant', icon: 'sparkle' },
        { id: 'files', label: 'Files', icon: 'file' },
        {
          id: 'changes', label: 'Changes', icon: 'compare', count: this.changes || null,
        },
        { id: 'terminal', label: 'Terminal', icon: 'terminal' },
      ];
    },

    // The design's "Connected as ken@suse.com". The real one is whoever is signed in to this
    // Rancher, which is the account the pod's claude is acting for.
    connectedAs() {
      const p = this.$store.getters['auth/principal'] || this.$store.getters['rancher/byId']?.('principal');

      return p?.loginName || p?.name || p?.id?.split('://')?.[1] || 'this Rancher';
    },

    changesLabel() {
      const n = this.changes;
      const what = `${ n } change${ n === 1 ? '' : 's' }`;

      return this.version ? `${ what } since v${ this.version }` : what;
    },
  },

  mounted() {
    this.refreshChanges();
    // A minute, not a second: it shells into the pod to run `git status`, and the number it
    // reports does not move except when somebody edits something.
    this.countTimer = setInterval(() => this.refreshChanges(), 60000);
  },

  beforeUnmount() {
    clearInterval(this.countTimer);
  },

  watch: {
    extension() {
      this.changes = 0;
      this.version = '';
      this.refreshChanges();
    },
  },

  methods: {
    async refreshChanges() {
      this.changes = await countChanges(this.extension).catch(() => 0);
      this.version = await publishedVersion(this.extension).catch(() => '');
    },

    notYet(what) {
      toastNotYet(this.$store, what);
    },

    submit() {
      const text = this.draft.trim();

      if (!text) {
        return;
      }

      this.draft = '';
      this.$emit('send', text);
      // The reply arrives in the terminal, so go and look at it.
      this.$emit('update:tab', 'terminal');
    },

    onKeydown(e) {
      // Shift+Enter is a newline, Enter sends - which is what the composer's own hint says.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.submit();
      }
    },
  },
};
</script>

<template>
  <div class="assistant-panel">
    <!-- panel tabs (11:188) -->
    <STabs
      :tabs="tabs"
      variant="panel"
      :model-value="tab"
      @update:model-value="$emit('update:tab', $event)"
    />

    <!-- session status (11:222) -->
    <div class="assistant-panel__status">
      <span
        class="assistant-panel__dot"
        :class="{ 'assistant-panel__dot--off': !connected }"
      />
      <span class="assistant-panel__who">Connected as {{ connectedAs }}</span>
      <span class="assistant-panel__grow" />
      <SChip
        label="Ask before each file edit"
        icon="lock"
        clickable
        @click="notYet('the permission mode chip')"
      />
      <SButton
        variant="ghost"
        size="sm"
        icon="chevronDown"
        icon-only
        @click="notYet('the session menu')"
      />
    </div>

    <!-- content. Every tab stays mounted: the terminal is a live session, and unmounting it
         to look at a file would end whatever claude was in the middle of. -->
    <div class="assistant-panel__body">
      <!-- activity stream (11:233) -->
      <div v-show="tab === 'assistant'" class="assistant-panel__stream">
        <template v-if="turns.length">
          <ActivityTurn
            v-for="(turn, i) in turns"
            :key="i"
            v-bind="turn"
            @raw="$emit('update:tab', 'terminal')"
          />
        </template>

        <SEmpty
          v-else
          icon="sparkle"
          title="The assistant runs in the terminal"
          message="This view will show each turn as steps with durations once the CLI's output is parsed into events. Until then the terminal below is the whole session, and the composer sends to it."
        >
          <SButton
            variant="secondary"
            icon="terminal"
            @click="$emit('update:tab', 'terminal')"
          >
            Open the terminal
          </SButton>
        </SEmpty>
      </div>

      <div v-show="tab === 'files'" class="assistant-panel__pane">
        <slot name="files" />
      </div>

      <div v-show="tab === 'changes'" class="assistant-panel__pane">
        <slot name="changes" />
      </div>

      <div v-show="tab === 'terminal'" class="assistant-panel__pane">
        <slot name="terminal" />
      </div>
    </div>

    <!-- changes summary (11:305). Drawn only when there is something to review. -->
    <div v-if="changes > 0" class="assistant-panel__changes">
      <SIcon name="compare" :size="16" />
      <div class="assistant-panel__changes-text">
        <span class="assistant-panel__changes-title">{{ changesLabel }}</span>
        <span class="assistant-panel__changes-note">
          Only you can see them. Nothing is asked of you until you publish.
        </span>
      </div>
      <SButton
        variant="secondary"
        size="sm"
        @click="$emit('update:tab', 'changes')"
      >
        Review
      </SButton>
    </div>

    <!-- composer (11:317) -->
    <div class="assistant-panel__composer">
      <div class="assistant-panel__context">
        <SLabel text="Context" />
        <SChip
          :label="extension"
          icon="puzzle"
          clickable
          @click="notYet('the context chips')"
        />
        <SChip
          label="cluster: local"
          icon="server"
          clickable
          @click="notYet('the context chips')"
        />
        <SChip
          label="Add"
          icon="plus"
          clickable
          @click="notYet('adding context')"
        />
      </div>

      <div class="assistant-panel__field">
        <textarea
          v-model="draft"
          class="assistant-panel__input"
          rows="2"
          placeholder="Describe the next change — e.g. &quot;colour the bars by severity and add a 7-day toggle&quot;"
          @keydown="onKeydown"
        />
        <div class="assistant-panel__field-bar">
          <SButton
            variant="ghost"
            size="sm"
            icon="upload"
            icon-only
            title="Attach a file"
            @click="notYet('attaching a file to a message')"
          />
          <span class="assistant-panel__grow" />
          <SButton
            variant="primary"
            size="sm"
            icon="arrowRight"
            :disabled="!draft.trim()"
            @click="submit"
          >
            Send
          </SButton>
        </div>
      </div>

      <div class="assistant-panel__hint">
        Shift + Enter for a new line · the assistant never publishes on its own
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.assistant-panel {
  display:        flex;
  flex-direction: column;
  min-height:     0;
  height:         100%;
  background:     var(--studio-surface);
  border-right:   1px solid var(--studio-border);

  &__status {
    display:       flex;
    align-items:   center;
    gap:           var(--studio-space-8);
    padding:       var(--studio-space-8) var(--studio-space-16);
    background:    var(--studio-surface-subtle);
    border-bottom: 1px solid var(--studio-border-subtle);
    flex:          0 0 auto;
  }

  &__dot {
    width:         7px;
    height:        7px;
    border-radius: var(--studio-radius-pill);
    background:    var(--studio-success);
    flex:          0 0 auto;

    &--off { background: var(--studio-text-tertiary); }
  }

  &__who {
    font:  var(--studio-caption-12);
    color: var(--studio-text-secondary);
  }

  &__grow { flex: 1 1 auto; }

  &__body {
    display:    flex;
    flex:       1 1 auto;
    min-height: 0;
  }

  &__stream {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-12);
    padding:        var(--studio-space-12) var(--studio-space-16);
    flex:           1 1 auto;
    min-height:     0;
    overflow-y:     auto;
  }

  // The three borrowed views fill the same box the stream does. They draw their own
  // scrolling, so this one must not add a second scrollbar around them.
  &__pane {
    display:    flex;
    flex:       1 1 auto;
    min-width:  0;
    min-height: 0;
    overflow:   hidden;

    :deep(> *) {
      flex:      1 1 auto;
      min-width: 0;
    }
  }

  &__changes {
    display:       flex;
    align-items:   center;
    gap:           10px;
    padding:       10px var(--studio-space-16);
    background:    var(--studio-warning-bg);
    border-top:    1px solid var(--studio-warning);
    border-bottom: 1px solid var(--studio-warning);
    color:         var(--studio-warning);
    flex:          0 0 auto;
  }

  &__changes-text {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-2);
    flex:           1 1 auto;
    min-width:      0;
  }

  &__changes-title {
    font:  var(--studio-heading-14);
    color: var(--studio-text);
  }

  &__changes-note {
    font:  var(--studio-caption-12);
    color: var(--studio-text-secondary);
  }

  &__composer {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-8);
    padding:        var(--studio-space-12) var(--studio-space-16) 14px;
    background:     var(--studio-surface-subtle);
    border-top:     1px solid var(--studio-border);
    flex:           0 0 auto;
  }

  &__context {
    display:     flex;
    align-items: center;
    gap:         6px;
    flex-wrap:   wrap;
  }

  &__field {
    display:        flex;
    flex-direction: column;
    gap:            10px;
    padding:        10px var(--studio-space-12);
    background:     var(--studio-surface);
    border:         1px solid var(--studio-border-strong);
    border-radius:  var(--studio-radius);

    &:focus-within {
      border-color: var(--studio-border-focus);
      box-shadow:   inset 0 0 0 1px var(--studio-border-focus);
    }
  }

  &__input {
    border:     none;
    outline:    none;
    background: transparent;
    padding:    0;
    resize:     none;
    font:       var(--studio-body-14);
    color:      var(--studio-text);

    &::placeholder { color: var(--studio-text-tertiary); }
  }

  &__field-bar {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
  }

  &__hint {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }
}
</style>
