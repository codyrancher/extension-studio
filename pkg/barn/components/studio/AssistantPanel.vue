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
//   terminal, and switches to the terminal so the reply is visible. The context chips are the
//   paths that go with it: whatever is on them is named in the line the assistant receives,
//   so the word "context" is a description rather than a promise.
//
//   Not real. The activity stream itself. The design shows the assistant's work as structured
//   turns with steps and durations, and what we have is a terminal - claude's output is a
//   character stream, not a sequence of typed events, and turning one into the other is a
//   parser nobody has written. So the Assistant tab renders the stream when it is given turns
//   and otherwise says plainly that the structured view is not wired and offers the terminal,
//   rather than showing an invented conversation that reads as real.
//
//   Informational. The chip on the status row. The design's version says "Ask before each file
//   edit", and the pod runs `claude --dangerously-skip-permissions` (see pod/claude-session.sh)
//   - so the design's chip was the opposite of the truth, and there is no switch behind it to
//   make it true. It states what the session actually does instead, and is not clickable,
//   because there is nothing to press it for.
import {
  SIcon, SChip, SLabel, SButton, STabs, SEmpty, SMenu, SModal, SField
} from '../ui';
import ActivityTurn from './ActivityTurn.vue';
import { toastSuccess, toastError } from '../../toast';
import {
  countChanges, publishedVersion, listExtensionFiles, writePodImage
} from '../../extensions';

/**
 * Where an attached file lands in the pod.
 *
 * The same trick, and the same directory rules, as the terminal's pasted images: under /app so
 * it is on the hostPath and survives a pod restart, dotted so it stays out of the extension's
 * source tree and out of the file browser that lists it. The assistant reads a file from a
 * path, so putting one there and naming it is what attaching means here.
 */
const ATTACH_DIR = '/app/.attachments';

/** Big enough for a screenshot or a log, small enough that the chunked write is not a wait. */
const MAX_ATTACHMENT = 8 * 1024 * 1024;

