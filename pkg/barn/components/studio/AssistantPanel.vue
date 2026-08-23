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
//   Half real. The activity stream. Your side of it is: every message the composer sends is a
//   turn, with the time it was sent, and it survives a reload. The assistant's side is not, and
//   is not faked - claude's output is a character stream, not a sequence of typed events, and
//   turning one into the other is a parser nobody has written. So the stream carries a standing
//   note under the last turn saying exactly that, and the strip beside it opens the terminal,
//   where the reply actually is. No invented steps, no invented durations.
//
//   Informational. The chip on the status row. The design's version says "Ask before each file
//   edit", and the pod runs `claude --dangerously-skip-permissions` (see pod/claude-session.sh)
//   - so the design's chip was the opposite of the truth, and there is no switch behind it to
//   make it true. It states what the session actually does instead, and is not clickable,
//   because there is nothing to press it for.
//
//   Real, and it had to be made so. The status row's dot and name. They used to report the
//   terminal's websocket and this Rancher's signed-in user, which is not the assistant's session
//   in either half: the row read "Connected as admin" in green while every turn in the pane came
//   back "Not logged in - Please run /login". It now reads the credential state of the claude in
//   the pod (assistantLogin), and says so plainly when there is none.
import {
  SIcon, SChip, SLabel, SButton, STabs, SEmpty, SMenu, SModal, SField
} from '../ui';
import ActivityTurn from './ActivityTurn.vue';
import { toastSuccess, toastError } from '../../toast';
import {
  countChanges, publishedVersion, listExtensionFiles, writePodImage, assistantLogin
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
      /**
       * What the pod's claude has to work with, read rather than assumed.
       *
       * `null` until the first read comes back: "not signed in" and "not asked yet" are
       * different things to say, and the strip says the second one while it is true.
       */
      login:      null,
      loginTimer: null,
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
     * What the strip says, and what colour its dot is.
     *
     * The credential first, because that is the fact that decides whether anything typed here
     * gets an answer. The row used to report the browser's websocket and this Rancher's
     * signed-in user - it read "Connected as admin" in green while every turn in the pane came
     * back "Not logged in - Please run /login", which is worse than the terminal line it was
     * meant to replace.
     *
     * The websocket is the second question and is appended rather than substituted: with the
     * composer going through tmux (see the page's sendToAssistant) a detached terminal no
     * longer stops a message reaching the pod, it only means you cannot watch the reply arrive.
     *
     * `tone`: ok | warn | unknown. The dot is green only for the first.
     */
    sessionState() {
      const detached = this.connected ? '' : ' · the terminal is not attached';

      if (!this.login) {
        return {
          tone:  'unknown',
          label: `Reading the assistant session${ detached }`,
          title: 'Asking the pod whether its claude has a credential to work with.',
        };
      }

      if (!this.login.read) {
        return {
          tone:  'unknown',
          label: `Cannot tell whether the assistant is signed in${ detached }`,
          title: 'The pod did not answer when asked about its claude credentials, so this says nothing rather than guessing.',
        };
      }

      if (!this.login.signedIn) {
        return {
          tone:  'warn',
          label: 'The assistant is not signed in · run /login in the terminal',
          title: 'There is no credential in this pod: no OAuth credentials file, no API key in its environment and no account in .claude.json. Every prompt sent from here comes back "Not logged in".',
        };
      }

      // Deliberately not falling back to the dashboard's own user here. An API key names
      // nobody, and filling that gap with whoever is signed in to Rancher is exactly the
      // substitution that made this row wrong in the first place.
      const who = this.login.account;

      return {
        tone:  detached ? 'warn' : 'ok',
        label: `${ who ? `Assistant signed in as ${ who }` : 'The assistant is signed in' }${ detached }`,
        title: 'Read from the credential the claude in this pod is running with.',
      };
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

    this.refreshLogin();
    // Half a minute, because this one does change while somebody is looking at it: running
    // /login in the pane below is exactly how it changes, and the strip that told you to do it
    // should notice that you did.
    this.loginTimer = setInterval(() => this.refreshLogin(), 30000);
  },

  beforeUnmount() {
    clearInterval(this.countTimer);
    clearInterval(this.loginTimer);
  },

  watch: {
    revision() {
      this.refreshChanges();
    },

    // Keep the newest turn in view, which is what a stream that grows while you watch has to
    // do. On a new turn only: the relative times in the meta lines are recomputed every second,
    // so the array's identity changes constantly and scrolling on every change of it would drag
    // the view back down under anybody reading further up.
    turns(next, prev) {
      if (next.length === (prev || []).length) {
        return;
      }

      // After the render, not with it - the element being scrolled to does not exist yet.
      this.$nextTick(() => {
        const stream = this.$refs.stream;

        if (stream) {
          stream.scrollTop = stream.scrollHeight;
        }
      });
    },

    extension() {
      this.changes = 0;
      this.version = '';
      this.login = null;
      this.refreshLogin();
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

    async refreshLogin() {
      this.login = await assistantLogin(this.extension)
        .catch(() => ({ read: false, signedIn: false, account: '' }));
    },

    submit() {
      const text = this.draft.trim();

      if (!text) {
        return;
      }

      this.draft = '';
      this.$emit('send', this.withContext(text));
      // Stay on the stream. This used to jump to the terminal, on the argument that the reply
      // arrives there - which was right when the stream had nothing in it and is wrong now that
      // it has your turn: being thrown to another tab the instant you press Send is how you
      // never see that the message was recorded at all. The strip under the last turn is the
      // way to the terminal, and it says so.
      this.$emit('update:tab', 'assistant');
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
        :class="`assistant-panel__dot--${ sessionState.tone }`"
      />
      <span
        class="assistant-panel__who"
        :title="sessionState.title"
        data-testid="barn-session-state"
      >{{ sessionState.label }}</span>
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
      <div
        v-show="tab === 'assistant'"
        ref="stream"
        class="assistant-panel__stream"
        data-testid="barn-activity-stream"
      >
        <template v-if="turns.length">
          <ActivityTurn
            v-for="(turn, i) in turns"
            :key="i"
            v-bind="turn"
            @raw="$emit('update:tab', 'terminal')"
          />

          <!--
            The other half of the stream, said rather than invented. Every turn above is a
            message this composer actually sent; the reply to it is a character stream in the
            pane below and nothing here parses it into steps. Rather than draw an assistant
            turn with made-up steps and made-up durations, the stream says what is missing and
            the strip goes to where the answer really is.
          -->
          <div class="assistant-panel__gap">
            <SIcon name="sparkle" :size="13" />
            <span>
              The assistant's replies are in the terminal. Its output is a character stream, not
              typed events, so this view cannot yet show them as steps with durations.
            </span>
          </div>

          <button
            type="button"
            class="assistant-panel__raw"
            data-testid="barn-open-raw-output"
            @click="$emit('update:tab', 'terminal')"
          >
            <SIcon name="terminal" :size="14" />
            <span class="assistant-panel__raw-label">Open the raw output</span>
            <span class="assistant-panel__grow" />
            <span class="assistant-panel__raw-note">the terminal is still here</span>
            <SIcon name="chevronRight" :size="13" />
          </button>
        </template>

        <SEmpty
          v-else
          icon="sparkle"
          title="Nothing sent in this session yet"
          message="What you send from the composer appears here as a turn. The assistant's own replies stay in the terminal: its output is a character stream, not typed events, so this view cannot yet show them as steps with durations."
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
          placeholder="Describe the next change - e.g. &quot;colour the bars by severity and add a 7-day toggle&quot;"
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

    &--ok      { background: var(--studio-success); }
    &--warn    { background: var(--studio-warning); }
    &--unknown { background: var(--studio-text-tertiary); }
  }

  &__who {
    font:  var(--studio-caption-12);
    color: var(--studio-text-secondary);
  }

  &__grow { flex: 1 1 auto; }

  // The standing note under the last turn: what the stream is not showing, and why.
  &__gap {
    display:       flex;
    align-items:   flex-start;
    gap:           6px;
    padding:       var(--studio-space-8) 10px;
    background:    var(--studio-surface-subtle);
    border:        1px dashed var(--studio-border);
    border-radius: var(--studio-radius);
    font:          var(--studio-caption-12);
    color:         var(--studio-text-tertiary);
  }

  // The design's collapsed raw-output strip (32:893). It opens the terminal rather than
  // expanding inline, because the terminal is the raw output - there is no second copy of it.
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
  &__raw-note  { font: var(--studio-caption-12); color: var(--studio-text-tertiary); }

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
