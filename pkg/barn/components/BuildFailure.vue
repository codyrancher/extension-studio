<script>
// The failed build, as a state of the workspace rather than a page of its own (Figma 19:621).
//
// Screen 08 is not a screen. The frame draws the whole workspace - rail, header, masthead,
// tabs, assistant stream, composer, preview canvas - in its failed state, and puts the failure
// inside it as a turn in the conversation (19:1007) with an explainer over the preview
// (19:830). The flow map says the same thing a second way: the amber arrow leaves "Build it and
// watch it", reaches "It breaks", and comes back down into the *same* box, under a legend that
// reads "every recovery route leads back into the same workspace rather than out of the
// product" (43:4).
//
// So this is a component and not a page. It carries everything the failure itself owns - the
// explanation, the proposed fix, the ways back, the raw output - and nothing the workspace
// already owns. Mounted inside the workspace it is the design's failed state; mounted on
// pages/build-failed.vue it is the same block with a masthead around it, which is what that
// route is until the workspace mounts this and the route can redirect into it.
//
// What is real here, and what is not:
//
//   Real - the message, the stage and the log are the publish's own output, recorded when it
//   failed (publish-failure.ts). The heuristic error line is a pattern match over that log and
//   says so. "Show me the file" reads the file out of the pod. The assistant explanation is the
//   assistant in this extension's own pod, asked to read the log and write its answer back to a
//   file; it is not always available and the screen says which. "Apply this fix" only applies a
//   change whose `before` text is actually in the file, and refuses out loud when it is not.
//   Roll back restores a real git ref, after snapshotting the failed tree so the roll back is
//   itself undoable.
//
//   Not built - "Undo my request". The design deliberately scopes it to the whole turn that
//   caused the failure, and this product has no notion of a turn: one file-scoped undo
//   (undoLastChange) and one tree-scoped restore, with nothing recording which edits came from
//   which message. That is the same per-turn provenance screen 12 needs for per-hunk prompts,
//   and inventing it here would be a control that lies. The panel says so in words instead.
import {
  SButton, SBanner, SIcon, SChip, SLabel
} from './ui';
import {
  DEFAULT_EXTENSION, listExtensionFiles, readExtensionFile, writeExtensionFile,
  extensionPod, podExecOnce, askAssistant, assistantLogin, createSnapshot, restoreSnapshot,
  listSnapshots, baselineRef, countChanges, undoLastChange
} from '../extensions';
import {
  readFailure, clearFailure, readWorkingBuild, failureStage, FAILURE_EVENT
} from '../publish-failure';
import { toastError, toastSuccess } from '../toast';

// Where the assistant is handed the log and where it writes its answer.
//
// /tmp, and that is not laziness: everything under the package is a git working tree that four
// other screens diff, so a scratch file written there would show up as an unexplained change on
// the review screens and in the changed-file count. /tmp is outside the tree, outside the dev
// server's watch, and gone when the pod restarts, which is the right lifetime for a scratch
// file about one build.
const EXPLAIN_DIR = '/tmp/barn-explain';
const LOG_FILE = `${ EXPLAIN_DIR }/build-failure.log`;
const ANSWER_FILE = `${ EXPLAIN_DIR }/explanation.json`;

// How much of the log to hand over. The exec URL carries its command in the query string, so
// the whole of a webpack log would not fit down it; the tail is where the summary lives and the
// matched error line is prepended when it fell outside the window.
const LOG_TAIL = 6000;

// How long to wait for the answer. The assistant has to read a log and think about it, which is
// tens of seconds on a good day, and the panel counts the wait out loud rather than spinning.
const POLL_MS = 4000;
const POLL_TRIES = 45;

/** UTF-8 safe base64, the same shape writeExtensionFile uses to get bytes into the pod. */
function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';

  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });

  return btoa(binary);
}

/** The assistant is asked for JSON; models like to wrap it in a fence anyway. */
function parseAnswer(text) {
  const body = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

  if (!body) {
    return null;
  }

  try {
    const parsed = JSON.parse(body);

    // An object with something in it, or nothing. An array, a bare string or `{}` all parse and
    // none of them is an explanation, and the caller renders the file as written when this
    // returns null - which is more use than a card with an empty headline in it.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    return parsed.headline || parsed.cause || parsed.fix ? parsed : null;
  } catch {
    return null;
  }
}