export default {
  name: 'AssistantPanel',

  components: {
    SIcon, SChip, SLabel, SButton, STabs, SEmpty, SMenu, SModal, SField, ActivityTurn
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
     * The tmux session the terminal is attached to, passed in by the page so this and the
     * terminal cannot disagree about which conversation is on screen.
     */
    session: {
      type:    String,
      default: 'editor',
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

    /**
     * Bumped by the page whenever something it did changed the working tree.
     *
     * The count below is otherwise on a minute's poll, which is right for edits the assistant
     * makes in the background and wrong for an undo or a restore the person just pressed: the
     * tab would go on claiming a number that stopped being true while they were watching.
     */
    revision: {
      type:    Number,
      default: 0,
    },
  },

  emits: ['update:tab', 'send', 'review', 'reconnect'],

  data() {
    return {
      draft:      '',
      changes:    0,
      version:    '',
      countTimer: null,
      /**
       * The paths that go with the next message, as `{ path, icon }`.
       *
       * One list for both ways of adding one - picking a file out of the extension, and
       * attaching a file from this machine - because they end the same way: a path in the pod
       * that the assistant is told about.
       */
      context:    [],
      // The file picker, and what it has read.
      picking:    false,
      files:      [],
      filesRead:  false,
      fileFilter: '',
      // Set while a file is on its way into the pod.
      attaching:  false,
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

    /**
     * The design's "Connected as ken@suse.com". The real one is whoever is signed in to this
     * Rancher, which is the account the pod's claude is acting for.
     *
     * `auth/principalId` is the getter the shell actually has - there is no `auth/principal` -
     * and it holds something like `local://user-abc123`, so the readable half is what follows
     * the scheme. `auth/user` and `auth/selfUser` carry a name when the store has fetched one,
     * which it has not always done by the time this renders, so they are tried first and this
     * falls back rather than waiting.
     */
    connectedAs() {
      const g = this.$store?.getters || {};
      const user = g['auth/user'] || g['auth/selfUser'];
      const named = user?.loginName || user?.username || user?.name;

      if (named) {
        return named;
      }

      const id = g['auth/principalId'] || '';
      const tail = String(id).split('://').pop();

      return tail && tail !== id ? tail : '';
    },

    /**
     * The whole sentence, because the fallback changes the grammar.
     *
     * With no name to show, "Connected as this Rancher" is wrong in a way that reads as a bug
     * in the connection rather than a gap in what we know about the account.
     */
    connectedLabel() {
      return this.connectedAs ? `Connected as ${ this.connectedAs }` : 'Connected to this Rancher';
    },

    changesLabel() {
      const n = this.changes;
      const what = `${ n } change${ n === 1 ? '' : 's' }`;

      return this.version ? `${ what } since v${ this.version }` : what;
    },

    /** The tmux session in the pod, which is the name a shell would attach to. */
    sessionName() {
      return `mc-${ this.session }`;
    },

    /**
     * What the session menu offers, which is four things that exist plus the composer's own
     * clear.
     *
     * "Start a new conversation" is `/clear`, typed into the session, and it is named for what
     * that does rather than for restarting anything: the pane runs claude in a loop
     * (pod/claude-session.sh) and only that pane can restart it, so nothing reachable from a
     * browser tab can. `/clear` drops the conversation and keeps the process, which is the
     * half of "start again" that is actually available here.
     */
    sessionItems() {
      return [
        {
          id: 'clear', label: 'Clear the composer', icon: 'close', disabled: !this.draft.trim(),
        },
        { id: 'terminal', label: 'Open the terminal', icon: 'terminal' },
        { divider: true },
        {
          id: 'new', label: 'Start a new conversation', note: '/clear', icon: 'sparkle',
        },
        { id: 'reconnect', label: 'Reattach the terminal', icon: 'refresh' },
        { divider: true },
        {
          id: 'copy', label: 'Copy the session name', note: this.sessionName, icon: 'code',
        },
      ];
    },

    /** The files the picker is showing, filtered by whatever has been typed. */
    shownFiles() {
      const term = this.fileFilter.trim().toLowerCase();
      const already = new Set(this.context.map((item) => item.path));
      const matching = this.files.filter((path) => !already.has(path) && (!term || path.toLowerCase().includes(term)));

      // A package is a few hundred files and the list is scrolled, not paged; a cap keeps a
      // pod with a stray build directory in it from rendering ten thousand rows.
      return matching.slice(0, 300);
    },

    /** The hint under the composer, which has to say when a message carries more than itself. */
    hint() {
      const base = 'Shift + Enter for a new line · the assistant never publishes on its own';

      if (!this.context.length) {
        return base;
      }

      const n = this.context.length;

      return `${ base } · ${ n } path${ n === 1 ? '' : 's' } named in the message`;
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
    revision() {
      this.refreshChanges();
    },

    extension() {
      this.changes = 0;
      this.version = '';
      // The paths belonged to the extension that was open; none of them means anything in the
      // next one's pod.
      this.context = [];
      this.files = [];
      this.filesRead = false;
      this.refreshChanges();
    },
  },

  methods: {
    async refreshChanges() {
      this.changes = await countChanges(this.extension).catch(() => 0);
      this.version = await publishedVersion(this.extension).catch(() => '');
    },

    submit() {
      const text = this.draft.trim();

      if (!text) {
        return;
      }

      this.draft = '';
      this.$emit('send', this.withContext(text));
      // The reply arrives in the terminal, so go and look at it.
      this.$emit('update:tab', 'terminal');
    },

    /**
     * The line the assistant actually receives.
     *
     * One line, because the terminal types this at a prompt and a newline in it would submit
     * half a sentence. The paths are named in the text rather than attached out of band, which
     * is the only kind of attaching a terminal has.
     */
    withContext(text) {
      const paths = this.context.map((item) => item.path);

      return paths.length ? `Context: ${ paths.join(', ') }. ${ text }` : text;
    },

    onKeydown(e) {
      // Shift+Enter is a newline, Enter sends - which is what the composer's own hint says.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.submit();
      }
    },

    onSessionSelect(id) {
      if (id === 'clear') {
        this.draft = '';

        return;
      }

      if (id === 'terminal') {
        this.$emit('update:tab', 'terminal');

        return;
      }

      if (id === 'new') {
        this.$emit('send', '/clear');
        this.$emit('update:tab', 'terminal');
        toastSuccess(
          this.$store,
          '/clear went to the session. The conversation starts over; the files in the pod are untouched.',
          { title: 'New conversation' },
        );

        return;
      }

      if (id === 'reconnect') {
        this.$emit('reconnect');

        return;
      }

      if (id === 'copy') {
        this.copySession();
      }
    },

    async copySession() {
      try {
        await navigator.clipboard.writeText(this.sessionName);
        toastSuccess(this.$store, `${ this.sessionName } is on the clipboard. \`tmux attach -t ${ this.sessionName }\` in the pod opens the same session.`, { title: 'Copied' });
      } catch (e) {
        toastError(this.$store, `The clipboard refused this. The session is called ${ this.sessionName }.`);
      }
    },

    /** Open the picker, and read the extension's files the first time it is opened. */
    async openPicker() {
      this.picking = true;
      this.fileFilter = '';

      if (this.filesRead) {
        return;
      }

      this.files = await listExtensionFiles(this.extension).catch(() => []);
      this.filesRead = true;
    },

    addContext(path, icon = 'file') {
      if (!this.context.some((item) => item.path === path)) {
        this.context = [...this.context, { path, icon }];
      }
    },

    addFile(path) {
      this.addContext(path);
      this.picking = false;
    },

    removeContext(path) {
      this.context = this.context.filter((item) => item.path !== path);
    },

    /** The last two segments, so a chip does not become the whole composer. */
    shortPath(path) {
      return path.split('/').slice(-2).join('/');
    },

    /**
     * The paperclip: a file from this machine, into the pod, named on the next message.
     *
     * The same mechanism the terminal's paste uses - writePodImage is a chunked base64 write
     * and does not care what the bytes are - so an image attached here is a path the assistant
     * can read exactly as one pasted into the pane is.
     */
    async onAttach(event) {
      const files = [...(event.target.files || [])];

      // Cleared straight away, so attaching the same file twice in a row still fires a change.
      event.target.value = '';

      if (!files.length) {
        return;
      }

      this.attaching = true;

      for (const file of files) {
        if (file.size > MAX_ATTACHMENT) {
          toastError(this.$store, `${ file.name } is ${ Math.round(file.size / 1024 / 1024) }MB. The limit here is 8MB; put a bigger file in the pod from the terminal instead.`);
          continue;
        }

        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const safe = file.name.replace(/[^\w.-]/g, '_') || 'file';
        const path = `${ ATTACH_DIR }/${ stamp }-${ safe }`;

        try {
          await writePodImage(this.extension, path, await file.arrayBuffer());
          this.addContext(path, 'upload');
          toastSuccess(this.$store, `${ file.name } is in the pod at ${ path }, and is named on the next message.`, { title: 'Attached' });
        } catch (e) {
          toastError(this.$store, e.message || String(e));
        }
      }

      this.attaching = false;
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
      <span class="assistant-panel__who">{{ connectedLabel }}</span>
      <span class="assistant-panel__grow" />
      <!--
        What the session does, rather than the design's "Ask before each file edit", which it
        does not do. Informational: there is no permission mode to switch to.
      -->
      <SChip
        label="Edits apply without asking"
        icon="alert"
        tone="warning"
        title="The assistant runs with --dangerously-skip-permissions in this pod, so its edits land in the working tree as it makes them. Nothing reaches this Rancher until you publish."
        data-testid="barn-permission-chip"
      />
      <SMenu
        :items="sessionItems"
        icon="chevronDown"
        aria-label="Session actions"
        data-testid="barn-session-menu"
        @select="onSessionSelect"
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
        <!-- Two facts about where the message goes, and neither is a control. -->
        <SChip :label="extension" icon="puzzle" />
        <SChip label="cluster: local" icon="server" />

        <!-- The paths that will be named in the message. Removable, because they are a choice. -->
        <SChip
          v-for="item in context"
          :key="item.path"
          :label="shortPath(item.path)"
          :icon="item.icon"
          :title="item.path"
          removable
          @remove="removeContext(item.path)"
        />

        <SChip
          label="Add"
          icon="plus"
          clickable
          data-testid="barn-add-context"
          @click="openPicker"
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
            :loading="attaching"
            title="Attach a file: it is written into the pod and named on the next message"
            data-testid="barn-attach-button"
            @click="$refs.attach.click()"
          />
          <input
            ref="attach"
            class="assistant-panel__file"
            type="file"
            multiple
            @change="onAttach"
          >
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
        {{ hint }}
      </div>
    </div>

    <!-- Picking a file out of the extension, from the Add chip. -->
    <SModal
      v-if="picking"
      title="Add a file to the context"
      icon="file"
      :width="560"
      @close="picking = false"
    >
      <p class="assistant-panel__say">
        Whatever is on the context chips is named in the line the assistant receives, so it
        looks at those files first. Paths are relative to the package in the pod.
      </p>
      <SField
        v-model="fileFilter"
        label="Find a file"
        placeholder="Part of a path or a name"
        autofocus
      />

      <div class="assistant-panel__picker">
        <button
          v-for="path in shownFiles"
          :key="path"
          type="button"
          class="assistant-panel__pick"
          @click="addFile(path)"
        >
          <SIcon name="file" :size="13" />
          <span class="assistant-panel__pick-path">{{ path }}</span>
        </button>

        <p v-if="!shownFiles.length" class="assistant-panel__say">
          {{ filesRead ? 'Nothing in the package matches that.' : 'Reading the package.' }}
        </p>
      </div>
    </SModal>
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

  // The paperclip's actual input. Hidden rather than absent: the button clicks it.
  &__file { display: none; }

  &__hint {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  &__say {
    margin: 0 0 var(--studio-space-12);
    font:   var(--studio-body-13);
    color:  var(--studio-text-secondary);
  }

  &__picker {
    display:        flex;
    flex-direction: column;
    margin-top:     var(--studio-space-12);
    max-height:     320px;
    overflow-y:     auto;
    border:         1px solid var(--studio-border-subtle);
    border-radius:  var(--studio-radius);
  }

  &__pick {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
    padding:     6px var(--studio-space-10);
    min-height:  0;
    background:  none;
    border:      none;
    text-align:  left;
    font:        var(--studio-mono-12);
    color:       var(--studio-text);
    cursor:      pointer;

    &:hover { background: var(--studio-surface-subtle); }
  }

  &__pick-path {
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }
}
</style>
