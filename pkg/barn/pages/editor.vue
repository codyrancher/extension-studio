<script>
// The Editor: two panes filling the page, reached from the flask button in the side menu or
// from the extension box in the header.
//
// Left pane: a terminal in the extension's pod, with claude running in it (see
// components/PodTerminal.vue).
// Right pane: that extension's dev server (see extensions.ts) - the live, hot-reloading
// Rancher the same pod is serving, framed same-origin through the Kubernetes API service
// proxy, which is what makes framing it possible.
//
// So the two panes are two views of one pod: what claude edits on the left is what
// hot-reloads on the right, and which pod that is comes from the route.
//
// Registered in index.ts under the 'plain' parent rather than 'blank'. Blank renders the
// route and nothing else, which meant this page had to carry a Back button to be escapable
// at all. Plain brings the shell's header and the top-level menu, which is the way out.
//
// This page used to collapse that header to nothing, on the argument that each pane labels
// itself. What went with it was everything only the header has: the product wordmark, the
// notification tray, the page-actions menu and the account menu, none of which this page
// replaces - so the workspace was the one screen in Rancher you could not sign out of. The
// design draws the header over this frame, and the header is now left where the shell puts it.
import PodTerminal from '../components/PodTerminal.vue';
import ExtensionSelect from '../components/ExtensionSelect.vue';
import PublishStatus from '../components/PublishStatus.vue';
import ExtensionFiles from '../components/ExtensionFiles.vue';
import NewExtensionModal from '../components/NewExtensionModal.vue';
import EditorSettingsModal from '../components/EditorSettingsModal.vue';
import ImportExtensionModal from '../components/ImportExtensionModal.vue';
import PublishGithubModal from '../components/PublishGithubModal.vue';
import PublishModal from '../components/PublishModal.vue';
import InstallProgress from '../components/InstallProgress.vue';
import EditorMasthead from '../components/EditorMasthead.vue';
import { AssistantPanel, PreviewPanel, WorkingChanges } from '../components/studio';
import {
  BUILD_FAILED_ROUTE, STUDIO_ROUTE, STUDIO_PAGE_ACTIONS, handleStudioPageAction
} from '../editor-product';
import pageActionsMixin from '@shell/mixins/page-actions';
import { SButton, SModal } from '../components/ui';
import StartingExtensions from '../components/StartingExtensions.vue';
import BuildFailure from '../components/BuildFailure.vue';
import fullBleed from '../design/full-bleed';
import {
  ensureExtension, extensionReady, extensionUrl, publishExtension,
  removeLocalInstall, DEFAULT_EXTENSION,
  askAssistant, readExtensionFile
} from '../extensions';
import {
  handOverForReview, distributeExtension, readComment, markCommentSent, originStamp
} from '../review';
import { toastError, toastSuccess } from '../toast';
import { installState } from '../install';
import { recordFailure, recordWorkingBuild } from '../publish-failure';

// How close to an edge the divider can be dragged, in percent of the page.
const MIN_SPLIT = 10;
const MAX_SPLIT = 90;

// Half the divider's own width, which the pane's percentage has to give back.
const DIVIDER_HALF = 4;

// Where the divider position is remembered between visits. It's stored as a
// percentage, so the panes keep their proportions when the window is a
// different size next time.
const SPLIT_KEY = 'barn.editor.split';

function clampSplit(percent) {
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, percent));
}

// `null` is the design's default rather than a number: Foundations (28:195) names the
// assistant panel 520px wide, and 520px is not a percentage until there is a container to
// measure it against. The pane renders at the token width until somebody drags it.
function readSplit() {
  try {
    const stored = parseFloat(window.localStorage.getItem(SPLIT_KEY));

    return isNaN(stored) ? null : clampSplit(stored);
  } catch {
    // Storage can be unavailable (private mode, blocked cookies) - not fatal.
    return null;
  }
}

function writeSplit(percent) {
  try {
    if (percent == null) {
      window.localStorage.removeItem(SPLIT_KEY);
    } else {
      window.localStorage.setItem(SPLIT_KEY, String(percent));
    }
  } catch { /* see readSplit */ }
}

// How often to re-ask the dev server whether it's up. Its first boot is an
// install and a full dashboard compile, so this is a wait of minutes, not
// seconds, and there's nothing to gain from asking faster.
const DEV_POLL_MS = 5000;

// Which tmux session in the pod the editor's terminal attaches to. Named once here because two
// things now depend on it - the terminal itself, and the assistant panel's session menu, which
// offers the name so it can be attached to from a shell - and they must not drift apart.
const TERMINAL_SESSION = 'editor';

// Where the messages sent from the composer are kept, so the stream still has your half of the
// conversation after a reload. Per extension, because each pod has a conversation of its own.
//
// sessionStorage rather than the pod: these are a record of what this tab sent, not of what the
// session contains - the session itself lives in tmux and outlives every browser tab.
const TURNS_KEY = 'barn.editor.turns';

// How many to keep. Long enough to be a conversation, short enough that the storage entry stays
// small when somebody works in here all afternoon.
const MAX_TURNS = 50;

function readTurns(extension) {
  try {
    const all = JSON.parse(window.sessionStorage.getItem(TURNS_KEY) || '{}');

    return Array.isArray(all[extension]) ? all[extension] : [];
  } catch {
    return [];
  }
}

function writeTurns(extension, turns) {
  try {
    const all = JSON.parse(window.sessionStorage.getItem(TURNS_KEY) || '{}');

    all[extension] = turns;
    window.sessionStorage.setItem(TURNS_KEY, JSON.stringify(all));
  } catch { /* storage can be unavailable; the stream is then this tab's only */ }
}