export default {
  name: 'BuildFailure',

  components: {
    SButton, SBanner, SIcon, SChip, SLabel
  },

  props: {
    extension: {
      type:    String,
      default: DEFAULT_EXTENSION,
    },

    /**
     * True when this is mounted inside the workspace, which is where the design puts it.
     *
     * It changes what the panel offers rather than how it looks: inside the workspace the raw
     * output and the assistant's reply are one tab away, so the panel points at them; on its
     * own route there is nowhere to point, so it renders the log itself.
     */
    embedded: {
      type:    Boolean,
      default: false,
    },

    /**
     * Where the raw build output goes.
     *
     * `inline` is the design (19:1036): a collapsed row with the line count, right under the
     * failure, because the log is part of the failure and not a second subject. `none` is for a
     * host that already has a pane for it - pages/build-failed.vue has one, measured against the
     * frame by scripts/design-check - and would otherwise draw it twice.
     */
    raw: {
      type:      String,
      default:   'inline',
      validator: (v) => ['inline', 'none'].includes(v),
    },

    /**
     * Re-reads the recorded failure when this changes.
     *
     * The same handle WorkingChanges takes, for the same reason: a host that stays mounted
     * across a publish needs a way to say "look again", and the record is in sessionStorage,
     * which nothing can watch.
     */
    revision: {
      type:    Number,
      default: 0,
    },
  },

  emits: ['resolved', 'open-tab', 'changed'],

  data() {
    return {
      failure: null,

      // The raw log, collapsed to start with as the design draws it (19:1036): the row says how
      // many lines there are so the size of the read is known before it is taken.
      showLog: false,

      // The culprit file, when somebody has asked to see it.
      file:      null,
      fileError: '',
      reading:   false,

      // The assistant round trip.
      explainState: '',
      explainError: '',
      explainRaw:   '',
      answer:       null,
      waited:       0,
      applying:     false,
      applied:      '',

      // The ways back.
      target:     null,
      targetting: true,
      changes:    -1,
      rollingBack: false,
      undoing:     false,
      safety:      '',

      // The poll for the assistant's answer. Held here so beforeUnmount can end it: a timer
      // still running against an unmounted component is a websocket opened into the pod every
      // four seconds for as long as the tab is open.
      timer:   null,
      polling: false,

      // True while this component is the one changing the record, so its own announcement does
      // not reload it out from under the action that is finishing.
      settling: false,

      // The previous read of the answer file, for the "has it stopped changing" check below.
      lastSeen: '',
    };
  },

  computed: {
    log() {
      return this.failure?.log || '';
    },

    logLines() {
      return this.log ? this.log.split('\n').length : 0;
    },

    logLabel() {
      if (!this.logLines) {
        return 'The build produced no output';
      }

      return `${ this.showLog ? 'Hide' : 'Show' } raw output`;
    },

    /**
     * The headline (19:1008). The assistant's when it has one, otherwise the plain fact.
     *
     * The design's example headline is "The page renders on a blank screen", which is a
     * sentence about the consequence rather than about the exit code. Nothing but a reading of
     * the log can produce that, so until the assistant has read it this says the thing that is
     * certainly true and no more.
     */
    headline() {
      return this.answer?.headline || 'The publish did not finish';
    },

    /**
     * The sub-line (19:1013), which the design uses to separate the half that worked from the
     * half that did not: "Build succeeded - the route has no parent chrome".
     *
     * Taken from the recorded stage when the caller had one, inferred from the message when it
     * did not, and left out entirely when neither is sure.
     */
    subline() {
      return this.failure?.stage || failureStage(this.failure?.message || '');
    },

    /**
     * The first line of the log that looks like the actual error.
     *
     * A heuristic, and the panel labels it as one. A webpack log puts the interesting line a
     * long way down and surrounds it with progress, so showing the tail is usually wrong and
     * showing the head always is.
     */
    firstError() {
      const lines = this.log.split('\n').map((l) => l.trim()).filter(Boolean);

      return lines.find((l) => /^(ERROR|error|Module not found|SyntaxError|TypeError|Failed to)/.test(l))
        || lines.find((l) => /error/i.test(l))
        || '';
    },

    /**
     * Where the error names a file, so "Show me the file" can open the right one.
     *
     * The error line first, because that is the one that names the file the build tripped over.
     * A webpack summary line ("Failed to compile with 1 error") names nothing, though, and used
     * to end the search there - so the whole log is the fallback rather than the alternative.
     */
    culprit() {
      const find = (text) => /([\w./-]+\.(?:vue|ts|js|scss|json))/.exec(text || '');
      const named = this.answer?.file && find(this.answer.file);
      const m = named || find(this.firstError) || find(this.log);

      return m ? m[1].replace(/^\.\//, '') : '';
    },

    /**
     * The line the log points at inside that file, when it gives one.
     *
     * webpack writes the position two ways - `path.vue 12:3` on the module line and `(12:5)` in
     * the parse error under it - and either is enough to open the file where the problem is
     * rather than at the top.
     */
    culpritLine() {
      if (!this.culprit) {
        return 0;
      }

      const escaped = this.culprit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // A window rather than the rest of the line: webpack puts the position on the line after
      // the module it belongs to as often as on the same one.
      const near = new RegExp(`${ escaped }[\\s\\S]{0,200}?[\\s:(](\\d+):(\\d+)`).exec(this.log);

      return near ? parseInt(near[1], 10) || 0 : 0;
    },

    /** The file's lines, numbered, for the inline view. */
    fileLines() {
      return (this.file?.text || '').split('\n');
    },

    /** The assistant's proposed change, once it is one this panel could actually apply. */
    fix() {
      const fix = this.answer?.fix;

      if (!fix || typeof fix !== 'object') {
        return null;
      }

      const { path, before, after } = fix;

      if (!path || typeof before !== 'string' || typeof after !== 'string' || !before) {
        return null;
      }

      return { path, before, after };
    },

    /** How the roll-back button should read, given what there actually is to go back to. */
    targetLabel() {
      if (!this.target) {
        return 'Roll back';
      }

      return `Roll back to ${ this.target.what }`;
    },

    changesNote() {
      if (this.changes < 0) {
        return '';
      }

      return `${ this.changes } changed file${ this.changes === 1 ? '' : 's' } since`;
    },
  },

  watch: {
    extension: 'load',
    revision:  'load',
  },

  mounted() {
    this.load();
    // A publish that fails under a host which is already on screen - which is the design's
    // whole case, the workspace watching its own build break - writes the record without this
    // component knowing. The record announces itself instead of every caller remembering to.
    window.addEventListener(FAILURE_EVENT, this.onRecordChanged);
  },

  beforeUnmount() {
    this.stopPolling();
    window.removeEventListener(FAILURE_EVENT, this.onRecordChanged);
  },

  methods: {
    load() {
      this.stopPolling();
      this.failure = readFailure(this.extension);
      this.file = null;
      this.fileError = '';
      this.answer = null;
      this.explainState = '';
      this.explainError = '';
      this.explainRaw = '';
      this.applied = '';
      this.safety = '';
      this.target = null;
      this.targetting = true;
      this.changes = -1;

      if (this.failure) {
        this.findWayBack();
      }
    },

    /**
     * What there is to go back to, in the order of how well it matches "the last working
     * build" - and the panel says which one it landed on rather than implying the best case.
     *
     *   1. A snapshot taken the last time a publish succeeded (publish-failure.ts). This is the
     *      only one that is literally the last working build, and it exists only if whoever ran
     *      the publish recorded it.
     *   2. The baseline ref the publish path writes: the tree that was last handed over, or
     *      last installed into this Rancher.
     *   3. The most recent snapshot anybody took by hand.
     *   4. HEAD, which always exists (ensureRepo commits the seeded tree), and which is a real
     *      way back even though it is not a build.
     */
    async findWayBack() {
      this.targetting = true;

      const working = readWorkingBuild(this.extension);
      const [base, snaps, changes] = await Promise.all([
        baselineRef(this.extension).catch(() => null),
        listSnapshots(this.extension).catch(() => []),
        countChanges(this.extension).catch(() => -1),
      ]);

      this.changes = changes;

      if (working) {
        const when = new Date(working.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        this.target = {
          ref:  working.ref,
          what: `the last working build${ working.version ? ` (${ working.version })` : '' }`,
          note: `Taken automatically when that publish succeeded, at ${ when }.`,
          kind: 'build',
        };
      } else if (base && (base.kind === 'oci' || base.kind === 'local')) {
        this.target = {
          ref:  base.sha,
          what: base.kind === 'oci' ? 'the last version handed over' : 'the last version published into this Rancher',
          note: 'Recorded by the publish that put it there, so it is a tree that built.',
          kind: 'baseline',
        };
      } else if (snaps.length) {
        this.target = {
          ref:  snaps[0].ref,
          what: `the snapshot "${ snaps[0].label }"`,
          note: `Taken ${ snaps[0].when }. A snapshot is a point somebody chose, not necessarily a build that worked.`,
          kind: 'snapshot',
        };
      } else if (base && base.sha) {
        this.target = {
          ref:  base.sha,
          what: 'the last commit',
          note: 'No snapshot was taken before this build, so this is the last committed state rather than the last build that worked.',
          kind: 'head',
        };
      } else {
        this.target = null;
      }

      this.targetting = false;
    },

    /**
     * Open the file the log points at, here, at the line it points at.
     *
     * Here rather than on the Files screen, and that is deliberate: this panel is the one
     * holding the log, and a route away from it would need the path to travel in the query,
     * which the Files screen does not read. The file is read out of the pod, so it is the file
     * as it is now rather than a copy of it from when the build failed.
     *
     * The path in a webpack error is relative to wherever webpack was standing, which is not
     * always the package root, so it is matched against the package's own listing by suffix
     * rather than trusted as written.
     */
    async showFile() {
      if (this.reading || !this.culprit) {
        return;
      }

      if (this.file) {
        this.file = null;

        return;
      }

      this.reading = true;
      this.fileError = '';

      try {
        const path = await this.resolvePath(this.culprit);

        if (!path) {
          this.fileError = `The log names ${ this.culprit }, and there is no such file in this extension. It is most likely a path from inside a dependency, or from a build that is no longer what the pod holds.`;

          return;
        }

        const text = await readExtensionFile(this.extension, path);

        this.file = { path, text };
        this.$nextTick(() => this.scrollToLine());
      } catch (e) {
        this.fileError = e?.message || String(e);
      } finally {
        this.reading = false;
      }
    },

    /** A path out of a log or out of a model, matched against the package's own listing. */
    async resolvePath(named) {
      const wanted = String(named || '').replace(/^\.\//, '');
      const paths = await listExtensionFiles(this.extension);

      return paths.find((p) => p === wanted)
        || paths.find((p) => p.endsWith(`/${ wanted }`))
        || paths.find((p) => p.endsWith(`/${ wanted.split('/').pop() }`))
        || '';
    },

    /** Put the line the log named in the middle of the view, rather than at the top. */
    scrollToLine() {
      const row = this.$refs.culpritRow?.[0] || this.$refs.culpritRow;

      row?.scrollIntoView({ block: 'center' });
    },

    // -----------------------------------------------------------------------
    // The "explained" half of the screen's title.
    // -----------------------------------------------------------------------

    /**
     * Ask the assistant in this extension's own pod to read the log and say what happened.
     *
     * The design's title is "explained, with a way back", and the pattern-matched error line
     * above is not an explanation - it is a pointer. The only thing in this product that can
     * read a build log and say what it means in a sentence is the claude running in the pod,
     * and it is right there, in the conversation that already knows what has been happening to
     * this extension.
     *
     * It cannot answer down the wire it is asked on: `askAssistant` types into a tmux pane and
     * the reply is a character stream in the terminal. So the log goes into the pod as a file,
     * the assistant is asked to write its answer back as a file, and this polls for it. Both
     * files are in /tmp, outside the git tree the review screens diff.
     *
     * Explicit, never automatic. It is one turn in the person's own conversation with the
     * assistant, and the product should not spend that behind their back.
     */
    async explain() {
      if (this.explainState === 'sending' || this.explainState === 'waiting') {
        return;
      }

      this.explainState = 'sending';
      this.explainError = '';
      this.explainRaw = '';
      this.answer = null;
      this.waited = 0;
      this.lastSeen = '';

      try {
        const pod = await extensionPod(this.extension);

        if (!pod) {
          throw new Error(`${ this.extension } has no running pod, so there is no assistant to ask.`);
        }

        const login = await assistantLogin(this.extension);

        if (login.read && !login.signedIn) {
          throw new Error('The assistant in this pod is not signed in, so it cannot read anything. Open the Terminal tab and run /login, then ask again.');
        }

        // 777 on the directory because the exec runs as root and claude runs as uid 1000: it
        // has to be able to create the answer file in there. The base64 alphabet has nothing a
        // single-quoted shell word cares about, so the log needs no further quoting.
        const ready = await podExecOnce(pod, ['/bin/sh', '-c', [
          `mkdir -p ${ EXPLAIN_DIR }`,
          `chmod 777 ${ EXPLAIN_DIR }`,
          `rm -f ${ ANSWER_FILE }`,
          `printf %s '${ toBase64(this.logForAssistant()) }' | base64 -d > ${ LOG_FILE }`,
          `chmod 666 ${ LOG_FILE }`,
          'echo BARN-EXPLAIN-READY',
        ].join(' && ')]);

        if (!ready.includes('BARN-EXPLAIN-READY')) {
          throw new Error(`The log could not be written into the pod, so there is nothing for the assistant to read: ${ ready.trim().slice(0, 160) || 'no output' }`);
        }

        const how = await askAssistant(this.extension, this.prompt());

        this.explainState = 'waiting';

        if (how === 'queued') {
          this.explainError = 'No session is open in this pod yet, so the question is waiting as the first thing that conversation is asked. Open the Terminal tab to start it.';
        }

        this.poll();
      } catch (e) {
        this.explainState = 'error';
        this.explainError = e?.message || String(e);
      }
    },

    /** The slice of log the assistant gets, with the matched error line kept even if it fell out. */
    logForAssistant() {
      const tail = this.log.length > LOG_TAIL ? this.log.slice(-LOG_TAIL) : this.log;

      if (this.firstError && !tail.includes(this.firstError)) {
        return `${ this.firstError }\n...\n${ tail }`;
      }

      return tail;
    },

    /**
     * One line, because askAssistant flattens whitespace before it types it into the pane.
     *
     * It asks for JSON and for nothing to be edited. The design's own sequence is the snippet
     * first and Apply second (19:1018 then 19:1022), which is the point: the person sees the
     * change before it lands, and applying it is their click, not the assistant's.
     */
    prompt() {
      return [
        `A build of the extension in this pod just failed, with the message "${ (this.failure?.message || '').replace(/"/g, "'") }".`,
        `Read the build log at ${ LOG_FILE }, work out what actually went wrong, and write your answer as JSON and nothing else to ${ ANSWER_FILE }.`,
        'Keys: headline, one short sentence in plain language saying what a person would see, no jargon;',
        'cause, two or three sentences saying why it happened;',
        'file, the path in this package that is at fault, relative to the package root, or an empty string;',
        'fix, either null or an object with path, before and after, where before is the exact text to replace, copied character for character out of the file, and after is what to replace it with, both as short as they can be.',
        'Do not edit any file in the package and do not run the build: write that one JSON file and stop, and I will apply the fix myself after reading it.',
      ].join(' ');
    },

    poll() {
      this.stopPolling();

      this.timer = window.setInterval(async() => {
        // One read at a time. A pod exec can take longer than the interval, and two of them in
        // flight would double-count the wait and race over the answer.
        if (this.polling) {
          return;
        }

        this.waited += POLL_MS / 1000;

        if (this.waited > (POLL_TRIES * POLL_MS) / 1000) {
          this.stopPolling();
          this.explainState = 'timeout';

          return;
        }

        this.polling = true;

        const pod = await extensionPod(this.extension).catch(() => null);
        const out = pod
          ? await podExecOnce(pod, ['/bin/sh', '-c', `cat ${ ANSWER_FILE } 2>/dev/null`])
          : '';

        this.polling = false;

        if (!out.trim()) {
          return;
        }

        const parsed = parseAnswer(out);

        if (parsed) {
          this.stopPolling();
          this.answer = parsed;
          this.explainState = 'done';

          return;
        }

        // It did not parse. That is either an answer in prose or a JSON file caught half
        // written, and `cat` cannot tell them apart - so wait for the content to stop moving
        // before showing it. One quiet interval is enough: a write that is still going changes
        // between reads four seconds apart.
        if (out !== this.lastSeen) {
          this.lastSeen = out;

          return;
        }

        this.stopPolling();
        this.explainRaw = out.trim();
        this.explainState = 'done';
      }, POLL_MS);
    },

    stopPolling() {
      if (this.timer) {
        window.clearInterval(this.timer);
        this.timer = null;
      }

      this.polling = false;
    },

    stopWaiting() {
      this.stopPolling();
      this.explainState = '';
    },

    /**
     * Apply the assistant's change, having shown it first.
     *
     * A literal replacement of text the assistant said is in the file, checked against the file
     * as it is now. If it is not there the change is refused with the reason: a model quoting a
     * line approximately is the ordinary case, and a fuzzy match that edited the wrong line
     * would be exactly the kind of silent damage this product is careful not to do.
     *
     * A snapshot first, so applying it is itself undoable.
     */
    async applyFix() {
      if (this.applying || !this.fix) {
        return;
      }

      this.applying = true;

      try {
        const path = await this.resolvePath(this.fix.path);

        if (!path) {
          throw new Error(`The fix names ${ this.fix.path }, and there is no such file in this extension.`);
        }

        const text = await readExtensionFile(this.extension, path);

        if (!text.includes(this.fix.before)) {
          throw new Error(`The line the assistant quoted is not in ${ path } as written, so this cannot be applied for you. Open the file and make the change by hand.`);
        }

        await createSnapshot(this.extension, 'before applying the suggested fix').catch(() => '');
        // A function, not a string. `String.replace` reads `$&`, `$1` and `$\`` in a replacement
        // string as substitutions, and the assistant's `after` is somebody's source line - a
        // template literal or a jQuery-ish selector in it would be silently rewritten.
        await writeExtensionFile(this.extension, path, text.replace(this.fix.before, () => this.fix.after));

        this.applied = path;
        this.file = null;
        this.$emit('changed');
        toastSuccess(this.$store, `${ path } changed. Publish again to build it.`, { title: 'Fix applied' });
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'The fix was not applied' });
      } finally {
        this.applying = false;
      }
    },

    /**
     * Hand the failure to the assistant as an instruction rather than as a question.
     *
     * The flow map's return arrow: the recovery goes back into the workspace with the problem
     * already loaded into the assistant, so nobody retypes it. The context that gets attached
     * is the context this panel actually has - the message, the matched line and the file.
     */
    async askForFix() {
      const parts = [
        `The last build of this extension failed with "${ (this.failure?.message || '').replace(/"/g, "'") }".`,
        this.firstError ? `The log's error line is: ${ this.firstError }` : '',
        this.culprit ? `It points at ${ this.culprit }${ this.culpritLine ? ` line ${ this.culpritLine }` : '' }.` : '',
        'Find out why and fix it, then tell me what you changed. Do not publish.',
      ].filter(Boolean);

      try {
        const how = await askAssistant(this.extension, parts.join(' '));

        toastSuccess(
          this.$store,
          how === 'queued'
            ? 'No session is open in this pod yet, so it is waiting as the first thing that conversation is asked.'
            : 'The failure, the error line and the file are in the conversation. Its reply is in the terminal.',
          { title: 'Sent to the assistant' },
        );
        this.$emit('open-tab', 'terminal');
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'The message did not reach the assistant' });
      }
    },

    // -----------------------------------------------------------------------
    // The ways back.
    // -----------------------------------------------------------------------

    /**
     * Put the tree back, having first snapshotted what it is now.
     *
     * The safety snapshot is what makes the design's note true: "Every build is snapshotted.
     * Nothing you have done is lost" (19:1092). Rolling back is the one action on this panel
     * that throws work away, so it is the one that has to be reversible, and a tagged commit of
     * the failed tree is what makes it so.
     */
    async rollBack() {
      if (this.rollingBack || !this.target) {
        return;
      }

      this.rollingBack = true;

      // Read before anything clears it: `clearFailure` announces itself, and the reload that
      // follows would take `target` away before the toast has quoted it.
      const { ref, what } = this.target;

      try {
        this.safety = await createSnapshot(this.extension, 'the failed build, before rolling back').catch(() => '');
        await restoreSnapshot(this.extension, ref);

        this.settling = true;
        clearFailure();
        this.settling = false;
        this.failure = null;
        this.$emit('changed');
        this.$emit('resolved');
        toastSuccess(
          this.$store,
          this.safety
            ? 'The failed tree was snapshotted first, so nothing is lost. It is in the Snapshots menu.'
            : 'The tree is back. The snapshot of the failed state could not be taken, so that state is gone.',
          { title: `Rolled back to ${ what }` },
        );
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'The roll back did not happen' });
      } finally {
        this.rollingBack = false;
      }
    },

    /** One file, the most recently changed. Scoped, and the label says which scope. */
    async undoLast() {
      if (this.undoing) {
        return;
      }

      this.undoing = true;

      try {
        const path = await undoLastChange(this.extension);

        if (!path) {
          toastSuccess(this.$store, 'Nothing in the working tree differs from the last commit.', { title: 'Nothing to undo' });
        } else {
          this.file = null;
          this.$emit('changed');
          toastSuccess(this.$store, `${ path } is back to its committed state.`, { title: 'Undone' });
        }

        this.findWayBack();
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'The undo did not happen' });
      } finally {
        this.undoing = false;
      }
    },

    /**
     * The record changed under us.
     *
     * Ignored while this component is the one changing it: `clearFailure` fires the same event,
     * and reloading in the middle of a roll back would wipe the labels the toast is about to
     * quote.
     */
    onRecordChanged() {
      if (this.settling) {
        return;
      }

      this.load();
    },

    dismiss() {
      this.settling = true;
      clearFailure();
      this.failure = null;
      this.settling = false;
      this.$emit('resolved');
    },
  },
};
</script>

