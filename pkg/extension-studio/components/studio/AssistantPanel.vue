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
  SIcon, SChip, SLabel, SButton, STabs, SEmpty, SMenu
} from '../ui';
import ActivityTurn from './ActivityTurn.vue';
import ImagePreview from './ImagePreview.vue';
import { toastSuccess, toastError } from '../../toast';
import AssistantLoginModal from './AssistantLoginModal.vue';
import { padded } from '../../change-regions';
import { promptSaid, promptContextChips } from '../../prompt-context';
import { stickToBottom } from '../../stick-to-bottom';
import {
  countChanges, publishedVersion, writePodImage, assistantLogin, assistantTurns, approvalState,
  devServerLog, interruptAssistant, assistantConversation,
  readPodImage, elementShot, startNewConversation, conversationSince
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
// eslint-disable-next-line no-control-regex -- the escape character is what is being stripped
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const PROGRESS = /^\[\s*\d{1,3}%\]/;

/** How much of the dev server's log to read, and how much of it to draw. */
const LOG_TAIL = 600;
const LOG_LINES = 200;





export default {
  name: 'AssistantPanel',

  components: {
    SIcon, SChip, SLabel, SButton, STabs, SEmpty, SMenu, ActivityTurn, ImagePreview,
    AssistantLoginModal
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
    // The route the preview is showing. It is context in the plainest sense:
    // "make this page do X" is the usual thing to say, and the assistant was
    // never told which page was on screen when it was said.
    page: {
      type:    String,
      default: '',
    },

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

  emits: ['update:tab', 'send', 'review', 'reconnect', 'context', 'cleared'],

  data() {
    return {
      draft:      '',
      changes:    0,
      version:    '',
      countTimer: null,
      /**
       * The paths that go with the next message, as `{ path, icon }`.
       *
       * Files attached from this machine - pasted into the composer or chosen with the
       * paperclip - as paths in the pod that the assistant is told about.
       */
      context:    [],
      // The sign-in dialog, opened from the status strip when the pod has no credential.
      signingIn:  false,
      // Set while a file is on its way into the pod.
      attaching:  false,
      /**
       * The attachment being looked at full size, as `{ path, name, src, loading, error }`,
       * or null when the viewer is closed. The bytes are read on open rather than with the
       * chip: a conversation with six screenshots attached would otherwise hold six of them
       * in memory as data URLs for a viewer nobody opened.
       */
      preview:    null,
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
      /** The permission mode it is in now, off its own status line. */
      sendTimer:  null,
      // Ticked so that "2 minutes ago" on a turn counts up rather than freezing at what it
      // said when the pod was last read.
      // The bottom-pinning handle for the stream. Not reactive: it holds DOM listeners, and
      // nothing renders from it.
      streamPin:  null,
      // Where the conversation on screen begins. Everything the pod recorded before this
      // belongs to a previous one and is not drawn - see startNewConversation.
      since:      '',
      now:        Date.now(),
      nowTimer:   null,
    };
  },

  computed: {
    tabs() {
      // Files is deliberately absent, not deleted. Its pane below is intact and
      // still renders when `tab === 'files'`; it is only unreachable from the
      // strip, so bringing it back is putting this line back:
      //
      //   { id: 'files', label: 'Files', icon: 'file' },
      //
      // The file tree is still reachable meanwhile - "Files and history" in the
      // masthead's overflow opens the screen that owns it.
      // No Terminal tab. The pane itself is still here and still reachable - the status
      // strip's "Open the terminal", the permission menu's shift+tab entry and the masthead
      // overflow all switch to it - but it is not one of the two things this panel is for.
      // Anything that has to be typed at claude's own prompt (/login most of all) still goes
      // through those.
      return [
        { id: 'assistant', label: 'Assistant', icon: 'sparkle' },
        {
          id: 'changes', label: 'Changes', icon: 'compare', count: this.changes || null,
        },
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
    /**
     * Whether the session's own replies say its login has stopped working.
     *
     * The credential check below reads a file, and a file says nothing about the process: the
     * claude in a pod reads its credential when it starts and holds it, so a session can be
     * running with an expired login, or stuck in a login prompt, while a perfectly good
     * credential sits on disk beside it. That is not a corner case - it is what happens to
     * every pod whose session outlives its token, and the strip cheerfully said "signed in"
     * over a conversation whose every reply was "Login expired · Please run /login".
     *
     * So the newest reply is read too. These are claude's own words, not a guess: it says them
     * in place of the answer, which is exactly when somebody needs to be told.
     */
    sessionRefused() {
      const newest = [...this.podTurns].find((turn) => this.saidIn(turn).text);
      const said = newest ? this.saidIn(newest).text : '';

      return /login expired|please run \/login|not logged in|invalid bearer token|401/i.test(said);
    },

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
          label: 'The assistant is not signed in',
          title: 'There is no credential in this pod: no OAuth credentials file, no API key in its environment and no account in .claude.json. Every prompt sent from here comes back "Not logged in".',
        };
      }

      // Deliberately not falling back to the dashboard's own user here. An API key names
      // nobody, and filling that gap with whoever is signed in to Rancher is exactly the
      // substitution that made this row wrong in the first place.
      const who = this.login.account;

      // A credential on disk and a session that cannot use it.
      if (this.sessionRefused) {
        return {
          tone:  'warn',
          label: `The assistant's login has expired${ detached }`,
          title: 'There is a credential in this pod, but the claude running here is answering "Login expired". It read its credential when it started and has held it since, so signing in again - which restarts the session - is what picks up the new one.',
        };
      }

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

        // Only the newest recorded turn can still be running. See recordedEntries.
        const entries = this.recordedEntries(turn, turn === recorded[recorded.length - 1])
          .map((props) => ({ key: `${ turn.turn }-${ props.role }`, props }));

        // One group, sorted as one: a turn's prompt and its reply belong together in that order
        // whatever else is interleaved around them.
        out.push({ at: Date.parse(turn.at || turn.endedAt || '') || 0, entries });
      });

      const mark = Date.parse(this.since || '');

      this.turns.forEach((turn, i) => {
        // Anything typed before the mark belongs to the conversation that was cleared. Without
        // this, a message whose pod record has been filtered out can never be matched to it
        // again, so it stays in the stream for good, still claiming it has not been recorded.
        if (!Number.isNaN(mark) && turn.at && turn.at < mark) {
          return;
        }

        const text = this.flatten(turn.text);
        const left = unmatched.get(text) || 0;

        // Already in the stream, from the pod's own record of it, which is the richer one.
        if (text && left > 0) {
          unmatched.set(text, left - 1);

          return;
        }

        out.push({
          at:      turn.at || 0,
          entries: [{
            key:   `composer-${ i }`,
            props: {
              role: 'user',
              text: turn.text || '',
              when: turn.when || '',
              note: 'Sent from this composer · the pod has not recorded it yet',
            },
          }],
        });
      });

      // In the order things happened, not "everything the pod recorded, then everything this
      // browser sent".
      //
      // The two halves were concatenated, so an unmatched composer message - one the pod has
      // not recorded, or never will because the session was wedged when it was sent - was
      // appended after turns that came minutes later. A conversation that jumps back in time
      // at the point the record runs out is unreadable, and it hid the newest turn under
      // messages older than it.
      return out
        .sort((a, b) => a.at - b.at)
        .flatMap((group) => group.entries);
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

    /**
     * The line under the composer, which now counts the same thing the badge does.
     *
     * "since v0.1.0" was true of a file count measured from the published version and is not
     * true of a review queue, so it says what the number is instead of where it was measured
     * from. Nothing waiting is worth saying plainly: it is the state Publish requires.
     */
    changesLabel() {
      const n = this.changes;

      if (!n) {
        return 'Nothing waiting for review';
      }

      return `${ n } change set${ n === 1 ? '' : 's' } to review`;
    },

    /** The tmux session in the pod, which is the name a shell would attach to. */
    sessionName() {
      return `mc-${ this.session }`;
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

    // The running mode does change while somebody watches: shift+tab in the Terminal tab is
    // all it takes, and a chip that went on claiming the old one would be the worst kind of
    // wrong here.

    this.refreshLogin();
    // Half a minute, because this one does change while somebody is looking at it: running
    // /login in the pane below is exactly how it changes, and the strip that told you to do it
    // should notice that you did.
    this.loginTimer = setInterval(() => this.refreshLogin(), 30000);

    this.readSince().then(() => this.refreshTurns());
    this.turnsTimer = setInterval(() => this.refreshTurns(), TURNS_POLL_MS);

    this.nowTimer = setInterval(() => {
      this.now = Date.now();
    }, 1000);

    this.streamPin = stickToBottom(this.$refs.stream);
    this.streamPin.pin();
  },

  beforeUnmount() {
    this.streamPin?.stop();
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
      // After the render, and then again as the turn's own content settles - see stickToBottom.
      // Scrolling once in `nextTick` left the view a little short of the end, because a turn's
      // pictures and chips are taller a frame later than they are when it first renders.
      this.$nextTick(() => this.streamPin?.pin());
    },

    extension() {
      this.changes = 0;
      this.version = '';
      this.login = null;
      this.conversation = null;
      this.rawOpen = false;
      this.rawText = '';
      this.rawError = '';
        this.podTurns = [];
        this.since = '';
        this.readSince();
      this.podRead = false;
      this.refreshLogin();
      this.refreshTurns();
      // The paths belonged to the extension that was open; none of them means anything in the
      // next one's pod.
      this.context = [];
      this.refreshChanges();
    },
  },

  methods: {
    async refreshChanges() {
      // Change sets waiting for review, not files touched.
      //
      // The tab's badge sits next to the word "Changes" and beside a Publish button that now
      // refuses while anything is unreviewed, so the number a person needs there is how many
      // things they have to look at - not how many files those things happened to touch. A
      // count of files answered a question nobody was asking and read as done work rather than
      // as a queue.
      const approval = await approvalState(this.extension).catch(() => null);

      this.changes = approval
        ? approval.pending.length
        : await countChanges(this.extension).catch(() => 0);
      this.version = await publishedVersion(this.extension).catch(() => '');
    },

    async refreshLogin() {
      this.login = await assistantLogin(this.extension)
        .catch(() => ({ read: false, signedIn: false, account: '' }));
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
    recordedEntries(turn, newest) {
      const entries = [];

      if (turn.at) {
        entries.push({
          role:    'user',
          text:    turn.prompt || 'The prompt for this turn was not recorded.',
          // The chips the composer attached, drawn above the message rather than said inside it.
          context: turn.context || [],
          when:    this.ago(turn.at),
          // No origin note either: every turn in this pane came from this composer, so it said
          // the same sentence under every message somebody had just watched themselves send.
          note:    '',
        });
      }

      entries.push(this.outcomeEntry(turn, newest));

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
    outcomeEntry(turn, newest = true) {
      const files = Array.isArray(turn.files) ? turn.files : [];
      const commit = (turn.commit || '').slice(0, 7);
      const n = files.length;
      const plural = n === 1 ? '' : 's';
      const said = this.saidIn(turn);

      if (!turn.endedAt) {
        const why = turn.at
          ? (newest
            ? 'No end was recorded for this turn, so there is nothing yet to show for it.'
            : 'This turn never finished. Nothing recorded its end, and the conversation moved on past it.')
          : 'A turn was recorded with neither a prompt nor an end.';
        const open = turn.at ? `Started ${ this.ago(turn.at) } · no duration, because nothing recorded its end` : '';

        /**
         * Still running, or simply never finished.
         *
         * Only the newest turn can be the one in flight: the assistant answers one prompt at a
         * time, so an older turn with no end recorded is not being worked on - whatever was
         * going to end it did not. Without this rule, a turn abandoned when a session was
         * restarted or wedged sat in the middle of the conversation animating "Working" with a
         * counter climbing past newer messages that had already been answered.
         */
        const working = newest && (!said.text || said.failed);

        return {
          role:    'assistant',
          pending: working,
          when:    '',
          // How long it has been going, for the indicator the turn draws while it is pending.
          // Counted from the prompt, which is the only timestamp a turn in flight has.
          // `lasted` parses both ends, and `now` is a number - so it is spelled the way the
          // other end is spelled rather than handed over as milliseconds, which parses to NaN
          // and would have made this quietly always empty.
          elapsed: working && turn.at ? this.lasted(turn.at, new Date(this.now).toISOString()) : '',
          // No prose about the silence while it is still working: the indicator says that, and
          // saying it twice - once as motion and once as an apology - reads as a failure.
          // An abandoned turn says so in words, since it has no indicator to say it with.
          text:    said.text || (working ? '' : why),
          note:    said.text ? [why, open].filter(Boolean).join(' · ') : '',
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
        // What the assistant said leads, as the design has it. With nothing said, the sentence
        // about how the turn ended is all there is and it leads instead.
        when:       this.ago(turn.endedAt),
        text:       said.text || outcome,
        // No caption under a turn that spoke for itself.
        //
        // It read "Finished, and committed what it left behind · Took 17s · Commit 4bb20db ·
        // Answered on claude-opus-5" under every single turn - four facts, the same three of
        // them every time, restating in the caption what the reply above had just said in
        // words. The one that is not restatement is the commit, and that is what the Changes
        // tab is: a list of them, with what each one did. So the caption is kept only for a
        // turn that said nothing, where it is the whole of what is known.
        note:       said.text ? '' : facts.join(' · '),
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
      // Two texts, deliberately: the assistant is sent the one with the context prefixed, and
      // the record keeps what was actually typed. They were the same string, so the stream read
      // back "Context: the preview is on /... . Update the title" - the product's own plumbing
      // quoted to somebody as though they had said it.
      this.$emit('send', this.withContext(text), text);
      // Stay on the stream. This used to jump to the terminal, on the argument that the reply
      // arrives there - which was right when the stream had nothing in it and is wrong now that
      // it has your turn: being thrown to another tab the instant you press Send is how you
      // never see that the message was recorded at all. The strip under the last turn is the
      // way to the terminal, and it says so.
      this.$emit('update:tab', 'assistant');

      // The context went with the message, so it is spent.
      //
      // It used to persist, which meant the file somebody attached for one question was still
      // being prefixed to the next three, and a picked element outlived the sentence it was
      // picked for. Everything in `context` was put there by hand for a particular message;
      // the three standing chips beside it - the extension, the cluster, the page - are facts
      // about where you are rather than choices, so they are not in here and do not clear.
      this.context = [];

      // Ask the pod again shortly, so the turn stops being "not recorded yet" as soon as it is
      // recorded rather than at the end of the poll it happened to land in.
      clearTimeout(this.sendTimer);
      this.sendTimer = setTimeout(() => {
        this.refreshTurns();
      }, SEND_SETTLE_MS);
    },

    /**
     * The whole truth about a chip, where there is room for it.
     *
     * The label is deliberately short, so everything it left out is here: which file drew the
     * element, the selector that finds it, and the text it had in it when it was picked.
     */
    contextTitle(item) {
      if (item.kind === 'shot') {
        const lines = [
          item.file ? `Drawn by ${ item.file }` : 'Not drawn by this extension',
          item.selector ? `Selector: ${ item.selector }` : '',
          item.text ? `Text: "${ item.text }"` : '',
          item.route ? `On ${ item.route }` : '',
          'Click to open the picture of it',
        ];

        return lines.filter(Boolean).join('\n');
      }

      return this.isImage(item) ? `${ item.path } - click to open it full size` : item.path;
    },

    /**
     * Start a new conversation.
     *
     * `/clear` is claude's own, so this is the same instruction a person would type into the
     * pane - the pod's conversation starts over and nothing on disk moves. The composer's
     * draft and the context chips go with it: they were gathered for a conversation that is
     * no longer there, and carrying them into the next one is how a prompt ends up prefixed
     * with a file somebody attached for a question they already got an answer to.
     */
    async clearChat() {
      this.draft = '';
      this.context = [];

      try {
        // Not through the composer's own send: that records a turn, so "/clear" appeared in
        // the stream as something a person had said - the one message a new conversation
        // should certainly not open with.
        this.since = await startNewConversation(this.extension);
        this.podTurns = [];
        // The composer's own optimistic turns live in the page, not here.
        this.$emit('cleared');
        this.conversation = null;
        this.refreshTurns();
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'The conversation did not clear' });
      }
    },

    /** The last two segments, so a chip does not become the whole composer. */
    shortPath(path) {
      return path.split('/').slice(-2).join('/');
    },

    /** Whether this context item is a picture, and so worth opening rather than only naming. */
    isImage(item) {
      return item.kind === 'shot' || /\.(png|jpe?g|gif|webp)$/i.test(item.path || '');
    },

    /**
     * Something picked out of the preview with the crosshair, or off a changed-outline box.
     *
     * It becomes a picture of that element, which is what the Changes tab's regions already
     * become. It used to become a chip naming the component file instead, and that was two
     * kinds of context for one gesture: a path the assistant had to go and read, against an
     * image it can simply look at. The path is still said in the message - it is the useful
     * half for a component - but what is attached is the picture.
     *
     * Cropped to the element rather than the whole page, using the rectangle the capture
     * recorded for the outline it drew. Same pass, so the crop and the picture agree; and no
     * scaling between the capture's viewport and this pane's, which is the mistake that
     * outlined a nav item for a change to a timestamp.
     */
    async addPickedElement(pick) {
      if (!pick) {
        return;
      }

      const what = this.elementLabel(pick);
      const name = pick.file ? `${ what } in ${ this.shortPath(pick.file) }` : what;

      // One picked element at a time: the crosshair answers "this one", and two of those in
      // the same sentence is two questions.
      this.context = this.context.filter((c) => !c.picked);

      const placeholder = {
        path:     '',
        label:    what,
        icon:     'target',
        kind:     'shot',
        picked:   true,
        pending:  true,
        selector: pick.selector || '',
        route:    pick.route || '',
        file:     pick.file || '',
        tag:      pick.tag || '',
        text:     pick.label || '',
        src:      '',
      };

      // On the strip while the pod is being read, so the gesture is visibly doing something.
      this.context = [...this.context, placeholder];
      this.$emit('update:tab', 'assistant');

      const shot = await elementShot(this.extension, placeholder.route, placeholder.selector)
        .catch(() => null);

      const drop = () => {
        this.context = this.context.filter((c) => c !== placeholder);
      };

      if (!shot?.src) {
        drop();
        toastError(this.$store, 'The pod could not take a picture of that element.', { title: 'Nothing was attached' });

        return;
      }

      // Cropped and attached the same way a change set's region is, so both gestures leave the
      // same kind of thing on the strip.
      if (shot.region) {
        drop();

        try {
          await this.cropIntoContext(shot.src, shot.region, name);
        } catch (e) {
          toastError(this.$store, e?.message || String(e), { title: 'That part could not be attached' });
        }

        return;
      }

      // The capture drew no outline, so there is nothing to cut out and the whole page is the
      // honest attachment. It is already written into the pod, so it only has to be named.
      this.context = this.context.map((c) => (c === placeholder
        ? {
          ...c, path: shot.path, src: shot.src, pending: false,
        }
        : c));
    },

    /**
     * The element, in as few characters as still identify it.
     *
     * Sized to sit beside "cluster: local" and "page: /home" rather than to be complete: the
     * whole selector, the file and the text are all on the chip's title, where length costs
     * nothing. `nth-child` is dropped because a position among siblings tells a reader
     * nothing they can recognise on screen.
     */
    elementLabel(pick) {
      const selector = pick.selector || '';
      const testid = /\[data-testid="([^"]+)"\]/.exec(selector);

      let base = '';

      if (testid) {
        base = testid[1];
      } else if (selector.startsWith('#')) {
        base = selector;
      } else {
        base = (selector.split('>').pop() || '').trim().replace(/:nth-child\(\d+\)/g, '');
      }

      base = base || pick.tag || 'element';

      return base.length > 22 ? `${ base.slice(0, 21) }…` : base;
    },

    /**
     * What a context chip does when it is clicked.
     *
     * A picked component points back at the thing it was picked from; anything with a picture
     * opens it. A plain file path does nothing, which is what it did before any of this.
     */
    openContext(item) {
      if (item.kind === 'shot') {
        // Already have the bytes: the capture that made this chip handed them over.
        if (item.src) {
          this.preview = {
            path: item.selector, name: item.path, src: item.src, loading: false, error: '',
          };

          return true;
        }

        // Otherwise read it out of the pod, which is where it is.
        //
        // This said "This picture is still being taken in the pod" and stopped, which was true
        // of a chip whose capture was in flight and false of every other one - a chip on an old
        // message names a file that was written long ago and is sitting there, and nothing was
        // fetching it. So the viewer opened on a sentence about waiting, forever.
        return this.openPreview({ ...item, path: item.value || item.path });
      }

      return this.openPreview(item);
    },

    /**
     * Open an attachment full size.
     *
     * The chip is the only handle on a file that has already left this machine - it is in the
     * pod by the time it is a chip - so this reads it back out rather than keeping the bytes
     * the upload was made from. That also means the picture shown is the one the assistant
     * will actually be given, which is the thing worth checking.
     */
    async openPreview(item) {
      if (!this.isImage(item)) {
        return;
      }

      // A picked element whose capture has not come back yet has no file to read. That is the
      // one case where "still being taken in the pod" is the truth, so it is the only case
      // that says it.
      if (!item.path) {
        this.preview = {
          path:    '',
          name:    item.label || 'the picked element',
          src:     '',
          loading: true,
          error:   '',
        };

        return true;
      }

      this.preview = {
        path: item.path, name: this.shortPath(item.path), src: '', loading: true, error: '',
      };

      const opened = item.path;
      const src = await readPodImage(this.extension, item.path).catch(() => '');

      // Closed again, or a different one opened, while the pod was being read.
      if (this.preview?.path !== opened) {
        return;
      }

      this.preview = {
        ...this.preview,
        src,
        loading: false,
        error:   src ? '' : 'This attachment could not be read back out of the pod.',
      };
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

      await this.attachFiles(files);
    },

    /**
     * A screenshot pasted straight into the composer.
     *
     * This is how a screenshot actually arrives - Print Screen, or a region grab, then Ctrl+V
     * into the box you are typing in. Going via the paperclip means saving it to disk first and
     * finding it again, for something that was already on the clipboard.
     *
     * Only the files on the clipboard are taken, and only when there are some: a normal text
     * paste has none and must fall through untouched, or pasting a path into the composer would
     * stop working. `preventDefault` is therefore inside the branch, not above it - a screenshot
     * copied from a browser carries both an image and an `<img>` tag as HTML, and letting that
     * default through would drop markup into the textarea beside the attachment.
     */
    async onPaste(event) {
      const files = [...(event.clipboardData?.files || [])];

      if (!files.length) {
        return;
      }

      event.preventDefault();
      await this.attachFiles(files);
    },

    /**
     * A piece of a change set's picture, put into this conversation.
     *
     * Called from the editor when somebody clicks an outlined part of the After shot. The crop
     * happens here rather than in the pod because the picture is already in the browser: it is
     * a canvas draw, where sending it away to be cut would be a round trip for something the
     * page can do in a frame.
     *
     * A little air around the region on purpose. A crop tight to the element's box arrives as a
     * detail with nothing around it, and the assistant has to guess where it sat; a margin of
     * context is the difference between "this button" and "this button, in that toolbar".
     */
    async attachRegion(image, region, name) {
      try {
        await this.cropIntoContext(image, region, name);
      } catch (e) {
        // Anything that goes wrong here is a failed attachment, not a broken page. It escaped as
        // an unhandled rejection before, which surfaced as the app's error screen over a
        // workspace somebody was working in - for something as small as a crop that did not fit.
        toastError(this.$store, e?.message || String(e), { title: 'That part could not be attached' });
      }
    },

    /** The crop itself. Separated so the caller above owns what happens when it fails. */
    async cropIntoContext(image, region, name) {
      const source = new Image();

      await new Promise((resolve, reject) => {
        source.onload = resolve;
        source.onerror = () => reject(new Error('the picture could not be read back for cropping'));
        source.src = image;
      });

      // The same rectangle the outline was drawn at, so the crop is what was pressed.
      const {
        x, y, width: w, height: h,
      } = padded(region, source.naturalWidth, source.naturalHeight);

      if (w <= 0 || h <= 0) {
        toastError(this.$store, 'That part of the picture is outside it, so there is nothing to cut out.');

        return;
      }

      const canvas = document.createElement('canvas');

      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(source, x, y, w, h, 0, 0, w, h);

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));

      if (!blob) {
        toastError(this.$store, 'The crop could not be turned into an image.');

        return;
      }

      const file = new File([blob], `${ name }.png`, { type: 'image/png' });

      await this.attachFiles([file]);
      this.$emit('update:tab', 'assistant');
    },

    /**
     * Files into the pod, and onto the context chips.
     *
     * Shared by the paperclip and by paste, because they differ only in where the bytes came
     * from. A pasted screenshot has no filename - the clipboard calls it `image.png`, or
     * nothing at all - so one is made from the timestamp rather than trusting what arrives.
     */
    async attachFiles(files) {
      if (!files.length) {
        return;
      }

      this.attaching = true;

      for (const file of files) {
        if (file.size > MAX_ATTACHMENT) {
          toastError(this.$store, `${ file.name || 'that image' } is ${ Math.round(file.size / 1024 / 1024) }MB. The limit here is 8MB; put a bigger file in the pod from the terminal instead.`);
          continue;
        }

        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const named = (file.name || '').replace(/[^\w.-]/g, '_');
        // A pasted image arrives unnamed; the type is what says it is a png.
        const ext = (file.type.split('/')[1] || 'png').replace(/[^\w]/g, '');
        const safe = named || `pasted.${ ext }`;
        const path = `${ ATTACH_DIR }/${ stamp }-${ safe }`;

        try {
          await writePodImage(this.extension, path, await file.arrayBuffer());
          // No toast. The chip appearing on the context row is the confirmation, and it is
          // both more specific than a toast and in the place the attachment now lives - a
          // notification that says "attached" beside a row that visibly gained the thing is
          // one report too many, and it covers the corner of the page while it says it.
          this.addContext(path, 'upload');
        } catch (e) {
          toastError(this.$store, e.message || String(e));
        }
      }

      this.attaching = false;
    },

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

    /**
     * Where the current conversation starts, read from the pod.
     *
     * Read rather than remembered, so opening the Studio in another tab - or after a reload -
     * shows the same conversation rather than the whole log again.
     */
    async readSince() {
      const asked = this.extension;
      const mark = await conversationSince(asked).catch(() => '');

      if (asked === this.extension) {
        this.since = mark;
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

      // The pod records the prompt exactly as claude received it, context line and all. That
      // line is the product talking to itself, so it comes off for display: a turn shows what a
      // person asked for.
      // Everything before the mark belongs to a conversation somebody has already ended. The
      // pod still holds it - the Changes tab is built from it - but this pane is the current
      // conversation and starts where that one did.
      const mark = Date.parse(this.since || '');
      const current = (Array.isArray(turns) ? turns : []).filter((turn) => {
        if (Number.isNaN(mark)) {
          return true;
        }

        const at = Date.parse(turn.at || turn.endedAt || '');

        return Number.isNaN(at) || at >= mark;
      });

      this.podTurns = current.map((turn) => ({
        ...turn,
        prompt:  promptSaid(turn.prompt),
        context: promptContextChips(turn.prompt),
      }));
      this.podRead = true;

      // The same beat as the turns, because the two are drawn as one thing: a turn whose reply
      // arrived a second later would otherwise show as unanswered until the next poll.
      const said = await assistantConversation(asked, TURN_LIMIT * 2).catch(() => null);

      if (asked === this.extension && said) {
        this.conversation = said;
      }
    },
    /**
     * The line the assistant actually receives.
     *
     * One line, because the terminal types this at a prompt and a newline in it would submit
     * half a sentence. The paths are named in the text rather than attached out of band, which
     * is the only kind of attaching a terminal has.
     */
    withContext(text) {
      // Only what actually names something. A picked element whose picture is still being
      // taken has no path yet, and an empty entry would put a stray comma in the sentence.
      const paths = this.context.map((item) => item.path).filter(Boolean);

      // ` :: ` ends the context, not a full stop. A full stop cannot mark the end of something
      // whose contents are paths and selectors - `pages/Home.vue`, `.base-home__stamp` - so the
      // reader that takes this off again stopped at the first dot inside a filename and left
      // most of the prefix on screen. Kept in step with withoutContext below; the two are a
      // pair with `splitPrompt` in prompt-context.ts, and neither means anything alone.
      return paths.length ? `Context: ${ paths.join(', ') } :: ${ text }` : text;
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

    addContext(path, icon = 'file') {
      if (!this.context.some((item) => item.path === path)) {
        this.context = [...this.context, { path, icon }];
      }
    },

    addFile(path) {
      this.addContext(path);
      this.picking = false;
    },

    removeContext(path, item = null) {
      // By identity when there is one, because two picks can be waiting for their pictures and
      // both have an empty path until they arrive.
      this.context = item
        ? this.context.filter((c) => c !== item)
        : this.context.filter((c) => c.path !== path);
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

      <!--
        The way out of the state the strip is describing. It sat here as the sentence "run
        /login in the terminal", which is a true instruction and not a control: the one thing
        somebody wants at that moment is a way to fix it.
      -->
      <SButton
        v-if="login && login.read && (!login.signedIn || sessionRefused)"
        variant="primary"
        size="sm"
        icon="sparkle"
        data-testid="barn-sign-in"
        @click="signingIn = true"
      >
        Sign in
      </SButton>

      <span class="assistant-panel__grow" />
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
            @context="$emit('context', $event)"
          />

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

    <!--
      The changes summary (11:305) was here: a strip saying "10 change sets to review" with a
      Review button. Taken out. The tab beside this one is called Changes and carries the same
      count as a badge, so the strip repeated a number that was already on screen and put a
      second way into a tab that was one click away - while taking a band of the composer's
      height to do it.
    -->

    <!-- composer (11:317) -->
    <div class="assistant-panel__composer">
      <div class="assistant-panel__context">
        <SLabel text="Context" />
        <!-- Two facts about where the message goes, and neither is a control. -->
        <SChip :label="extension" icon="puzzle" />
        <SChip label="cluster: local" icon="server" />
        <SChip
          v-if="page"
          :label="`page: ${ page }`"
          icon="compare"
          clickable
          :title="`The preview is showing ${ page }, and the assistant is told so.\nClick to point it there again.`"
          data-testid="barn-page-context"
          @click="$emit('context', { kind: 'page', value: page, label: page, title: page })"
        />

        <!--
          The paths that will be named in the message. Removable, because they are a choice, and
          a picture or a picked element among them opens: a chip names a thing and a name is not
          enough to tell one screenshot, or one element, from another.
        -->
        <SChip
          v-for="item in context"
          :key="`${ item.kind || 'file' }:${ item.path }:${ item.selector || '' }`"
          :label="item.label || shortPath(item.path)"
          :icon="item.icon"
          :title="contextTitle(item)"
          :clickable="isImage(item)"
          removable
          :data-testid="`barn-context-${ shortPath(item.path) }`"
          @click="openContext(item)"
          @remove="removeContext(item.path, item)"
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
            Start over. The same `/clear` the session menu sends, on the bar where the
            conversation actually is: starting a new one is a thing people do between tasks,
            and it was three clicks into a menu named after something else.
          -->
          <SButton
            variant="ghost"
            size="sm"
            icon="refresh"
            icon-only
            title="Start a new conversation. The files in the pod are untouched."
            aria-label="Start a new conversation"
            data-testid="barn-clear-chat"
            @click="clearChat"
          />


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
    <ImagePreview
      v-if="preview"
      :src="preview.src"
      :name="preview.name"
      :loading="preview.loading"
      :error="preview.error"
      data-testid="barn-attachment-preview"
      @close="preview = null"
    />
    <AssistantLoginModal
      v-if="signingIn"
      :extension="extension"
      @close="signingIn = false"
      @signed-in="refreshLogin"
    />
  </div>
</template>

<style lang="scss" scoped>
.assistant-panel {
  display:        flex;
  flex-direction: column;
  min-height:     0;
  min-width:      0;
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

  // The disagreement between the running permission mode and the one the pod starts in.
  &__split {
    display:       flex;
    align-items:   flex-start;
    gap:           6px;
    padding:       var(--studio-space-8) var(--studio-space-16);
    background:    var(--studio-warning-bg);
    border-bottom: 1px solid var(--studio-warning);
    font:          var(--studio-caption-12);
    color:         var(--studio-text-secondary);
    flex:          0 0 auto;
  }

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
    min-width:  0;
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

    // Every chip on this row is the same shape, whatever is in it. A picked element can carry
    // a long class name and a file path can be any length, and one chip twice the width of
    // the four beside it reads as a different kind of thing rather than as a longer name.
    // The label is already shortened; this is the guard for the cases that shortening cannot
    // predict, and the full text is on the chip's title either way.
    :deep(.s-chip) {
      max-width: 15rem;
      min-width: 0;
    }

    // Not `overflow` on the chip itself: an inline-level box with a clipped overflow takes
    // its baseline from its bottom margin edge instead of from its text, which drops it
    // against the chips beside it. The label is what needs clipping.
    :deep(.s-chip__label) {
      overflow:      hidden;
      text-overflow: ellipsis;
      white-space:   nowrap;
      min-width:     0;
    }
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