export default {
  name: 'BarnEditor',

  components: {
    PodTerminal, ExtensionSelect, ExtensionFiles, NewExtensionModal, StartingExtensions, BuildFailure,
    PublishStatus, EditorSettingsModal, ImportExtensionModal, PublishGithubModal, PublishModal,
    InstallProgress, EditorMasthead, AssistantPanel, PreviewPanel, WorkingChanges, SButton,
    SModal
  },

  mixins: [fullBleed, pageActionsMixin],

  data() {
    return {
      rightUrl: '',
      terminalSession: TERMINAL_SESSION,
      // Width of the left pane, as a percentage of the page. `null` means the design's own
      // width, which `paneStyle` takes straight off the panel token.
      split:    readSplit(),
      // What that token width works out to as a percentage, for the divider's aria value and
      // for the keyboard steps that move off it. Measured once the panes are on the page.
      tokenSplit: 50,
      dragging: false,
      // Bookkeeping for the dev server poll, so it stops with the page.
      unmounted:    false,
      devPollTimer: null,
      // Which of the assistant panel's four views is showing. The terminal stays mounted
      // whichever it is (see the template): it is a live session, and unmounting it to look at
      // a file would end whatever claude was in the middle of.
      // Which of the assistant panel's four views is showing. Seeded from `?tab=` so another
      // screen can send somebody here pointed at the right one - the review and verification
      // screens ask the pod's assistant a question and then land the user on the terminal,
      // where the answer actually appears. Without this they arrive on Assistant and have to
      // find it.
      leftTab: ['assistant', 'files', 'changes', 'terminal'].includes(this.$route.query.tab)
        ? this.$route.query.tab
        : 'assistant',
      // The terminal's websocket state, for the session row's dot.
      terminalState: '',
      // Bumped to make the Changes tab re-read the working tree when it is opened, so it is
      // never showing a diff from before the last thing the assistant did.
      changesRevision: 0,
      // Whether this cluster still has objects to make before the editor is worth showing.
      // Undefined until the first read, so the page shows neither the panes nor the checklist
      // in the moment before it knows which is right - a flash of the wrong one reads as a bug.
      needsInstall: undefined,
      // Whether the settings modal is open. It sits at the other end of the same bar as Files,
      // because both are about the pane under it rather than about the dashboard on the right.
      showSettings: false,
      // Whether the import modal is open. It is reached from the same dropdown as the two
      // publishes, which is not where an import belongs by rights - but that dropdown is where
      // "the other things this button can do" already lives, and a fourth control on this bar
      // would cost more than the misfiling does.
      importing: false,
      // Whether the "where to" question for a GitHub publish is open.
      publishingGithub: false,
      // Whether the publish dialog - which destinations, and what is in the changeset - is up.
      // Publish used to be an immediate action from the masthead: several minutes of build in a
      // shared pod ending in a UIPlugin upserted into this Rancher, with nothing asked first.
      choosingPublish: false,
      // Which modal sent us to settings, so closing settings can put that one back rather than
      // dropping somebody where they did not start. '' when settings was opened from the cog.
      settingsReturn: '',
      // One publish at a time. AsyncButton used to refuse a second press by itself; a split
      // button has two ways in, so the refusal has to be here instead.
      publishing: false,
      // Whether the "are you sure" for removing the local install is up. Removing is the one
      // action on this page that takes something away from the Rancher everybody is looking
      // at, and both ways in - the publish dropdown and the masthead's overflow - go through
      // it rather than one of them asking and the other not.
      confirmRemove: false,
      // The name typed into the box that does not exist yet, held while the modal asks what it
      // should be a copy of.
      creating:  '',
      // Extensions that have been asked for and are coming up. A list rather than one, because
      // nothing here stops you asking for a second while the first is still installing.
      starting:  [],
      // What the right pane is showing, as a path inside the framed dashboard. Kept in sync
      // with the iframe by a poll rather than by its load event, because the thing in there is
      // a single-page app: it changes its URL with pushState and never loads again.
      // What the last publish did and said. The stage is what the bar counts; the log is kept
      // whether it worked or not, because a build log is worth reading either way.
      publishStage: 0,
      publishTotal: 0,
      publishLabel: '',
      publishError: '',
      publishLog:   '',
      published:    '',
      // Your half of the conversation, as turns the activity stream can render.
      //
      // Real and nothing more than that: each entry is a message this composer actually sent
      // and the moment it was sent. The assistant's half is not here, because claude's output
      // is a character stream and turning it into steps with durations is a parser nobody has
      // written - see the note the stream carries under the last turn.
      turns:        readTurns(this.$route.params.extension || DEFAULT_EXTENSION),
      // Bumped every second so "2 minutes ago" on a turn counts up rather than freezing.
      now:          Date.now(),
      nowTimer:     null,
    };
  },

  computed: {
    /**
     * The route names, exposed to the template.
     *
     * A plain `<script>` block's module scope is not the render function's scope, so an
     * imported constant named directly in the template resolves to undefined and
     * `$router.push({ name: undefined })` is dropped without an error. That is a button that
     * looks live and does nothing, silently - which is exactly how these were found.
     */
    routes() {
      return { BUILD_FAILED_ROUTE, STUDIO_ROUTE };
    },

    /**
     * What Rancher's header kebab offers on this screen (Figma 53:1368).
     *
     * The design draws a three-dot in the top bar of the workspace and does not draw what is
     * inside it. Rancher's header already has that control - `HeaderPageActionMenu`, beside the
     * bell and the user menu - and shows it whenever the mounted page has committed a non-empty
     * `pageActions`. The Studio's routes use the `plain` layout, which commits nothing, so on
     * this screen the kebab was simply absent rather than empty.
     *
     * `@shell/mixins/page-actions` commits this on `created` and clears it on `beforeUnmount`,
     * so the menu belongs to the workspace and not to every page in Rancher - which is the
     * distinction that made `NavHeaderRight` the wrong home for the Studio's old header
     * controls (see index.ts).
     *
     * The list is the Studio-wide one from editor-product.ts, shared with screens 01, 02 and
     * 11 so the same kebab cannot mean different things on different screens. It is not the
     * masthead's overflow and does not duplicate it: that one is the other screens *about this
     * extension*, and these are the three places in the Studio a workspace has no other way to
     * reach.
     */
    pageActions() {
      return STUDIO_PAGE_ACTIONS;
    },

    /** The divider's position as a number, which before a drag is the token width's. */
    percent() {
      return this.split == null ? this.tokenSplit : this.split;
    },

    /**
     * The left pane's width: the design's 520 until somebody drags, then their percentage.
     *
     * The token rather than the measured percentage, so the default is exact at any window
     * size and does not depend on having measured anything first.
     */
    paneStyle() {
      return {
        width: this.split == null
          ? 'var(--studio-panel-assistant)'
          : `calc(${ this.split }% - ${ DIVIDER_HALF }px)`,
      };
    },

    /**
     * What the far half of the Publish button offers.
     *
     * Only the one for now, and it is a list rather than a second button because what goes in
     * here next - a release, a chart, a different repository - is another line rather than
     * another control on a bar that is already full.
     */
    terminalConnected() {
      return this.terminalState === 'open';
    },

    publishOptions() {
      return [
        { id: 'github', label: 'Publish to GitHub' },
        { id: 'import', label: 'Import from GitHub' },
        { id: 'remove', label: 'Remove local install' },
      ];
    },

    // Which extension this editor is pointed at. A path segment rather than a fixed name, so
    // the header's box can send you between them, and defaulted so every link that predates
    // there being more than one still works.
    extension() {
      return this.$route.params.extension || DEFAULT_EXTENSION;
    },

    /** The stream's turns, with the relative time worked out at render rather than at send. */
    streamTurns() {
      return this.turns.map((turn) => ({
        role: 'user',
        text: turn.text,
        when: this.ago(turn.at),
      }));
    },

  },

  watch: {
    // Switching extensions is switching pods: the right pane has to go back to waiting rather
    // than keep framing the one that is no longer being edited. The terminal on the left
    // re-connects on its own, because `extension` is a prop of it.
    extension(name) {
      this.needsInstall = undefined;
      this.checkInstall();
      this.turns = readTurns(name);
      this.rightUrl = '';
      // The poll from the extension being left is still in its sleep. Waking it early is not
      // the point - waitForDevServer checks whose it is - but leaving a timer behind for the
      // page to clear later is untidy when a new one is about to replace it.
      clearTimeout(this.devPollTimer);
      this.waitForDevServer();
    },

    // Persist the divider position, but not on every pointermove - the final
    // position of a drag is written when the drag ends.
    split(percent) {
      if (!this.dragging) {
        writeSplit(percent);
      }
    },

    dragging(dragging) {
      if (!dragging) {
        writeSplit(this.split);
      }
    },

    needsInstall() {
      this.$nextTick(() => this.measureTokenSplit());
    },
  },

  mounted() {
    this.checkInstall();
    // The terminal brings itself up (it waits on the pod, not on the dev
    // server), so nothing here has to wait for the left pane.
    this.waitForDevServer();

    this.nowTimer = setInterval(() => {
      this.now = Date.now();
    }, 1000);

    this.handleHandoff();
  },

  beforeUnmount() {
    this.unmounted = true;
    clearTimeout(this.devPollTimer);
    clearInterval(this.nowTimer);
  },

  methods: {
    /** One of the header kebab's items was chosen. Dispatched here by the same mixin. */
    handlePageAction(action) {
      handleStudioPageAction(this, action);
    },

    /**
     * Is there anything left to make before this is an editor?
     *
     * Read rather than assumed, and read again when the extension changes: a cluster that has
     * been running for a week needs nothing, and a fresh one needs nine objects. Failing the
     * read is treated as "nothing to do" - the checklist is an explanation, and a page that
     * refuses to render because it could not decide whether to explain itself is worse than
     * one that just opens.
     */
    async checkInstall() {
      const state = await installState(this.extension).catch(() => []);

      this.needsInstall = state.some((entry) => entry.state !== 'done');
    },

    onInstalled() {
      this.needsInstall = false;
      // The pod is new, so the poll that was waiting on the old one is waiting on nothing.
      this.rightUrl = '';
      this.waitForDevServer();
    },

    /**
     * Frame the dev server once it answers.
     *
     * It is created when the extension loads, but a cold one installs and compiles for a few
     * minutes first, and framing it before then would show the proxy's error page instead. So
     * this is a poll, and the poll outlives the extension it was started for: a new one is
     * created when the extension changes, while the old one is still asleep between checks.
     *
     * Hence `mine`. Without it the loop that was waiting on the extension you left goes on
     * polling, and when that one finally comes up - which is exactly what happens if you start
     * one and switch away while it builds - it frames itself over whatever you switched to.
     * Every use of the name below is the one this loop was started for, and the last check
     * before framing is against the current one, because minutes pass inside that await.
     */
    async waitForDevServer() {
      const mine = this.extension;

      // This waits; it does not install. It used to call ensureExtension here, which quietly
      // made the objects the checklist was about to report on - so the checklist would find
      // nothing missing and the install nobody could see went on being invisible. Creating is
      // InstallProgress's job now, and this starts once it says the objects are there.
      while (!this.unmounted && this.extension === mine) {
        if (await extensionReady(mine)) {
          if (this.extension === mine) {
            this.rightUrl = extensionUrl(mine);
          }

          return;
        }

        await new Promise((resolve) => {
          this.devPollTimer = setTimeout(resolve, DEV_POLL_MS);
        });
      }
    },

    startDrag(event) {
      this.dragging = true;
      // Capture keeps the moves coming to the divider once the pointer is over
      // an iframe - without it the iframe's document swallows them.
      event.currentTarget.setPointerCapture(event.pointerId);
    },

    onDrag(event) {
      if (!this.dragging) {
        return;
      }

      const rect = this.$refs.panes?.getBoundingClientRect();

      if (!rect?.width) {
        return;
      }

      this.setSplit((event.clientX - rect.left) / rect.width * 100);
    },

    endDrag(event) {
      this.dragging = false;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    },

    onKeyDown(event) {
      // Off the design's width, the first step needs to know what that width currently is.
      if (this.split == null) {
        this.measureTokenSplit();
      }

      const step = event.shiftKey ? 10 : 2;
      const moves = {
        ArrowLeft:  -step,
        ArrowRight: step,
        Home:       MIN_SPLIT - this.percent,
        End:        MAX_SPLIT - this.percent,
      };

      if (moves[event.key] === undefined) {
        return;
      }

      event.preventDefault();
      this.setSplit(this.percent + moves[event.key]);
    },

    reset() {
      this.split = null;
    },

    setSplit(percent) {
      this.split = clampSplit(percent);
    },

    /**
     * What the panel token's 520px is as a percentage of the panes, right now.
     *
     * Read off the token rather than repeated here, and re-read whenever the panes appear, so
     * the pane the divider takes over from is the pane the design drew. The pane's own width
     * gives half the divider back (`calc(x% - 4px)`), so the percentage has to include it.
     */
    measureTokenSplit() {
      const panes = this.$refs.panes;
      const width = panes?.getBoundingClientRect().width;

      if (!width) {
        return;
      }

      const panel = parseFloat(getComputedStyle(panes).getPropertyValue('--studio-panel-assistant'));

      if (panel) {
        this.tokenSplit = clampSplit((panel + DIVIDER_HALF) / width * 100);
      }
    },

    /**
     * Switch the assistant panel's tab.
     *
     * Entering Changes bumps a revision the tab watches, so it re-reads the working tree
     * rather than showing whatever the diff was the last time it was looked at.
     */
    onLeftTab(tab) {
      this.leftTab = tab;

      if (tab === 'changes') {
        this.changesRevision++;
      }
    },

    /**
     * Send what was typed in the composer to the claude in the pod.
     *
     * Through `askAssistant` rather than through the terminal's own websocket, and that is the
     * fix for a message that looked sent and was not: the websocket wrote the text and the
     * carriage return as one frame, and claude's TUI reads a burst wider than the pane as a
     * paste - so the return landed inside the prompt as a newline and the message sat there
     * unsubmitted while the composer cleared and the panel switched to the terminal, exactly as
     * it does on success. `askAssistant` types the text, waits a second and then sends Return
     * separately, which is what the pane needs, and it queues the message when no session has
     * been opened yet rather than dropping it.
     *
     * The turn is recorded either way, because it is a record of what this composer sent.
     */
    async sendToAssistant(text) {
      this.recordTurn(text);

      try {
        // Stamped with where it came from and who sent it, which is the only way a turn ever
        // gets a name on it: the pod has one shared conversation and no idea which Rancher
        // user is looking at it, so a prompt typed straight into the pane carries nobody. See
        // pod/barn-provenance.mjs.
        const how = await askAssistant(this.extension, text, await originStamp('workspace').catch(() => undefined));

        if (how === 'queued') {
          toastSuccess(
            this.$store,
            'No session is open in this pod yet, so the message is waiting as the first thing the conversation is asked.',
            { title: 'Queued for the assistant' },
          );
        }
      } catch (e) {
        toastError(this.$store, e.message || String(e), { title: 'The message did not reach the assistant' });
      }
    },

    /** Keep what was sent, so the stream still has it after a reload. */
    recordTurn(text) {
      this.turns = [...this.turns, { text, at: Date.now() }].slice(-MAX_TURNS);
      writeTurns(this.extension, this.turns);
    },

    /** How long ago something happened, in the words the design's meta line uses. */
    ago(at) {
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

      return `${ hours } hour${ hours === 1 ? '' : 's' } ago`;
    },

    /**
     * Act on what the screen that sent you here asked for.
     *
     * Two screens push this route with an instruction in the query and, until this existed,
     * nothing read either of them: the navigation happened, so both controls looked like they
     * had worked. `?publish=local` is build-failed's "Try the publish again" and review's
     * publish-after-review; `?brief=1` is the brief screen handing its document over to be the
     * session's first instruction.
     *
     * The query is cleared once it has been acted on, so a reload does not run it a second
     * time - a publish is minutes of work in a shared pod and must not happen twice because
     * somebody pressed F5.
     */
    async handleHandoff() {
      const publish = this.$route.query.publish;
      const brief = this.$route.query.brief;
      const comment = this.$route.query.comment;

      if (!publish && !brief && !comment) {
        return;
      }

      const query = { ...this.$route.query };

      delete query.publish;
      delete query.brief;
      delete query.comment;

      await this.$router.replace({
        name: this.$route.name, params: this.$route.params, query
      }).catch(() => { /* the same route with fewer parameters is not a navigation failure */ });

      if (publish === 'local' || publish === 'github' || publish === 'distribute') {
        this.publishTo(publish);

        return;
      }

      if (brief) {
        this.handBriefOver();

        return;
      }

      if (comment) {
        this.loadComment(String(comment));
      }
    },

    /**
     * A reviewer's comment, arriving as the instruction to work from.
     *
     * Cross-screen rule 11: a rejection from either reviewer lands back in this workspace with
     * the comment already loaded into the assistant, and the reviewer never writes the fix.
     * The id rather than the text in the query, because a review comment is a record with an
     * author and a timestamp, and a URL that carried the words instead would be a second copy
     * of them that nothing could reconcile.
     *
     * Recorded as sent only when it was sent. A comment that could not be delivered stays
     * unsent in the record, so the review screen goes on showing it as outstanding rather than
     * telling the reviewer their words arrived somewhere they did not.
     */
    async loadComment(id) {
      const comment = await readComment(this.extension, id).catch(() => null);

      if (!comment) {
        toastError(
          this.$store,
          'That review comment is no longer in the review record, so there was nothing to hand to the assistant.',
          { title: 'The comment did not arrive' },
        );

        return;
      }

      const where = comment.file ? ` It is about ${ comment.file }${ comment.hunk ? ` around line ${ comment.hunk }` : '' }.` : '';
      const text = `A reviewer looked at this change and asked for something.${ where } Their words: ${ comment.text }. Make that change in the working tree and explain what you did.`;

      this.leftTab = 'terminal';
      this.recordTurn(text);

      try {
        const how = await askAssistant(this.extension, text, await originStamp('review-comment').catch(() => undefined));

        await markCommentSent(this.extension, id, how).catch(() => null);

        toastSuccess(
          this.$store,
          how === 'sent'
            ? `${ comment.name || comment.principal || 'The reviewer' } asked for this and the assistant has it. You still decide what to do with the answer.`
            : 'No session is open in this pod yet, so the reviewer\'s comment is the first thing the conversation will be asked.',
          { title: 'The reviewer\'s comment is loaded' },
        );
      } catch (e) {
        toastError(this.$store, e.message || String(e), { title: 'The comment did not reach the assistant' });
      }
    },

    /**
     * Give the brief to the assistant as the session's first instruction.
     *
     * The file rather than the form: `agree()` on the brief screen writes BRIEF.md and then
     * comes here, so the document is on disk in the pod by the time this runs, and naming the
     * path is both shorter and truer than pasting a copy of it into a terminal prompt.
     */
    async handBriefOver() {
      const brief = await readExtensionFile(this.extension, 'BRIEF.md').catch(() => '');

      if (!brief.trim()) {
        toastError(
          this.$store,
          'The brief was agreed but BRIEF.md could not be read back out of the pod, so nothing was handed to the assistant.',
          { title: 'The brief did not arrive' },
        );

        return;
      }

      const text = 'Read BRIEF.md in this package. It is the brief we agreed for this extension. Tell me how you would build it, in steps, before changing anything.';

      this.leftTab = 'terminal';
      await this.sendToAssistant(text);
    },

    /**
     * Re-read everything this page reads, from the masthead's overflow.
     *
     * The masthead re-reads its own branch and change count; what is left is the page's: is
     * there still an install to run, is the dev server up, and the Changes tab's diff.
     */
    onMastheadRefresh() {
      this.checkInstall();
      this.changesRevision++;

      if (!this.rightUrl) {
        clearTimeout(this.devPollTimer);
        this.waitForDevServer();
      }
    },

    /** Reattach the terminal's websocket to the tmux session, from the session menu. */
    reconnectTerminal() {
      this.$refs.terminal?.reconnect();
      this.leftTab = 'terminal';
    },

    openExtension(name) {
      this.$router.push({ name: this.$route.name, params: { extension: name } });
    },

    /**
     * Settings, from a modal that needed a token it did not have.
     *
     * Two modals send people here and both are mid-task, so settings remembers which one and
     * closing it goes back there. One at a time: the modal that asked is closed first, because
     * two of them open at once is a dialog on top of a dialog and no way back from either.
     */
    openSettingsFrom(from) {
      this.publishingGithub = false;
      this.importing = false;
      this.settingsReturn = from;
      this.showSettings = true;
    },

    closeSettings() {
      const from = this.settingsReturn;

      this.showSettings = false;
      this.settingsReturn = '';

      if (from === 'publish') {
        this.publishingGithub = true;
      } else if (from === 'import') {
        this.importing = true;
      }
    },

    /**
     * What the dropdown's lines do.
     *
     * Import is not a publish and does not go near publishTo: it opens a modal and the work
     * happens afterwards, through the same onCreate every other new extension goes through.
     */
    onPublishSelect(id) {
      if (id === 'import') {
        this.importing = true;

        return;
      }

      if (id === 'remove') {
        this.confirmRemove = true;

        return;
      }

      if (id === 'github') {
        // Not published yet: where to is a question, and the modal asks it.
        this.publishingGithub = true;

        return;
      }

      this.publishTo(id);
    },

    /**
     * What the publish dialog chose, in the order the dialog draws it.
     *
     * Local, then the distribution, then GitHub. The local build and the distribution both run
     * here; GitHub has a question of its own (which repository) that its own modal asks, so it
     * goes last and picking it with something else ends with that modal open over finished
     * work rather than with two long jobs racing each other in one pod.
     */
    async onPublishChosen(targets) {
      this.choosingPublish = false;

      if (targets.includes('local')) {
        const ok = await this.publishTo('local');

        // A failed local build is a reason to stop rather than to go on and push it.
        if (!ok) {
          return;
        }
      }

      // Leaving the gate. It needs no repository question, because a distribution goes to the
      // repository the packet was handed over to, and it has its own refusal in review.ts:
      // `distributeExtension()` opens with `assertGateOpen()`, so the check holds even if a
      // future screen reaches it another way.
      //
      // The dialog only emits destinations it has already established are available, which for
      // the gate means `distributionDestinations()` can perform them AND `distributionGate()`
      // is open. `oci` is in that list and is never available - the pod has no helm, no oras
      // and no chart to build, and no registry is configured - so in practice `repository` is
      // what arrives. It is still matched here, because dropping an id the dialog could emit
      // is how the gate came to be unreachable in the first place.
      const destination = ['repository', 'oci'].find((id) => targets.includes(id));

      if (destination) {
        const ok = await this.publishTo('distribute', destination);

        if (!ok) {
          return;
        }
      }

      if (targets.includes('github')) {
        this.publishingGithub = true;
      }
    },

    /**
     * What the status strip says when it worked.
     *
     * Each target ends in a different fact and the strip has to say which: a local publish
     * names the version this Rancher is now loading, a hand-over names the packet and the pull
     * request that carries it, and a distribution names where it went.
     */
    publishSummary(target, result) {
      if (target === 'github') {
        const pr = result.pr ? `, pull request #${ result.pr.number }` : '';
        const failed = result.prError ? `. The branch is pushed, but the pull request could not be opened: ${ result.prError }` : '';

        return `packet ${ result.n } on ${ result.branch }${ pr }${ failed }`;
      }

      if (target === 'distribute') {
        return `packet ${ result.packet } to ${ result.repo } on ${ result.branch }`;
      }

      return `${ result.plugin } ${ result.version }`;
    },

    /**
     * Publish this extension, one way or the other.
     *
     * Three targets now, and the difference between them is the gate:
     *
     *   `local`      builds in the pod and points this Rancher at the result. Deliberately
     *                ungated, forever - cross-screen rule 2. It reaches exactly the cluster
     *                you are standing in and asks nobody.
     *   `github`     hands the change over for review: it assembles a packet, pushes the
     *                packet's own branch and opens the pull request. Entering the gate. It
     *                needs a brief and something to hand over; it does not need a sign-off,
     *                because this is how you ask for one.
     *   `distribute` puts a reviewed packet where other people can install it. Leaving the
     *                gate, and refused by `assertGateOpen` in review.ts until two different
     *                people have signed the two questions against that packet.
     *
     * The check is not here. A page is where the UI reacts; the load-bearing refusal lives in
     * `distributeExtension` so that no screen, and no future screen, can route around it.
     *
     * The progress the strip counts is the running publish's own: they have different stages,
     * and `total` arrives with each report rather than being read from a constant, so the bar
     * is right for whichever is running without this having to know which.
     */
    async publishTo(target, repo) {
      if (this.publishing) {
        return;
      }

      this.publishing = true;
      this.publishError = '';
      this.published = '';
      this.publishLog = '';

      let run = publishExtension;

      if (target === 'github') {
        run = (name, onProgress) => handOverForReview(name, repo, onProgress);
      } else if (target === 'distribute') {
        // `repo` carries the destination id here, which is what the publish dialog picked.
        run = (name, onProgress) => distributeExtension(name, repo || 'repository', onProgress);
      }

      try {
        const result = await run(this.extension, (stage, label, total) => {
          this.publishStage = stage;
          this.publishLabel = label;
          this.publishTotal = total;
        });

        this.published = this.publishSummary(target, result);
        this.publishLog = result.log;

        // The only moment in the product that can take this snapshot: the tree that has just
        // been proved to build. It is what turns "a way back" from a failure into the design's
        // guaranteed one, and it cannot be taken later, because by then something has broken.
        //
        // Only after the local publish. That is the one that compiles the package; a hand-over
        // and a distribution are pushes, and they prove nothing about whether the tree builds.
        if (target === 'local') {
          recordWorkingBuild(this.extension, result.version);
        }

        return true;
      } catch (e) {
        this.publishError = e.message || String(e);
        // PublishError carries the output and the step it died at; anything else is a message.
        this.publishLog = e.log || '';
        this.publishLabel = e.stage || this.publishLabel;

        // The failure is recorded before the status strip reports it, so the screen that
        // explains it has the log even if somebody reloads on the way there. The strip still
        // shows the error inline - this is the longer read, not a replacement for it.
        recordFailure(this.extension, this.publishError, this.publishLog, e.stage || '');

        return false;
      } finally {
        this.publishStage = 0;
        this.publishing = false;
      }
    },

    /**
     * Undo a local publish.
     *
     * Reported on the same strip as a publish, because it is the same question answered the
     * other way: what this Rancher is currently loading. Nothing about the pod changes, so
     * there is no progress to count - it is one delete.
     */
    async removeInstall() {
      this.confirmRemove = false;

      if (this.publishing) {
        return;
      }

      this.publishing = true;
      this.publishError = '';
      this.published = '';
      this.publishLog = '';

      try {
        const plugin = await removeLocalInstall(this.extension);

        this.published = `${ plugin } removed from this Rancher`;
      } catch (e) {
        this.publishError = e.message || String(e);
      } finally {
        this.publishing = false;
      }
    },

    /**
     * The answer to "where to", and the push that follows it.
     *
     * The modal closes on success and stays open on failure, because the thing most likely to
     * be wrong is the repository in the box behind it.
     */
    async onPublishGithub({ repo, done }) {
      const ok = await this.publishTo('github', repo);

      done(ok);

      if (ok) {
        this.publishingGithub = false;
      }
    },

    // A name that is not one of ours yet. What it should start as is a question rather than a
    // default, so this opens the modal instead of creating anything.
    createExtension(name) {
      this.creating = name;
    },

    /**
     * Make it, and stay here.
     *
     * The wait goes on the strip under the actions rather than on a page of its own. Three to
     * ten minutes is a long time to be sent away from the extension you were working on, and
     * that extension goes on working the whole time.
     */
    /** The import modal's half of onCreate: close it, then create like anything else. */
    onImport(event) {
      this.importing = false;

      return this.onCreate(event);
    },

    async onCreate({ name, source, done }) {
      this.creating = '';

      if (!this.starting.includes(name)) {
        this.starting = [...this.starting, name];
      }

      try {
        await ensureExtension(name, source);
        done(true);
      } catch (e) {
        done(false);
        this.starting = this.starting.filter((each) => each !== name);
        this.publishError = e.message || String(e);
      }
    },
  },
};
</script>

