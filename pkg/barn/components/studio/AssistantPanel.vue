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
//   Real, and it was the last thing here that was not. The activity stream. It used to be this
//   tab's own record of what the composer had sent and nothing else, because claude's output in
//   the pane is a character stream rather than a sequence of events. It is now fed by the pod:
//   claude's own UserPromptSubmit, PostToolUse and Stop hooks write /app/.barn/provenance.jsonl
//   and `assistantTurns()` reads it back, so the stream shows every turn the pod recorded -
//   prompts typed straight into the Terminal tab included - with when it was sent, the screen
//   and Rancher user when the product itself sent it, the files the turn left and the commit it
//   ended in.
//
//   Two sources, merged rather than swapped. The composer's own messages are still kept in
//   sessionStorage by the page and still passed in as `turns`, because a message that has just
//   been sent is in the stream before the pod has recorded it. A message that appears in both is
//   counted once, matched on the text that was actually sent.
//
//   What is still not here, and is not faked: steps. Nothing in the pod records a step, a step's
//   status, a step's duration or live sub-progress - the hooks fire on a prompt, on a
//   file-editing tool and at the end of a turn, and nothing between - so no step row is drawn,
//   the stream says so under the last turn. A turn with no end recorded is drawn as exactly
//   that and given no duration: this pod's claude can be signed out, in which case a prompt is
//   recorded and the Stop hook never fires for it.
//
//   Real, and it is the compile rather than the conversation. The raw-output strip (32:893)
//   expands in place, and what it expands is the dev server's own output - `vue-cli-service
//   serve`, the command the design labels the strip with and the command the pod runs - read
//   out of the pod's log. claude's own stream is a different thing and stays in the Terminal
//   tab, which the strip still points at.
//
//   A reading, not a switch. The permission chip on the status row. The design draws a picker
//   (11:226) and there is nothing to pick with: the mode is fixed by the arguments claude is
//   started with, in a session script seeded from this bundle and written again on every page
//   load. So the chip reports the mode it found in the pod - `assistantPermissions` reads the
//   running process, or the script when no session is open - and shows the command line it
//   read it off. If that command line ever changes, the chip changes with it.
//
//   Real, and it can only claim what it did. Stop (11:347) presses Escape in the pane, which is
//   claude's own interrupt. Nothing records a turn starting, so the button cannot know whether
//   there was something to interrupt, and the toast says the keystroke was delivered rather
//   than that a run was halted.
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
  countChanges, publishedVersion, listExtensionFiles, writePodImage, assistantLogin, assistantTurns,
  assistantPermissions, devServerLog, interruptAssistant
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

/**
 * How often the pod is asked for its turns.
 *
 * It is an exec into the pod, so not every second; but it is the one thing on this panel that
 * moves while somebody watches it - the assistant is working in the pane below - so not the
 * minute the changes count uses either.
 */
const TURNS_POLL_MS = 15000;

/**
 * How long after a send before asking again.
 *
 * The prompt goes into the pane through tmux and the hook that records it runs when claude
 * receives it, which is not instant. This is the one extra read that turns "your message is in
 * the stream" into "the pod has it", and after it the ordinary poll takes over.
 */
const SEND_SETTLE_MS = 4000;

/** How many turns are read back. A conversation, not an archive. */
const TURN_LIMIT = 25;

/**
 * The raw output strip (32:893), and what has to come off the log before it can be read.
 *
 * A container log keeps every control sequence the program wrote, and webpack's progress
 * plugin redraws one line hundreds of times a compile. Stripped and collapsed, what is left is
 * the compile's own output, which is what the strip's label names. The pane says it has been
 * tidied rather than calling it verbatim.
 */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const PROGRESS = /^\[\s*\d{1,3}%\]/;

/** How much of the dev server's log to read, and how much of it to draw. */
const LOG_TAIL = 600;
const LOG_LINES = 200;

