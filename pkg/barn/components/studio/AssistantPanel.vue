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
  assistantPermissions, devServerLog, interruptAssistant, assistantConversation, assistantModel,
  setAssistantModel, assistantMode, cycleAssistantMode
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
 *
 * Only used for the fallback reading. When there is a session open the chip repeats claude's
 * own status line instead (see MODE_LABELS), because that is the mode it is in now rather than
 * the one it was started in.
 */
const PERMISSION_LABELS = {
  bypass:          'Edits apply without asking',
  'accept-edits':  'Edits apply without asking',
  plan:            'Planning only, no edits',
  default:         'Asks before each file edit',
};

/**
 * The modes claude's own status line names, and what each one means for your files.
 *
 * These are targets to cycle to, not a claim about what this claude has: `cycleAssistantMode`
 * presses shift+tab until the status line says the wanted one and then reports the line it
 * ended on, so a claude whose cycle does not include one of these lands somewhere else and the
 * chip says where. The words are claude's, read off this pod - "bypass permissions", "accept
 * edits", "auto mode" all came off the pane in front of this - and if it renames one the
 * reading follows it while the target here stops matching, which shows up as a mode that
 * cannot be reached rather than as a chip that lies.
 */
const MODE_LABELS = {
  'bypass permissions': 'Edits apply without asking',
  'accept edits':       'File edits apply, everything else asks',
  'plan mode':          'Planning only, no edits',
  'auto mode':          'claude decides what to ask about',
};