<template>
  <div class="mc-editor">
    <!--
      One bar per pane rather than one across the page. Rancher's own header is hidden here
      (see the unscoped block below), and a single bar over two panes would have had to say
      which half each of its words was about. Each bar is the width of the pane under it and
      moves with the divider, so the answer is where it is rather than what it says.
    -->
    <!--
      The masthead from the Extension Studio design: one bar across the top rather than one
      per pane. What was on the right bar - the extension picker, publish - moves here or
      stays beside the pane it is about; the tabs stay in the pane they switch.
    -->
    <!--
      The masthead is the whole top of the page now. The bar that used to sit under it held
      the tabs (which the assistant panel owns), the pop-out (which the preview panel owns)
      and these three, which come in as slots.
    -->
    <EditorMasthead
      :extension="extension"
      :publish-options="publishOptions"
      :publishing="publishing"
      :publish-stage="publishStage"
      :publish-total="publishTotal"
      :ready="!!rightUrl"
      @back="$router.push({ name: routes.STUDIO_ROUTE })"
      @files="onLeftTab('changes')"
      @publish="choosingPublish = true"
      @publish-select="onPublishSelect"
      @settings="showSettings = true"
      @refresh="onMastheadRefresh"
      @changed="changesRevision++"
    >
      <template #status>
        <PublishStatus
          :stage="publishStage"
          :total="publishTotal"
          :label="publishLabel"
          :error="publishError"
          :log="publishLog"
          :done="published"
        />
        <!--
          The strip says what failed; this is the way to the screen that explains it and offers
          a route out. Only drawn when there is a failure to explain.
        -->
        <SButton
          v-if="publishError"
          variant="ghost"
          size="sm"
          icon="alert"
          @click="$router.push({ name: routes.BUILD_FAILED_ROUTE, params: { extension } })"
        >
          See what went wrong
        </SButton>
      </template>

      <template #picker>
        <ExtensionSelect
          class="mc-editor__bar-select"
          :value="extension"
          @open="openExtension"
          @create="createExtension"
        />
      </template>
    </EditorMasthead>

    <StartingExtensions
      :names="starting"
      @open="openExtension"
      @dismiss="starting = starting.filter((each) => each !== $event)"
    />

    <!--
      A build failure belongs here, not on a route of its own. Every amber recovery arrow on the
      flow map returns into this same workspace box, under a legend saying that every recovery
      route leads back into the product rather than out of it, and the failure itself arrives as
      an assistant turn. Its root is already conditional on there being a failure to show, and it
      reads the record itself, so there is nothing to guard here.
    -->
    <BuildFailure
      class="mc-editor__failure"
      :extension="extension"
      embedded
      @open-tab="onLeftTab"
      @changed="changesRevision++"
      @resolved="publishError = ''"
    />

    <!--
      The checklist stands in for the panes rather than sitting above them. Both panes are
      views of a pod that does not exist yet during an install, so showing them would be
      showing two empty boxes and a spinner beside an explanation of why.
    -->
    <InstallProgress
      v-if="needsInstall === true"
      class="mc-editor__install"
      :extension="extension"
      @done="onInstalled"
    />

    <div
      v-else-if="needsInstall === false"
      ref="panes"
      class="mc-editor__panes"
      :class="{ 'mc-editor__panes--dragging': dragging }"
    >
      <div
        class="mc-editor__pane mc-editor__left"
        :style="paneStyle"
      >
        <!--
          The assistant panel owns the tab strip, the session row and the composer; the three
          views it switches between are passed in, because they are this page's and it should
          not have to know how to build a terminal.

          The terminal is in a slot the panel v-shows rather than v-ifs, for the reason it
          always was: it is a websocket to a tmux session, and unmounting it to look at a file
          would end the conversation in it.
        -->
        <AssistantPanel
          class="mc-editor__left-view"
          :extension="extension"
          :tab="leftTab"
          :session="terminalSession"
          :revision="changesRevision"
          :connected="terminalConnected"
          :turns="streamTurns"
          @update:tab="onLeftTab"
          @send="sendToAssistant"
          @reconnect="reconnectTerminal"
        >
          <template #terminal>
            <PodTerminal
              ref="terminal"
              :extension="extension"
              :session="terminalSession"
              @state="terminalState = $event"
            />
          </template>

          <template #files>
            <ExtensionFiles :extension="extension" />
          </template>

          <template #changes>
            <WorkingChanges
              :extension="extension"
              :revision="changesRevision"
            />
          </template>
        </AssistantPanel>
      </div>
      <div
        class="mc-editor__divider"
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        aria-label="Resize the editor panes"
        :aria-valuenow="Math.round(percent)"
        :aria-valuemin="10"
        :aria-valuemax="90"
        @pointerdown="startDrag"
        @pointermove="onDrag"
        @pointerup="endDrag"
        @pointercancel="endDrag"
        @keydown="onKeyDown"
        @dblclick="reset"
      >
        <span class="mc-editor__grip" />
      </div>
      <!--
        The preview panel owns the iframe and everything above it: back, forward, reload, the
        route, the live dot and the viewport chip. All of that used to be spread between this
        page and the action bar; it belongs with the thing it drives.
      -->
      <PreviewPanel
        class="mc-editor__right"
        :url="rightUrl"
        :extension="extension"
      />
    </div>

    <!--
      Removing the local install is the one thing here that changes the Rancher everybody else
      is looking at, so it asks - and says exactly how much it takes away, which is less than
      the words "remove" suggest.
    -->
    <SModal
      v-if="confirmRemove"
      title="Remove the local install?"
      icon="trash"
      :width="480"
      @close="confirmRemove = false"
    >
      <p class="mc-editor__say">
        This Rancher stops loading <strong>{{ extension }}</strong>: its UIPlugin is deleted and
        the pages it adds go away for everybody signed in here.
      </p>
      <p class="mc-editor__say">
        The extension itself is untouched. Its pod, its files and its history stay exactly as
        they are, and Publish puts it back.
      </p>

      <template #footer>
        <SButton
          variant="neutral"
          @click="confirmRemove = false"
        >
          Cancel
        </SButton>
        <SButton
          variant="danger"
          data-testid="barn-remove-confirm"
          @click="removeInstall"
        >
          Remove it
        </SButton>
      </template>
    </SModal>

    <EditorSettingsModal
      v-if="showSettings"
      @close="closeSettings"
    />

    <PublishModal
      v-if="choosingPublish"
      :extension="extension"
      @close="choosingPublish = false"
      @publish="onPublishChosen"
    />

    <PublishGithubModal
      v-if="publishingGithub"
      :extension="extension"
      @close="publishingGithub = false"
      @publish="onPublishGithub"
      @settings="openSettingsFrom('publish')"
    />

    <ImportExtensionModal
      v-if="importing"
      @close="importing = false"
      @create="onImport"
      @settings="openSettingsFrom('import')"
    />

    <NewExtensionModal
      v-if="creating"
      :name="creating"
      @close="creating = ''"
      @create="onCreate"
    />
  </div>