/**
 * What the permission chip says for each mode claude can be started in.
 *
 * The design's label is "Ask before each file edit" (11:226), which is claude's `default`
 * mode - so that wording is here, on the mode it is true of, and the others say what they are.
 */
const PERMISSION_LABELS = {
  bypass:          'Edits apply without asking',
  'accept-edits':  'Edits apply without asking',
  plan:            'Planning only, no edits',
  default:         'Asks before each file edit',
};

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
     * What this tab has sent from the composer, oldest first, as `{ role, text, when }`.
     *
     * The page's own record, kept in sessionStorage so a reload does not lose it. It is not the
     * whole stream and no longer pretends to be: the pod's record is read here and the two are
     * merged, with a message that appears in both counted once. This half still matters because
     * it is the half that exists the instant Send is pressed, before any hook has run.
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
      /**
       * How the pod's claude was started, which is what its permission mode is.
       *
       * `null` until the first read, for the reason `login` is: the chip says it is reading
       * rather than asserting a mode nobody has looked for yet.
       */
      permissions: null,
      // Set while the interrupt is on its way to the pane.
      stopping:    false,
      // The dev server's own output, under the strip the design draws collapsed (32:893).
      rawOpen:     false,
      rawText:     '',
      rawState:    '',
      rawError:    '',
      /**
       * The turns the pod recorded, newest first, exactly as `assistantTurns` returns them.
       *
       * `podRead` is false until the first answer comes back, because "the pod has recorded
       * nothing" and "the pod has not been asked yet" are different things to put on screen.
       */
      podTurns:   [],
      podRead:    false,
      turnsTimer: null,
      sendTimer:  null,
      // Ticked so that "2 minutes ago" on a turn counts up rather than freezing at what it
      // said when the pod was last read.
      now:        Date.now(),
      nowTimer:   null,
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

    /**
     * The stream itself: the pod's record, then whatever this composer has sent that is not in
     * it yet.
     *
     * Oldest first, because the stream scrolls to the bottom. The pod answers newest first.
     *
     * The merge is a count rather than a set, so that sending the same sentence twice and
     * having only the first recorded still shows two turns. Matching is on the text that was
     * actually sent: `askAssistant` flattens whitespace before it types, and the hook records
     * what claude received, so the two agree after the same flattening.
     *
     * Each entry is `{ key, props }` rather than a bare props object, because the array is
     * rebuilt every second by the clock and a turn keyed by its position would hand one turn's
     * expanded file list to another the moment a new turn arrives.
     */
    stream() {
      const recorded = [...this.podTurns].reverse();
      const out = [];
      const unmatched = new Map();

      recorded.forEach((turn) => {
        const text = this.flatten(turn.prompt);

        if (text) {
          unmatched.set(text, (unmatched.get(text) || 0) + 1);
        }

        this.recordedEntries(turn).forEach((props) => {
          out.push({ key: `${ turn.turn }-${ props.role }`, props });
        });
      });

      this.turns.forEach((turn, i) => {
        const text = this.flatten(turn.text);
        const left = unmatched.get(text) || 0;

        // Already in the stream, from the pod's own record of it, which is the richer one.
        if (text && left > 0) {
          unmatched.set(text, left - 1);

          return;
        }

        out.push({
          key:   `composer-${ i }`,
          props: {
            role: 'user',
            text: turn.text || '',
            when: turn.when || '',
            note: 'Sent from this composer · the pod has not recorded it yet',
          },
        });
      });

      return out;
    },

    /** Watched rather than the array, which is rebuilt every second by the clock above. */
    streamLength() {
      return this.stream.length;
    },

    /**
     * The standing note under the last turn: what the stream is showing and what it is not.
     *
     * The second half is the one that matters and it has to keep being said, because the panel
     * looks complete without it: no step in the design's sense is recorded anywhere, so no step
     * row is drawn.
     */
    streamNote() {
      return `Each turn above is what the pod recorded for it: the prompt, when it was sent, the screen and
        user when the Studio sent it, and the files the turn left behind. The per-step detail the design
        draws - a status and a duration for each step, and live progress on the one in flight - is not
        here, because the hooks record a turn's start, the files its editing tools touch and its end, and
        nothing in between. The replies themselves are in the terminal.`.replace(/\s+/g, ' ');
    },

    /**
     * Why nothing in this stream ever finishes, when that is the reason.
     *
     * Said only when the pod has actually been asked and answered that it has no credential.
     * Without it a stream of turns that all read "no completion recorded" looks like a broken
     * panel rather than a signed-out assistant.
     */
    streamStalled() {
      if (!this.login?.read || this.login.signedIn) {
        return '';
      }

      if (!this.podTurns.some((turn) => !turn.endedAt)) {
        return '';
      }

      return `No turn here has an end recorded because the assistant in this pod is not signed in: the
        prompt is delivered and nothing answers it. Run /login in the terminal and the turns after that
        will carry a duration and a commit.`.replace(/\s+/g, ' ');
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
     * The permission chip (11:226, 16:557), which reports a mode rather than setting one.
     *
     * Read from the pod: `assistantPermissions` looks at the claude process that is running in
     * there, and at the session script when no session has been opened yet. The design draws a
     * picker, and there is nothing here to pick with - the mode is fixed by the arguments claude
     * is started with, in a script that is seeded from this bundle and re-written on every page
     * load - so the chip states the mode it found and the tooltip shows the command line it
     * read it off. A menu that relabelled a chip without changing what the assistant does would
     * be the one thing this product does not do.
     */
    permissionChip() {
      const perms = this.permissions;

      if (!perms) {
        return {
          label: 'Reading the assistant\'s permissions',
          icon:  'clock',
          tone:  'default',
          title: 'Asking the pod how its claude was started.',
        };
      }

      if (!perms.read || !perms.mode) {
        return {
          label: 'Permissions not read',
          icon:  'alert',
          tone:  'default',
          title: perms.read
            ? 'The pod answered, and no claude command line was found in it - neither a running process nor the session script. Open the Terminal tab to start one.'
            : 'This extension\'s pod could not be asked how its claude was started, so nothing here is known about what it may do.',
        };
      }

      const where = perms.source === 'process'
        ? 'the claude running in this pod'
        : 'this pod\'s session script, since no session is open yet';

      return {
        label: PERMISSION_LABELS[perms.mode] || `Permission mode: ${ perms.mode }`,
        icon:  perms.mode === 'default' ? 'lock' : 'alert',
        tone:  perms.mode === 'default' ? 'info' : 'warning',
        title: `Read from ${ where }: \`${ perms.argv }\`. The mode is fixed when claude starts, by pod/claude-session.sh, which is seeded from this extension bundle and written again on every page load - so there is nothing on this screen that could change it. Nothing the assistant edits reaches this Rancher until you publish.`,
      };
    },

    /** The dev server's output, tidied enough to be readable in a pre. */
    rawLines() {
      if (!this.rawText) {
        return [];
      }

      const lines = [];

      this.rawText.replace(ANSI, '').split('\n').forEach((line) => {
        const text = line.replace(/\r/g, '').trimEnd();

        // The progress plugin's redraws, and the same line written twice in a row, are the
        // whole of the noise. Everything else is what the compile said.
        if (!text.trim() || PROGRESS.test(text.trim()) || text === lines[lines.length - 1]) {
          return;
        }

        lines.push(text);
      });

      return lines.slice(-LOG_LINES);
    },

    rawNote() {
      if (this.rawState === 'reading') {
        return 'Reading the dev server\'s output.';
      }

      if (this.rawError) {
        return this.rawError;
      }

      return 'The dev server has written nothing this side of the log it keeps.';
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

    // Once, and again when the extension changes: the mode is fixed when claude starts, so
    // there is nothing here for a poll to notice.
    this.refreshPermissions();

    this.refreshLogin();
    // Half a minute, because this one does change while somebody is looking at it: running
    // /login in the pane below is exactly how it changes, and the strip that told you to do it
    // should notice that you did.
    this.loginTimer = setInterval(() => this.refreshLogin(), 30000);

    this.refreshTurns();
    this.turnsTimer = setInterval(() => this.refreshTurns(), TURNS_POLL_MS);
    this.nowTimer = setInterval(() => {
      this.now = Date.now();
    }, 1000);
  },

  beforeUnmount() {
    clearInterval(this.countTimer);
    clearInterval(this.loginTimer);
    clearInterval(this.turnsTimer);
    clearInterval(this.nowTimer);
    clearTimeout(this.sendTimer);
  },

  watch: {
    revision() {
      this.refreshChanges();
    },

    // Keep the newest turn in view, which is what a stream that grows while you watch has to
    // do. On a new turn only: the relative times in the meta lines are recomputed every second,
    // so the array's identity changes constantly and scrolling on every change of it would drag
    // the view back down under anybody reading further up.
    streamLength() {
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
      this.permissions = null;
      this.rawOpen = false;
      this.rawText = '';
      this.rawError = '';
      this.refreshPermissions();
      this.podTurns = [];
      this.podRead = false;
      this.refreshLogin();
      this.refreshTurns();
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

    async refreshPermissions() {
      const asked = this.extension;
      const perms = await assistantPermissions(asked).catch(() => ({
        read: false, running: false, mode: '', argv: '', source: '',
      }));

      if (asked === this.extension) {
        this.permissions = perms;
      }
    },

    /**
     * The design's collapsed raw-output strip (32:893), expanded in place.
     *
     * What expands is the dev server's own output - `vue-cli-service serve`, which is the
     * command the strip is labelled with and the one the pod actually runs. It is read out of
     * the pod's log rather than out of the terminal, because the terminal is claude's pane and
     * the compile happens beside it, in PID 1.
     */
    /**
     * The design's Stop (11:347), which presses Escape in the pane the assistant runs in.
     *
     * Drawn beside Send rather than replacing it, as the design draws it, and always available:
     * nothing in this pod records a turn beginning, so the panel cannot know whether there is
     * something to interrupt - and a button that greyed itself out on a guess would be wrong
     * exactly when it was needed. The toast says what was delivered, never that a run stopped.
     */
    async stopAssistant() {
      if (this.stopping) {
        return;
      }

      this.stopping = true;

      try {
        const how = await interruptAssistant(this.extension);

        if (how === 'none') {
          toastSuccess(
            this.$store,
            'There is no session open in this pod, so there was nothing to interrupt.',
            { title: 'Nothing running' },
          );
        } else {
          toastSuccess(
            this.$store,
            'Escape went to the session, which is how the assistant is interrupted. Whether it was in the middle of something is only visible in the Terminal tab.',
            { title: 'Interrupt sent' },
          );
        }
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'The interrupt did not reach the pod' });
      } finally {
        this.stopping = false;
      }
    },

    async toggleRaw() {
      this.rawOpen = !this.rawOpen;

      if (this.rawOpen) {
        await this.readRaw();
      }
    },

    async readRaw() {
      const asked = this.extension;

      this.rawState = 'reading';
      this.rawError = '';

      try {
        const text = await devServerLog(asked, LOG_TAIL);

        if (asked !== this.extension) {
          return;
        }

        this.rawText = text;
        this.rawError = text ? '' : `${ asked } has no running pod, so there is no dev server output to read.`;
      } catch (e) {
        this.rawText = '';
        this.rawError = e?.message || String(e);
      } finally {
        this.rawState = '';
      }
    },

    async refreshTurns() {
      const asked = this.extension;
      const turns = await assistantTurns(asked, TURN_LIMIT).catch(() => []);

      // The answer to a question about the extension that is no longer open is not an answer
      // about this one. Switching pods while an exec is in flight is otherwise how a stream
      // ends up showing another extension's conversation.
      if (asked !== this.extension) {
        return;
      }

      this.podTurns = Array.isArray(turns) ? turns : [];
      this.podRead = true;
    },

    /** The one line `askAssistant` types, which is what the hook on the other end records. */
    flatten(text) {
      return String(text || '').replace(/\s+/g, ' ').trim();
    },

    /**
     * One recorded turn, as the stream's entries: your side, then the assistant's.
     *
     * Two entries and not one, because the design's stream alternates and because the two
     * halves are recorded by different hooks and can exist without each other. A turn with no
     * prompt record has no user entry at all - it is a commit the pod made with nothing asked
     * for it - and the assistant entry says exactly that rather than borrowing the prompt above.
     */
    recordedEntries(turn) {
      const entries = [];

      if (turn.at) {
        entries.push({
          role: 'user',
          text: turn.prompt || 'The prompt for this turn was not recorded.',
          when: this.ago(turn.at),
          note: this.originNote(turn),
        });
      }

      entries.push(this.outcomeEntry(turn));

      return entries;
    },

    /**
     * Where a prompt came from, and never a guess at it.
     *
     * Only prompts the Studio sent leave an origin stamp, so a prompt typed straight into the
     * Terminal tab carries no screen and no name. That is reported rather than filled in with
     * whoever is signed in to this Rancher, which is the substitution the whole provenance
     * system exists to avoid.
     */
    originNote(turn) {
      const screen = (turn.screen || '').trim();
      const who = (turn.who || '').trim();

      if (screen && who) {
        return `Sent from the ${ screen } screen by ${ who }`;
      }

      if (screen) {
        return `Sent from the ${ screen } screen · no Rancher user recorded`;
      }

      if (who) {
        return `Sent by ${ who }`;
      }

      return 'Recorded in the pod · no screen and no Rancher user recorded for it';
    },

    /**
     * The assistant's half of a recorded turn: what it ended in, or that it has not ended.
     *
     * No duration for a turn with no end, and no invented result for one. This is the ordinary
     * case in a pod whose claude is signed out: the prompt is delivered, the UserPromptSubmit
     * hook records it and the Stop hook never fires, so the turn stays open for good.
     */
    outcomeEntry(turn) {
      const files = Array.isArray(turn.files) ? turn.files : [];
      const commit = (turn.commit || '').slice(0, 7);
      const n = files.length;
      const plural = n === 1 ? '' : 's';

      if (!turn.endedAt) {
        return {
          role:       'assistant',
          pending:    true,
          when:       '',
          text:       turn.at
            ? 'No end was recorded for this turn, so there is nothing yet to show for it.'
            : 'A turn was recorded with neither a prompt nor an end.',
          note:       turn.at ? `Started ${ this.ago(turn.at) } · no duration, because nothing recorded its end` : '',
          files,
          filesLabel: n ? `${ n } file${ plural } its editing tools have touched so far` : '',
        };
      }

      const took = this.lasted(turn.at, turn.endedAt);
      const facts = [];

      // Only ever measured between two recorded timestamps. A turn with no prompt record has
      // an end and no start, and gets no duration rather than one counted from somewhere else.
      if (took) {
        facts.push(`Took ${ took }`);
      }

      if (commit) {
        facts.push(`Commit ${ commit }`);
      }

      let text;

      if (!turn.at) {
        // The rule the whole record is built on: a change nobody watched is reported as
        // unattributed, never handed to the nearest turn that does have a prompt.
        text = 'Changed in the pod with no prompt recorded.';
      } else if (commit) {
        text = 'Finished, and committed what it left behind.';
      } else if (n) {
        text = 'Finished. No commit was recorded for it.';
      } else {
        text = 'Finished without changing any files.';
      }

      return {
        role:       'assistant',
        pending:    false,
        when:       this.ago(turn.endedAt),
        text,
        note:       facts.join(' · '),
        files,
        filesLabel: n
          ? `${ n } file${ plural } ${ commit ? 'in this turn\'s commit' : 'its editing tools touched' }`
          : '',
      };
    },

    /** The design's meta line words, from an ISO timestamp the pod wrote. */
    ago(iso) {
      const at = Date.parse(iso || '');

      if (Number.isNaN(at)) {
        return '';
      }

      const secs = Math.max(0, Math.round((this.now - at) / 1000));

      if (secs < 10) {
        return 'just now';
      }

      if (secs < 60) {
        return `${ secs } seconds ago`;
      }

      const mins = Math.round(secs / 60);

      if (mins < 60) {
        return `${ mins } minute${ mins === 1 ? '' : 's' } ago`;
      }

      const hours = Math.round(mins / 60);

      if (hours < 48) {
        return `${ hours } hour${ hours === 1 ? '' : 's' } ago`;
      }

      return `${ Math.round(hours / 24) } days ago`;
    },

    /** How long a turn took. Only ever between two timestamps that both exist. */
    lasted(from, to) {
      const a = Date.parse(from || '');
      const b = Date.parse(to || '');

      if (Number.isNaN(a) || Number.isNaN(b) || b < a) {
        return '';
      }

      const ms = b - a;

      if (ms < 10000) {
        return `${ (ms / 1000).toFixed(1) }s`;
      }

      const secs = Math.round(ms / 1000);

      if (secs < 60) {
        return `${ secs }s`;
      }

      const mins = Math.floor(secs / 60);

      return `${ mins }m ${ secs % 60 }s`;
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

      // Ask the pod again shortly, so the turn stops being "not recorded yet" as soon as it is
      // recorded rather than at the end of the poll it happened to land in.
      clearTimeout(this.sendTimer);
      this.sendTimer = setTimeout(() => this.refreshTurns(), SEND_SETTLE_MS);
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
        The mode the pod's claude is actually running in, read from it. Informational, because
        the mode is fixed when claude starts and nothing on this screen restarts it.
      -->
      <SChip
        :label="permissionChip.label"
        :icon="permissionChip.icon"
        :tone="permissionChip.tone"
        :title="permissionChip.title"
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
        <template v-if="stream.length">
          <ActivityTurn
            v-for="entry in stream"
            :key="entry.key"
            v-bind="entry.props"
            data-testid="barn-turn"
            @raw="$emit('update:tab', 'terminal')"
          />

          <!--
            What the stream is showing and what it is not. The turns above are the pod's own
            record; the steps the design draws under an assistant turn are not recorded by
            anything, so none is drawn and this says why rather than inventing four rows with
            statuses and durations nobody measured.
          -->
          <div class="assistant-panel__gap" data-testid="barn-stream-note">
            <SIcon name="sparkle" :size="13" />
            <span>{{ streamNote }}</span>
          </div>

          <!-- Why every turn here is open, when that is the reason. Read from the pod. -->
          <div
            v-if="streamStalled"
            class="assistant-panel__gap assistant-panel__gap--warn"
            data-testid="barn-stream-stalled"
          >
            <SIcon name="alert" :size="13" />
            <span>{{ streamStalled }}</span>
          </div>

          <!--
            The raw output strip (32:893): collapsed, and it opens in place. What it opens is
            the dev server's own output, which is the command the design labels the strip with.
            The terminal is still one line away, because claude's own stream is in there and
            this is not it.
          -->
          <div class="assistant-panel__raw-panel">
            <button
              type="button"
              class="assistant-panel__raw"
              :aria-expanded="rawOpen"
              data-testid="barn-open-raw-output"
              @click="toggleRaw"
            >
              <SIcon name="terminal" :size="14" />
              <span class="assistant-panel__raw-label">
                {{ rawOpen ? 'Hide raw output' : 'Show raw output' }}
              </span>
              <span class="assistant-panel__raw-cmd">vue-cli-service serve</span>
              <span class="assistant-panel__grow" />
              <span class="assistant-panel__raw-note">the terminal is still here</span>
              <SIcon :name="rawOpen ? 'chevronUp' : 'chevronDown'" :size="13" />
            </button>

            <template v-if="rawOpen">
              <pre
                v-if="rawLines.length"
                class="assistant-panel__raw-body"
                data-testid="barn-raw-output"
              >{{ rawLines.join('\n') }}</pre>

              <p v-else class="assistant-panel__raw-empty">
                {{ rawNote }}
              </p>

              <div class="assistant-panel__raw-foot">
                <span class="assistant-panel__raw-note">
                  The pod's own log, with the progress redraws and the terminal control codes
                  taken out. The last {{ rawLines.length }} of them.
                </span>
                <span class="assistant-panel__grow" />
                <SButton
                  variant="ghost"
                  size="sm"
                  icon="refresh"
                  :loading="rawState === 'reading'"
                  data-testid="barn-raw-output-reread"
                  @click="readRaw"
                >
                  Re-read
                </SButton>
                <SButton
                  variant="ghost"
                  size="sm"
                  icon="terminal"
                  @click="$emit('update:tab', 'terminal')"
                >
                  Open the terminal
                </SButton>
              </div>
            </template>
          </div>
        </template>

        <SEmpty
          v-else
          icon="sparkle"
          :title="podRead ? 'No turn has been recorded for this extension' : 'Reading what this pod has recorded'"
          message="Every prompt this pod's assistant receives is recorded as a turn - from the composer, from another Studio screen, or typed into the Terminal tab - with when it was sent, who sent it and what it left behind. The replies themselves stay in the terminal."
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
          <!--
            Stop beside Send, as the design draws it (11:347). It presses Escape in the pane,
            which is claude's own interrupt; see interruptAssistant for what it cannot claim.
          -->
          <SButton
            variant="ghost"
            size="sm"
            icon="stop"
            :loading="stopping"
            title="Presses Escape in this pod's session, which is how the assistant is interrupted. Nothing here can see whether it is working right now, so this is always available."
            data-testid="barn-stop-assistant"
            @click="stopAssistant"
          >
            Stop
          </SButton>
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

    // The same note, when what it is saying is a problem rather than a boundary.
    &--warn {
      background:   var(--studio-warning-bg);
      border-color: var(--studio-warning);
      border-style: solid;
      color:        var(--studio-text-secondary);
    }
  }

  // The design's collapsed raw-output strip (32:893), and what it expands into.
  &__raw-panel {
    display:        flex;
    flex-direction: column;
    border:         1px solid var(--studio-border);
    border-radius:  var(--studio-radius);
    overflow:       hidden;
  }

  &__raw-body {
    margin:     0;
    padding:    var(--studio-space-8) var(--studio-space-12);
    max-height: 260px;
    overflow:   auto;
    background: var(--studio-surface-sunken);
    border-top: 1px solid var(--studio-border-subtle);
    font:       var(--studio-mono-12);
    color:      var(--studio-text-secondary);
    white-space: pre;
  }

  &__raw-empty {
    margin:     0;
    padding:    var(--studio-space-8) var(--studio-space-12);
    border-top: 1px solid var(--studio-border-subtle);
    font:       var(--studio-caption-12);
    color:      var(--studio-text-tertiary);
  }

  &__raw-foot {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
    padding:     var(--studio-space-4) var(--studio-space-8);
    border-top:  1px solid var(--studio-border-subtle);
  }

  &__raw-cmd {
    font:  var(--studio-mono-12);
    color: var(--studio-text-tertiary);
  }

  &__raw {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
    width:       100%;
    padding:     9px var(--studio-space-12);
    background:  var(--studio-surface-subtle);
    border:      none;
    color:       var(--studio-text-secondary);
    cursor:      pointer;
    text-align:  left;

    &:hover { background: var(--studio-surface); }
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