<template>
  <div v-if="failure" class="bf" data-testid="barn-build-failure">
    <!-- the failure, as the assistant's turn in the stream (19:1007) -->
    <div class="bf__card" data-testid="barn-failure-card">
      <div class="bf__head">
        <span class="bf__alert">
          <SIcon name="alert" :size="14" />
        </span>
        <div class="bf__head-text">
          <div class="bf__headline" data-testid="barn-failure-headline">
            {{ headline }}
          </div>
          <div v-if="subline" class="bf__subline" data-testid="barn-failure-subline">
            {{ subline }}
          </div>
        </div>
        <SButton
          variant="ghost"
          size="sm"
          icon="close"
          icon-only
          aria-label="Dismiss this failure"
          data-testid="barn-failure-dismiss"
          @click="dismiss"
        />
      </div>

      <p class="bf__message">
        {{ failure.message }}
      </p>

      <!-- the assistant's reading of the log, when it has been asked for one -->
      <div v-if="answer && answer.cause" class="bf__answer" data-testid="barn-explain-answer">
        <div class="bf__answer-meta">
          <SIcon name="sparkle" :size="12" />
          <span>The assistant read the log and said this</span>
        </div>
        <p class="bf__answer-text">
          {{ answer.cause }}
        </p>
      </div>

      <pre
        v-else-if="explainRaw"
        class="bf__answer-raw"
        data-testid="barn-explain-answer"
      >{{ explainRaw }}</pre>

      <!-- the pattern match, which is what there is until the assistant has read it -->
      <template v-else>
        <code v-if="firstError" class="bf__error-line" data-testid="barn-error-line">{{ firstError }}</code>
        <p v-else class="bf__note">
          No line in this log looks like an error. The publish reported the failure above, so
          something went wrong after or outside the compile.
        </p>
        <p class="bf__hint">
          Picked out of the log by pattern, not by understanding it. Ask the assistant to read
          it for the explanation this screen is supposed to carry.
        </p>
      </template>

      <!-- the assistant round trip -->
      <div class="bf__explain">
        <SButton
          v-if="explainState !== 'waiting'"
          variant="secondary"
          size="sm"
          icon="sparkle"
          :loading="explainState === 'sending'"
          data-testid="barn-explain-ask"
          @click="explain"
        >
          {{ answer || explainRaw ? 'Ask again' : 'Ask the assistant to explain this' }}
        </SButton>

        <template v-else>
          <SChip label="Waiting for the assistant" icon="spinner" tone="info" />
          <span class="bf__waited">{{ Math.round(waited) }}s</span>
          <SButton
            variant="ghost"
            size="sm"
            icon="stop"
            data-testid="barn-explain-stop"
            @click="stopWaiting"
          >
            Stop waiting
          </SButton>
        </template>
      </div>

      <p v-if="explainState === 'waiting'" class="bf__hint">
        The log is in the pod and the assistant has been asked to read it and write back what it
        found. Its working is in the Terminal tab; the answer lands here.
      </p>

      <p v-if="explainState === 'timeout'" class="bf__note">
        The assistant has not written an answer yet. It may still be working, and the Terminal
        tab is where it is doing it. Ask again to keep waiting.
      </p>

      <p v-if="explainError" class="bf__note">
        {{ explainError }}
      </p>

      <!-- the fix, shown as a diff before it is applied (19:1018) -->
      <div v-if="fix" class="bf__fix">
        <SLabel text="The change it proposes" />
        <div class="bf__snippet" data-testid="barn-fix-snippet">
          <div class="bf__snippet-path">
            {{ fix.path }}
          </div>
          <div class="bf__snippet-line bf__snippet-line--removed">
            <span class="bf__sign">-</span><span>{{ fix.before }}</span>
          </div>
          <div class="bf__snippet-line bf__snippet-line--added">
            <span class="bf__sign">+</span><span>{{ fix.after }}</span>
          </div>
        </div>
      </div>

      <p v-if="applied" class="bf__note">
        Applied to {{ applied }}. The tree before it was snapshotted, so this is undoable from
        the Snapshots menu. Publish again to build it.
      </p>

      <!-- the card's own actions (19:1022, 19:1026, 19:1031) -->
      <div class="bf__actions">
        <SButton
          v-if="fix"
          variant="primary"
          size="sm"
          icon="check"
          :loading="applying"
          data-testid="barn-apply-fix"
          @click="applyFix"
        >
          Apply this fix
        </SButton>

        <SButton
          variant="secondary"
          size="sm"
          icon="sparkle"
          data-testid="barn-assistant-fix"
          @click="askForFix"
        >
          Ask the assistant to fix it
        </SButton>

        <SButton
          v-if="culprit"
          variant="ghost"
          size="sm"
          icon="file"
          :loading="reading"
          data-testid="barn-show-file"
          @click="showFile"
        >
          {{ file ? 'Hide' : 'Show me' }} {{ culprit }}{{ culpritLine ? ` at line ${ culpritLine }` : '' }}
        </SButton>
      </div>

      <p v-if="fileError" class="bf__note">
        {{ fileError }}
      </p>

      <div v-if="file" class="bf__file">
        <div class="bf__file-head">
          <SIcon name="file" :size="13" />
          <span>{{ file.path }}</span>
        </div>
        <div class="bf__file-body">
          <div
            v-for="(line, i) in fileLines"
            :key="i"
            :ref="i + 1 === culpritLine ? 'culpritRow' : undefined"
            class="bf__file-line"
            :class="{ 'bf__file-line--here': i + 1 === culpritLine }"
          >
            <span class="bf__file-num">{{ i + 1 }}</span>
            <span class="bf__file-text">{{ line }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- the ways back (19:781 and 19:959, which the design makes the same action) -->
    <div class="bf__ways" data-testid="barn-changes-summary">
      <div class="bf__ways-text">
        <span class="bf__ways-title">The working tree still holds the change that failed</span>
        <span v-if="targetting" class="bf__ways-note">Looking for the last build that worked...</span>
        <span v-else-if="target" class="bf__ways-note">
          {{ target.note }}<template v-if="changesNote"> {{ changesNote }}.</template>
        </span>
        <span v-else class="bf__ways-note">
          This extension has no history in its pod yet, so there is nothing to go back to.
        </span>
      </div>

      <div class="bf__ways-buttons">
        <SButton
          v-if="target"
          variant="secondary"
          size="sm"
          icon="undo"
          :loading="rollingBack"
          data-testid="barn-rollback"
          @click="rollBack"
        >
          {{ targetLabel }}
        </SButton>

        <SButton
          variant="ghost"
          size="sm"
          icon="undo"
          :loading="undoing"
          data-testid="barn-undo-last"
          @click="undoLast"
        >
          Undo the last change
        </SButton>
      </div>
    </div>

    <p class="bf__snapshot-note" data-testid="barn-snapshot-note">
      <SIcon name="info" :size="12" />
      <span v-if="target && target.kind === 'build'">
        Rolling back snapshots the failed tree first, so nothing you have done is lost - it stays
        in the Snapshots menu.
      </span>
      <span v-else>
        Rolling back snapshots the failed tree first, so nothing you have done is lost. What it
        rolls back <em>to</em> is only as good as the point above: nothing takes a snapshot
        automatically when a build succeeds yet, so this is the nearest point that exists rather
        than a guaranteed last working build.
      </span>
    </p>

    <p class="bf__snapshot-note">
      <SIcon name="alert" :size="12" />
      <span>
        There is no "undo my request" here. Undo is scoped to one file, and nothing in this
        product records which edits came from which message, so an undo of a whole request
        cannot be offered honestly yet.
      </span>
    </p>

    <!-- raw output, collapsed, with the real line count (19:1036) -->
    <div v-if="raw === 'inline'" class="bf__log-panel">
      <button
        type="button"
        class="bf__panel-head"
        :aria-expanded="showLog"
        data-testid="barn-raw-output-toggle"
        :disabled="!logLines"
        @click="showLog = !showLog"
      >
        <SIcon name="terminal" :size="14" />
        <span class="bf__panel-title">{{ logLabel }}</span>
        <span v-if="logLines" class="bf__panel-count">
          {{ logLines }} line{{ logLines === 1 ? '' : 's' }}
        </span>
        <span class="bf__panel-grow" />
        <SIcon
          v-if="logLines"
          :name="showLog ? 'chevronUp' : 'chevronDown'"
          :size="14"
        />
      </button>

      <pre v-if="showLog && logLines" class="bf__log">{{ log }}</pre>

      <SBanner v-else-if="!logLines" type="info">
        The publish failed without the build writing anything, so there is no log to read. The
        message above is the whole of what was said.
      </SBanner>

      <button
        v-if="embedded && showLog"
        type="button"
        class="bf__panel-head bf__panel-head--foot"
        @click="$emit('open-tab', 'terminal')"
      >
        <SIcon name="terminal" :size="14" />
        <span class="bf__panel-title">Open the live terminal</span>
        <span class="bf__panel-grow" />
        <SIcon name="chevronRight" :size="13" />
      </button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.bf {
  display:        flex;
  flex-direction: column;
  gap:            var(--studio-space-12);

  &__card {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-8);
    border:         1px solid var(--studio-error);
    border-radius:  var(--studio-radius);
    background:     var(--studio-surface);
    padding:        var(--studio-space-12) 14px;
  }

  &__head {
    display:     flex;
    align-items: flex-start;
    gap:         var(--studio-space-8);
  }

  &__alert {
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    width:           22px;
    height:          22px;
    flex:            0 0 auto;
    border-radius:   var(--studio-radius-pill);
    background:      var(--studio-error-bg);
    color:           var(--studio-error);
  }

  &__head-text {
    display:        flex;
    flex-direction: column;
    gap:            2px;
    flex:           1 1 auto;
    min-width:      0;
  }

  &__headline {
    font:  var(--studio-heading-16);
    color: var(--studio-text);
  }

  &__subline {
    font:  var(--studio-caption-12);
    color: var(--studio-text-secondary);
  }

  &__message {
    margin: 0;
    font:   var(--studio-body-13);
    color:  var(--studio-text-secondary);
  }

  &__answer {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-4);
    border-left:    2px solid var(--studio-accent);
    padding-left:   10px;
  }

  &__answer-meta {
    display:        flex;
    align-items:    center;
    gap:            6px;
    font:           var(--studio-caption-11-caps);
    letter-spacing: var(--studio-tracking-caps);
    text-transform: uppercase;
    color:          var(--studio-text-tertiary);
  }

  &__answer-text {
    margin: 0;
    font:   var(--studio-body-13);
    color:  var(--studio-text);
  }

  &__answer-raw {
    margin:        0;
    padding:       var(--studio-space-8) 10px;
    background:    var(--studio-surface-subtle);
    border-radius: var(--studio-radius-control);
    font:          var(--studio-mono-12);
    color:         var(--studio-text);
    white-space:   pre-wrap;
    word-break:    break-word;
    max-height:    220px;
    overflow:      auto;
  }

  &__error-line {
    display:       block;
    font:          var(--studio-mono-12);
    color:         var(--studio-error);
    background:    var(--studio-error-bg);
    border-radius: var(--studio-radius-control);
    padding:       var(--studio-space-8) 10px;
    word-break:    break-word;
  }

  &__note {
    margin: 0;
    font:   var(--studio-body-13);
    color:  var(--studio-text-secondary);
  }

  &__hint {
    margin: 0;
    font:   var(--studio-caption-12);
    color:  var(--studio-text-tertiary);
  }

  &__explain {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
    flex-wrap:   wrap;
  }

  &__waited {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  &__fix {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-4);
  }

  &__snippet {
    border:        1px solid var(--studio-border-subtle);
    border-radius: var(--studio-radius);
    overflow:      hidden;
  }

  &__snippet-path {
    padding:       4px 10px;
    background:    var(--studio-surface-subtle);
    border-bottom: 1px solid var(--studio-border-subtle);
    font:          var(--studio-caption-12-semi);
    color:         var(--studio-text-secondary);
  }

  &__snippet-line {
    display:     flex;
    gap:         8px;
    padding:     3px 10px;
    font:        var(--studio-mono-12);
    white-space: pre-wrap;
    word-break:  break-word;

    &--removed {
      background: var(--studio-diff-removed-bg);
      color:      var(--studio-diff-removed-text);
    }

    &--added {
      background: var(--studio-diff-added-bg);
      color:      var(--studio-diff-added-text);
    }
  }

  &__sign {
    flex:        0 0 auto;
    user-select: none;
    opacity:     0.7;
  }

  &__actions {
    display:   flex;
    gap:       var(--studio-space-8);
    flex-wrap: wrap;
  }

  &__file {
    border:        1px solid var(--studio-border-subtle);
    border-radius: var(--studio-radius);
    overflow:      hidden;
  }

  &__file-head {
    display:       flex;
    align-items:   center;
    gap:           6px;
    padding:       6px 10px;
    background:    var(--studio-surface-subtle);
    border-bottom: 1px solid var(--studio-border-subtle);
    font:          var(--studio-caption-12-semi);
    color:         var(--studio-text-secondary);
  }

  &__file-body {
    max-height: 320px;
    overflow:   auto;
  }

  &__file-line {
    display: flex;
    gap:     10px;
    padding: 0 10px;
    font:    var(--studio-mono-12);

    &--here {
      background: var(--studio-error-bg);
      color:      var(--studio-error);
    }
  }

  &__file-num {
    flex:        0 0 auto;
    min-width:   28px;
    text-align:  right;
    color:       var(--studio-text-tertiary);
    user-select: none;
  }

  &__file-text {
    white-space: pre-wrap;
    word-break:  break-word;
  }

  &__ways {
    display:       flex;
    align-items:   center;
    gap:           var(--studio-space-12);
    flex-wrap:     wrap;
    padding:       10px 14px;
    border:        1px solid var(--studio-border);
    border-radius: var(--studio-radius);
    background:    var(--studio-surface-subtle);
  }

  &__ways-text {
    display:        flex;
    flex-direction: column;
    gap:            2px;
    flex:           1 1 220px;
    min-width:      0;
  }

  &__ways-title {
    font:  var(--studio-body-13-semi);
    color: var(--studio-text);
  }

  &__ways-note {
    font:  var(--studio-caption-12);
    color: var(--studio-text-secondary);
  }

  &__ways-buttons {
    display:   flex;
    gap:       var(--studio-space-8);
    flex-wrap: wrap;
  }

  &__snapshot-note {
    display:     flex;
    align-items: flex-start;
    gap:         6px;
    margin:      0;
    font:        var(--studio-caption-12);
    color:       var(--studio-text-tertiary);
  }

  &__log-panel {
    display:        flex;
    flex-direction: column;
    border:         1px solid var(--studio-border);
    border-radius:  var(--studio-radius);
    overflow:       hidden;
    min-height:     0;
  }

  // A button rather than a caption, so everything a button brings by default has to be taken
  // back off: the geometry here is measured against the design (14:389).
  &__panel-head {
    display:       flex;
    align-items:   center;
    gap:           var(--studio-space-8);
    padding:       var(--studio-space-12) 14px;
    background:    var(--studio-surface-subtle);
    border:        none;
    border-bottom: 1px solid var(--studio-border-subtle);
    border-radius: 0;
    color:         var(--studio-text-secondary);
    flex:          0 0 auto;
    width:         100%;
    min-height:    0;
    text-align:    left;
    cursor:        pointer;

    &:hover:not(:disabled) { color: var(--studio-text); }

    &:disabled { cursor: default; }

    &--foot {
      border-bottom: none;
      border-top:    1px solid var(--studio-border-subtle);
    }
  }

  &__panel-title { font: var(--studio-heading-14); color: var(--studio-text); }

  &__panel-count {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  &__panel-grow { flex: 1 1 auto; }

  &__log {
    margin:      0;
    padding:     var(--studio-space-12) var(--studio-space-16);
    background:  var(--studio-surface-terminal);
    color:       var(--studio-terminal-text);
    font:        var(--studio-mono-12);
    white-space: pre-wrap;
    word-break:  break-word;
    max-height:  340px;
    overflow-y:  auto;
  }
}
</style>