</template>

<style lang="scss" scoped>
$divider-width: 8px;
// Every control on the action bar is this tall.
$control-height: 30px;
// Rancher's collapsed top-level menu rail: the shell's $app-bar-collapsed-width.
$rancher-rail-width: 70px;

.mc-editor {
  display: flex;
  flex-direction: column;
  // Fill the layout rather than the viewport. `position: fixed` and 100vh, which this used
  // when the page drew no chrome at all, would put the panes over the top-level menu, and
  // that rail is now the way out of here.
  height: 100%;
  background: var(--body-bg, #fff);

  // The extension picker is passed into the masthead as slot content, so it is compiled in
  // this component's scope and these rules still reach it. Its height is pinned to match the
  // masthead's own controls, which the design system sizes rather than this file.
  &__bar-select :deep(.vs__dropdown-toggle) {
    height:     $control-height;
    min-height: $control-height;
  }

  // `.labeled-select` is on the same element and is deliberately part of the selector: the
  // shell sets the padding below through a rule of its own with two classes in it, so a
  // two-class selector here is a tie that its stylesheet wins by loading later. Three classes
  // settles it without an !important that the next person has to argue with.
  &__bar-select.labeled-select {
    // A container above the input for a label there isn't, which made the select taller than
    // the part of it you can click.
    :deep(.labeled-container) {
      display: none;
    }

    :deep(.vs__dropdown-toggle) {
      display:     flex;
      align-items: center;
      padding:     0;
    }

    // The reason the text sat above centre: 8px of padding above it, 7 below, and a -5px
    // margin pulling the whole row up inside a box we had given a fixed height.
    :deep(.vs__selected-options) {
      padding:     0 0 0 8px;
      margin:      0;
      align-items: center;
      min-height:  0;
      flex-wrap:   nowrap;
    }

    :deep(.vs__selected),
    :deep(.vs__search) {
      margin:   0;
      padding:  0;
      position: static;
    }

    :deep(.vs__actions) {
      padding: 0 8px 0 4px;
    }

  }

  // The chevron is not the `.vs__open-indicator` svg - the shell hides that and draws its own in
  // the icon font on `.vs__actions::after`, 32px tall with 8px of padding above it and a 2px
  // upward nudge, all of which was for the padded row this no longer has.
  //
  // The selector carries `.no-label.compact-input` because the shell's does, and its rule has
  // one more class than the version of this that only said `.labeled-select` - which is why
  // that version changed the size and left the offset exactly where it was.
  &__bar-select.labeled-select.no-label.compact-input :deep(.vs__actions)::after {
    height:      auto;
    padding-top: 0;
    margin:      0;
    font-size:   18px;
    line-height: 1;
    top:         0;
  }

  // The right-hand side is a column: the address, then the frame. Not a row above the panes,
  // which is where this started and which pushed the terminal and the divider down by its own
  // height so that neither reached the action bar.
  &__right {
    flex:           1 1 0;
    min-width:      0;
    display:        flex;
    flex-direction: column;
  }

  // The left pane is a box with two views in it rather than one component, so it has to do the
  // filling the component used to do itself.
  &__left {
    display:        flex;
    flex-direction: column;
    min-width:      0;
    overflow:       hidden;
  }

  &__left-view {
    flex:       1 1 auto;
    min-height: 0;
    width:      100%;
  }

  &__install {
    flex:       1 1 auto;
    min-height: 0;
  }

  &__say {
    margin: 0 0 var(--studio-space-12);
    font:   var(--studio-body-13);
    color:  var(--studio-text-secondary);
  }

  // The build failure sits between the masthead and the panes, in the page's own gutter: it is
  // part of the workspace rather than a page of its own, and the panes below it are still the
  // way back into the work.
  &__failure {
    padding: 0 16px 12px;
  }

  &__panes {
    // Fill the page; min-height lets the iframes shrink rather than overflow it.
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    width: 100%;

    // While dragging, the pointer is captured by the divider - but the iframes
    // would still take hover/selection, so switch them off for the duration.
    &--dragging .mc-editor__pane {
      pointer-events: none;
    }
  }

  &__pane {
    flex: 0 0 auto;
    height: 100%;
    border: none;

    &--right {
      flex: 1 1 0;
      width: auto;
    }
  }

  &__divider {
    flex: 0 0 $divider-width;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: col-resize;
    background: transparent;
    // The divider is a hit area; the line itself is drawn by the grip.
    user-select: none;
    touch-action: none;

    &:hover .mc-editor__grip,
    &:focus-visible .mc-editor__grip {
      width: 3px;
      background: var(--primary, #3d98d3);
    }

    &:focus-visible {
      outline: none;
    }
  }

  &__grip {
    width: 1px;
    height: 100%;
    background: var(--border, #dcdee7);
    transition: background 100ms, width 100ms;
  }

}

.mc-editor__panes--dragging .mc-editor__grip {
  width: 3px;
  background: var(--primary, #3d98d3);
}
</style>