/** How often the mode is re-read. It changes under you: shift+tab in the pane is all it takes. */
const MODE_POLL_MS = 20000;

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
      /**
       * What claude itself wrote, read out of its own transcript.
       *
       * The provenance log records that a turn happened; this is what the assistant said while
       * it was happening, which is the half of the design's turn (11:242) that never existed.
       * `null` until the first read, so "nothing recorded" and "not asked yet" stay different.
       */
      conversation: null,
      /** The model the pod's claude answers on, and the aliases it accepts. */
      modelInfo:  null,
      modelBusy:  '',
      /** The permission mode it is in now, off its own status line. */
      modeInfo:   null,
      modeBusy:   '',
      modeTimer:  null,
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
     * Which recorded turn each of claude's replies belongs to, matched on time and nothing else.
     *
     * The two records are written by different things and share no id: the provenance hooks
     * stamp a turn when claude receives a prompt, and claude stamps its own messages in its
     * transcript. What they do share is a clock, and the rule that follows from it is the only
     * one this can honestly use - a reply belongs to the last turn that had already started
     * when it was written. A reply written before any turn was recorded belongs to no turn and
     * is dropped rather than given to the first one.
     */
    repliesByTurn() {
      const out = new Map();
      const replies = this.conversation?.replies || [];
      // Oldest first. `podTurns` is newest first, and only a turn with a recorded prompt has a
      // start to compare against.
      const starts = [...this.podTurns].reverse()
        .map((turn) => ({ turn: turn.turn, at: Date.parse(turn.at || '') }))
        .filter((entry) => entry.turn && !Number.isNaN(entry.at));

      replies.forEach((reply) => {
        const at = Date.parse(reply.at || '');

        if (Number.isNaN(at)) {
          return;
        }

        let owner = '';

        starts.forEach((entry) => {
          if (entry.at <= at) {
            owner = entry.turn;
          }
        });

        if (!owner) {
          return;
        }

        if (!out.has(owner)) {
          out.set(owner, []);
        }

        out.get(owner).push(reply);
      });

      return out;
    },

    /**
     * The model chip in the composer's action bar (11:340, drawn "Claude Opus 5").
     *
     * A reading first: what the pod says its claude will answer on, in the pod's own spelling.
     * Nothing in the pod naming a model is a real answer and is said as one - claude then uses
     * whatever its account defaults to, and inventing a name for that would be the one thing
     * this panel does not do.
     */
    modelChip() {
      const info = this.modelInfo;

      if (!info) {
        return {
          label: 'Reading the model',
          title: 'Asking the pod which model its claude answers on.',
        };
      }

      if (!info.read) {
        return {
          label: 'Model not read',
          title: 'This extension\'s pod could not be asked which model its claude uses.',
        };
      }

      const where = {
        argv:     'the --model the running claude was started with',
        env:      'ANTHROPIC_MODEL in the pod',
        settings: '`model` in the pod\'s ~/.claude/settings.json, which is what claude\'s own /model writes',
        config:   '`model` in the pod\'s ~/.claude.json',
      }[info.source] || '';

      if (info.model) {
        return {
          label: info.model,
          title: `Read from ${ where }. Choosing another one sends claude's own /model to this pod's session, which changes the model from the next turn and is written back into the pod's settings, so it survives the pod restarting.`,
        };
      }

      return {
        label: 'Default model',
        title: 'Nothing in this pod names a model: no --model on the claude that is running, no ANTHROPIC_MODEL in its environment, and no `model` in claude\'s settings. So it answers on whatever that install defaults to, and there is nothing here to read a name off. Choosing one below sends claude\'s own /model, after which this names it.',
      };
    },

    /**
     * What the model menu offers: the aliases this pod's claude documents, and nothing else.
     *
     * Parsed out of the pod's own `claude --help` rather than listed here, because a list in
     * this file would be a claim about a program this bundle does not ship. When the help
     * cannot be parsed the menu says so and points at claude's own picker in the pane, which
     * is where the real list lives either way.
     */
    modelItems() {
      const aliases = this.modelInfo?.aliases || [];
      const current = this.modelInfo?.model || '';
      const items = aliases.map((alias) => ({
        id:       `model:${ alias }`,
        label:    alias,
        icon:     alias === current ? 'check' : 'sparkle',
        note:     alias === current ? 'in use' : '',
        disabled: !!this.modelBusy,
      }));

      if (!items.length) {
        items.push({
          id: 'model:none', label: 'No aliases were read from this pod\'s claude --help', disabled: true,
        });
      }

      items.push({ divider: true });
      items.push({
        id: 'model:pick', label: 'Choose in the terminal', note: '/model', icon: 'terminal',
      });

      return items;
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
        user when the Studio sent it, the assistant's own reply read out of claude's transcript, and the
        files the turn left behind. The per-step detail the design draws - a status and a duration for
        each step, and live progress on the one in flight - is not here, because the hooks record a
        turn's start, the files its editing tools touch and its end, and nothing in between. A reply
        that is a tool call rather than words has no text to show and is not counted as one.`.replace(/\s+/g, ' ');
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
     * The permission chip (11:226, 16:557): the mode the assistant is in *now*, and the one
     * control that actually changes it.
     *
     * Two readings, and the order between them is the whole point. `assistantMode` reads
     * claude's own status line in the pane ("bypass permissions on (shift+tab to cycle)"),
     * which is the mode it is in at this moment - it follows a shift+tab somebody pressed in
     * the Terminal tab a second ago. `assistantPermissions` reads the command line claude was
     * *started* with, which is only the mode it began in, and is all there is to read when no
     * session is open. The live one wins whenever there is one.
     *
     * The chip used to be a readout with no menu, on the argument that nothing here could
     * change the mode. That was half right. What cannot be changed from here is the mode claude
     * *starts* in: that is the argument in pod/claude-session.sh, which is seeded from this
     * bundle and written again on every page load, so anything this screen wrote there would be
     * overwritten by the next visit. What can be changed is the mode the running session is in,
     * because claude cycles that on shift+tab and a pane can be typed into - so the menu does
     * exactly that, and the chip then reports what claude's status line says it landed on
     * rather than what was asked for.
     */
    permissionChip() {
      const live = this.modeInfo;
      const perms = this.permissions;

      if (live?.read && live.session && live.mode) {
        const meaning = MODE_LABELS[live.mode] || '';

        return {
          label: meaning || live.mode,
          icon:  live.mode === 'plan mode' ? 'lock' : 'alert',
          tone:  live.mode === 'plan mode' ? 'info' : 'warning',
          title: `Read from claude's own status line in this pod's session, which is the mode it is in right now: "${ live.line.trim() }". Choosing another one below presses shift+tab in that session, which is claude's own way of changing it. The mode claude *starts* in is fixed by pod/claude-session.sh, which is seeded from this bundle and written again on every page load, so a session that restarts comes back on that one. Nothing the assistant edits reaches this Rancher until you publish.`,
        };
      }

      if (!perms && !live) {
        return {
          label: 'Reading the assistant\'s permissions',
          icon:  'clock',
          tone:  'default',
          title: 'Asking the pod what mode its claude is in.',
        };
      }

      if (!perms?.read || !perms?.mode) {
        return {
          label: 'Permissions not read',
          icon:  'alert',
          tone:  'default',
          title: perms?.read
            ? 'The pod answered, and no claude command line was found in it - neither a running process nor the session script. Open the Terminal tab to start one.'
            : 'This extension\'s pod could not be asked what mode its claude is in, so nothing here is known about what it may do.',
        };
      }

      const where = perms.source === 'process'
        ? 'the claude running in this pod'
        : 'this pod\'s session script, since no session is open yet';

      return {
        label: PERMISSION_LABELS[perms.mode] || `Permission mode: ${ perms.mode }`,
        icon:  perms.mode === 'default' ? 'lock' : 'alert',
        tone:  perms.mode === 'default' ? 'info' : 'warning',
        title: `No session is open in this pod, so there is no status line to read. This is the mode claude would start in, read from ${ where }: \`${ perms.argv }\`. Open the Terminal tab and the chip reports the running mode instead.`,
      };
    },

    /**
     * The modes the chip's menu offers, and what each does to your files.
     *
     * Targets rather than a claim: each one presses shift+tab until claude's status line says
     * that mode, and reports where it actually landed. One that this claude does not cycle
     * through is reachable by nothing and says so, which is why the list can be written down
     * without it becoming a lie about a program this bundle does not ship.
     */
    modeItems() {
      const current = this.modeInfo?.mode || '';
      const live = !!this.modeInfo?.session;
      const items = Object.entries(MODE_LABELS).map(([mode, meaning]) => ({
        id:       `mode:${ mode }`,
        label:    meaning,
        note:     mode === current ? 'in use' : mode,
        icon:     mode === current ? 'check' : 'lock',
        disabled: !live || !!this.modeBusy,
      }));

      items.push({ divider: true });

      if (!live) {
        items.push({
          id: 'mode:none', label: 'No session is open in this pod, so there is no mode to change', disabled: true,
        });
      }

      items.push({
        id: 'mode:terminal', label: 'Open the terminal', note: 'shift+tab', icon: 'terminal',
      });

      return items;
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

    // Once, and again when the extension changes: this is the mode claude was *started* in,
    // which cannot change without a restart, and it is only the fallback anyway.
    this.refreshPermissions();

    // The running mode does change while somebody watches: shift+tab in the Terminal tab is
    // all it takes, and a chip that went on claiming the old one would be the worst kind of
    // wrong here.
    this.refreshMode();
    this.modeTimer = setInterval(() => this.refreshMode(), MODE_POLL_MS);

    // The model is read once and again after it is changed. Nothing else moves it.
    this.refreshModel();

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
    clearInterval(this.modeTimer);
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
      this.modeInfo = null;
      this.modelInfo = null;
      this.conversation = null;
      this.rawOpen = false;
      this.rawText = '';
      this.rawError = '';
      this.refreshPermissions();
      this.refreshMode();
      this.refreshModel();
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

      // The same beat as the turns, because the two are drawn as one thing: a turn whose reply
      // arrived a second later would otherwise show as unanswered until the next poll.
      const said = await assistantConversation(asked, TURN_LIMIT * 2).catch(() => null);

      if (asked === this.extension && said) {
        this.conversation = said;
      }
    },

    async refreshMode() {
      const asked = this.extension;
      const mode = await assistantMode(asked).catch(() => ({
        read: false, session: false, mode: '', line: '',
      }));

      if (asked === this.extension) {
        this.modeInfo = mode;
      }
    },

    async refreshModel() {
      const asked = this.extension;
      const model = await assistantModel(asked).catch(() => ({
        read: false, model: '', source: '', aliases: [], session: false,
      }));

      if (asked === this.extension) {
        this.modelInfo = model;
      }
    },

    /**
     * Point the pod's claude at another model, and then read back what it is on.
     *
     * `/model` into the open session when there is one, which is claude's own command and which
     * claude itself persists into the pod's settings; the same settings key written directly
     * when there is no session to type into. Either way the chip is re-read afterwards rather
     * than relabelled, so what it says is what the pod says.
     */
    async chooseModel(alias) {
      if (this.modelBusy) {
        return;
      }

      this.modelBusy = alias;

      try {
        const how = await setAssistantModel(this.extension, alias);

        // claude takes a moment to write its settings after the command lands in the pane.
        await new Promise((resolve) => setTimeout(resolve, how === 'session' ? 2500 : 0));
        await this.refreshModel();

        toastSuccess(
          this.$store,
          how === 'session'
            ? `/model ${ alias } went to this pod's session, which is claude's own way of changing it. The chip now shows what the pod reports.`
            : `No session is open in this pod, so ${ alias } was written into claude's settings there. The next session starts on it.`,
          { title: 'Model changed' },
        );
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'The model did not change' });
      } finally {
        this.modelBusy = '';
      }
    },

    /**
     * Cycle the pod's session to a permission mode, the way a person at the pane would.
     *
     * shift+tab is claude's own control and there is no other: it moves to the next mode and
     * prints where it landed. So this presses it until the status line says the wanted mode, and
     * then says which mode it is actually in - never which one was asked for.
     */
    async chooseMode(mode) {
      if (this.modeBusy) {
        return;
      }

      this.modeBusy = mode;

      try {
        const now = await cycleAssistantMode(this.extension, mode);

        this.modeInfo = now;

        if (now.mode === mode) {
          toastSuccess(
            this.$store,
            `This pod's claude is now in ${ mode }. It stays there until the session restarts, which brings it back on the mode pod/claude-session.sh starts it in.`,
            { title: 'Permission mode changed' },
          );
        } else {
          toastError(
            this.$store,
            `shift+tab did not reach ${ mode } in this claude's cycle. It is in ${ now.mode || 'a mode with no status line' } instead, which is what the chip now says.`,
            { title: 'That mode was not reached' },
          );
        }
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'The mode did not change' });
      } finally {
        this.modeBusy = '';
      }
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
     * What the assistant said during a turn, as one block of prose.
     *
     * The design's assistant turn opens with the assistant's own words (11:242, 11:249) and for
     * a long time this panel had none to open with: the provenance hooks record that a turn
     * happened, never what was said in it. These are claude's own messages, out of its own
     * transcript, joined in the order it wrote them. A turn whose only output was tool calls
     * has no text and gets none.
     */
    saidIn(turn) {
      const replies = this.repliesByTurn.get(turn.turn) || [];
      const text = replies.map((reply) => (reply.text || '').trim()).filter(Boolean).join('\n\n');
      const models = [...new Set(replies.map((reply) => reply.model)
        .filter((model) => model && model !== '<synthetic>'))];

      return {
        text,
        // Only when every one of them is an error, so a turn that failed after saying something
        // useful is not drawn as nothing but a failure.
        failed: !!replies.length && replies.every((reply) => !!reply.error),
        model:  models.join(', '),
      };
    },

    /**
     * The assistant's half of a recorded turn: what it said, what it ended in, or that it has
     * not ended.
     *
     * No duration for a turn with no end, and no invented result for one. This is the ordinary
     * case in a pod whose claude is signed out: the prompt is delivered, the UserPromptSubmit
     * hook records it and the Stop hook never fires, so the turn stays open for good - and now
     * that claude's own reply is read too, such a turn shows the reply that explains it
     * ("Not logged in - Please run /login") instead of only reporting the silence.
     */
    outcomeEntry(turn) {
      const files = Array.isArray(turn.files) ? turn.files : [];
      const commit = (turn.commit || '').slice(0, 7);
      const n = files.length;
      const plural = n === 1 ? '' : 's';
      const said = this.saidIn(turn);

      if (!turn.endedAt) {
        const why = turn.at
          ? 'No end was recorded for this turn, so there is nothing yet to show for it.'
          : 'A turn was recorded with neither a prompt nor an end.';
        const open = turn.at ? `Started ${ this.ago(turn.at) } · no duration, because nothing recorded its end` : '';

        return {
          role:       'assistant',
          pending:    !said.text || said.failed,
          when:       '',
          text:       said.text || why,
          note:       said.text ? [why, open].filter(Boolean).join(' · ') : open,
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

      if (said.model) {
        facts.push(`Answered on ${ said.model }`);
      }

      let outcome;

      if (!turn.at) {
        // The rule the whole record is built on: a change nobody watched is reported as
        // unattributed, never handed to the nearest turn that does have a prompt.
        outcome = 'Changed in the pod with no prompt recorded.';
      } else if (commit) {
        outcome = 'Finished, and committed what it left behind.';
      } else if (n) {
        outcome = 'Finished. No commit was recorded for it.';
      } else {
        outcome = 'Finished without changing any files.';
      }

      return {
        role:       'assistant',
        pending:    false,
        // What the assistant said leads, as the design has it, and what the turn ended in drops
        // to the caption under it. With nothing said, the caption's sentence is all there is
        // and it leads instead.
        when:       this.ago(turn.endedAt),
        text:       said.text || outcome,
        note:       (said.text ? [outcome, ...facts] : facts).join(' · '),
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

    onModeSelect(id) {
      if (id === 'mode:terminal') {
        this.$emit('update:tab', 'terminal');

        return;
      }

      if (id.startsWith('mode:')) {
        this.chooseMode(id.slice('mode:'.length));
      }
    },

    onModelSelect(id) {
      if (id === 'model:pick') {
        // claude's own picker, in the pane, which is where the whole list lives. Typed without
        // an argument so it opens rather than choosing something.
        this.$emit('send', '/model');
        this.$emit('update:tab', 'terminal');

        return;
      }

      if (id.startsWith('model:')) {
        this.chooseModel(id.slice('model:'.length));
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
        The mode the pod's claude is in right now, read off its own status line, and the menu
        that changes it: each entry presses shift+tab in that session until claude says it is in
        that mode. The label is what claude reports afterwards, never what was asked for.

        The test id is on the label inside the trigger rather than on the menu, because an
        attribute on SMenu falls through to its wrapper div and a click there opens nothing. A
        click on the label is a click on the button it is inside.
      -->
      <SMenu
        :items="modeItems"
        aria-label="Permission mode"
        @select="onModeSelect"
      >
        <template #trigger>
          <SIcon :name="permissionChip.icon" :size="13" />
          <span
            class="assistant-panel__chip-label"
            :class="`assistant-panel__chip-label--${ permissionChip.tone }`"
            :title="permissionChip.title"
            data-testid="barn-permission-chip"
          >{{ permissionChip.label }}</span>
          <SIcon name="chevronDown" :size="12" />
        </template>
      </SMenu>
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
          message="Every prompt this pod's assistant receives is recorded as a turn - from the composer, from another Studio screen, or typed into the Terminal tab - with when it was sent, who sent it, what it replied and what it left behind."
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

          <!--
            The model chip (11:340). A reading of what the pod says its claude answers on, and a
            menu of the aliases that pod's own `claude --help` documents. Choosing one sends
            claude's own /model to the session, so the next turn uses it; the chip is then
            re-read rather than relabelled.
          -->
          <SMenu
            :items="modelItems"
            align="left"
            aria-label="Model"
            @select="onModelSelect"
          >
            <template #trigger>
              <SIcon :name="modelBusy ? 'clock' : 'sparkle'" :size="13" />
              <span
                class="assistant-panel__chip-label"
                :title="modelChip.title"
                data-testid="barn-model-chip"
              >{{ modelChip.label }}</span>
            </template>
          </SMenu>

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

  // The label inside a menu trigger, so a picker reads as the chip the design draws rather
  // than as a button. The tone follows the reading, which is the only thing that colours it.
  &__chip-label {
    font: var(--studio-caption-12);

    &--warning { color: var(--studio-warning); }
    &--info    { color: var(--studio-info); }
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
