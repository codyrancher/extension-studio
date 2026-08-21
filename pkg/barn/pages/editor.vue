<script>
// The Editor: two panes filling the page, reached from the flask button in the side menu or
// from the extension box in the header.
//
// Left pane: a terminal in the extension's pod, with claude running in it (see
// components/PodTerminal.vue).
// Right pane: that extension's dev server (see extensions.ts) — the live, hot-reloading
// Rancher the same pod is serving, framed same-origin through the Kubernetes API service
// proxy, which is what makes framing it possible.
//
// So the two panes are two views of one pod: what claude edits on the left is what
// hot-reloads on the right, and which pod that is comes from the route.
//
// Registered in index.ts under the 'plain' parent rather than 'blank'. Blank renders the
// route and nothing else, which meant this page had to carry a Back button to be escapable
// at all. Plain brings the top-level menu, which is the way out; its header bar is hidden
// here (see the unscoped style block at the bottom) because each pane labels itself.
import PodTerminal from '../components/PodTerminal.vue';
import ExtensionSelect from '../components/ExtensionSelect.vue';
import PublishStatus from '../components/PublishStatus.vue';
import ExtensionFiles from '../components/ExtensionFiles.vue';
import NewExtensionModal from '../components/NewExtensionModal.vue';
import EditorSettingsModal from '../components/EditorSettingsModal.vue';
import ImportExtensionModal from '../components/ImportExtensionModal.vue';
import PublishGithubModal from '../components/PublishGithubModal.vue';
import InstallProgress from '../components/InstallProgress.vue';
import EditorMasthead from '../components/EditorMasthead.vue';
import { AssistantPanel, PreviewPanel, WorkingChanges } from '../components/studio';
import StartingExtensions from '../components/StartingExtensions.vue';
import {
  ensureExtension, extensionReady, extensionUrl, publishExtension,
  publishExtensionToGithub, removeLocalInstall, DEFAULT_EXTENSION
} from '../extensions';
import { installState } from '../install';

// How close to an edge the divider can be dragged, in percent of the page.
const MIN_SPLIT = 10;
const MAX_SPLIT = 90;
const DEFAULT_SPLIT = 50;

// Where the divider position is remembered between visits. It's stored as a
// percentage, so the panes keep their proportions when the window is a
// different size next time.
const SPLIT_KEY = 'barn.editor.split';

function clampSplit(percent) {
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, percent));
}

function readSplit() {
  try {
    const stored = parseFloat(window.localStorage.getItem(SPLIT_KEY));

    return isNaN(stored) ? DEFAULT_SPLIT : clampSplit(stored);
  } catch {
    // Storage can be unavailable (private mode, blocked cookies) — not fatal.
    return DEFAULT_SPLIT;
  }
}

function writeSplit(percent) {
  try {
    window.localStorage.setItem(SPLIT_KEY, String(percent));
  } catch { /* see readSplit */ }
}

// How often to re-ask the dev server whether it's up. Its first boot is an
// install and a full dashboard compile, so this is a wait of minutes, not
// seconds, and there's nothing to gain from asking faster.
const DEV_POLL_MS = 5000;

export default {
  name: 'BarnEditor',

  components: {
    PodTerminal, ExtensionSelect, ExtensionFiles, NewExtensionModal, StartingExtensions,
    PublishStatus, EditorSettingsModal, ImportExtensionModal, PublishGithubModal,
    InstallProgress, EditorMasthead, AssistantPanel, PreviewPanel, WorkingChanges
  },

  data() {
    return {
      rightUrl: '',
      // Width of the left pane, as a percentage of the page.
      split:    readSplit(),
      dragging: false,
      // Bookkeeping for the dev server poll, so it stops with the page.
      unmounted:    false,
      devPollTimer: null,
      // Which of the assistant panel's four views is showing. The terminal stays mounted
      // whichever it is (see the template): it is a live session, and unmounting it to look at
      // a file would end whatever claude was in the middle of.
      leftTab: 'assistant',
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
      // Which modal sent us to settings, so closing settings can put that one back rather than
      // dropping somebody where they did not start. '' when settings was opened from the cog.
      settingsReturn: '',
      // One publish at a time. AsyncButton used to refuse a second press by itself; a split
      // button has two ways in, so the refusal has to be here instead.
      publishing: false,
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
    };
  },

  computed: {
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

  },

  watch: {
    // Switching extensions is switching pods: the right pane has to go back to waiting rather
    // than keep framing the one that is no longer being edited. The terminal on the left
    // re-connects on its own, because `extension` is a prop of it.
    extension() {
      this.needsInstall = undefined;
      this.checkInstall();
      this.rightUrl = '';
      // The poll from the extension being left is still in its sleep. Waking it early is not
      // the point - waitForDevServer checks whose it is - but leaving a timer behind for the
      // page to clear later is untidy when a new one is about to replace it.
      clearTimeout(this.devPollTimer);
      this.waitForDevServer();
    },

    // Persist the divider position, but not on every pointermove — the final
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
  },

  mounted() {
    this.checkInstall();
    // The terminal brings itself up (it waits on the pod, not on the dev
    // server), so nothing here has to wait for the left pane.
    this.waitForDevServer();

    // What the page needs from the template it is under, and cannot ask for from inside its
    // own scope: see the unscoped style block at the bottom. The class goes on <html> rather
    // than on <body>, which was the first attempt and silently did nothing - the shell owns
    // body's class list (theme-light, overflow-hidden, dashboard-body) and rewrites it whole
    // on navigation, so a class added there survives until the next route change and no
    // longer.
    document.documentElement.classList.add('barn-editor-page');
  },

  beforeUnmount() {
    this.unmounted = true;
    clearTimeout(this.devPollTimer);
    document.documentElement.classList.remove('barn-editor-page');
  },

  methods: {
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
      // an iframe — without it the iframe's document swallows them.
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
      const step = event.shiftKey ? 10 : 2;
      const moves = {
        ArrowLeft:  -step,
        ArrowRight: step,
        Home:       MIN_SPLIT - this.split,
        End:        MAX_SPLIT - this.split,
      };

      if (moves[event.key] === undefined) {
        return;
      }

      event.preventDefault();
      this.setSplit(this.split + moves[event.key]);
    },

    reset() {
      this.split = DEFAULT_SPLIT;
    },

    setSplit(percent) {
      this.split = clampSplit(percent);
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
     * Real, and the same thing as typing it into the terminal: the panel has already switched
     * to the terminal by the time this runs, so the reply arrives somewhere visible.
     */
    sendToAssistant(text) {
      this.$refs.terminal?.sendText(text);
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
        this.removeInstall();

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
     * Publish this extension, one way or the other.
     *
     * `local` builds it in the pod and points this Rancher at the result, which reaches exactly
     * the cluster you are standing in. `github` pushes the package's source to the configured
     * repository, which is the half that outlives this cluster. Both are minutes rather than
     * seconds and both report through the same status strip, so they share this.
     *
     * The progress the strip counts is the running publish's own: the two have different
     * stages, and `total` arrives with each report rather than being read from a constant, so
     * the bar is right for whichever is running without this having to know which.
     */
    async publishTo(target, repo) {
      if (this.publishing) {
        return;
      }

      this.publishing = true;
      this.publishError = '';
      this.published = '';
      this.publishLog = '';

      const run = target === 'github'
        ? (name, onProgress) => publishExtensionToGithub(name, repo, onProgress)
        : publishExtension;

      try {
        const result = await run(this.extension, (stage, label, total) => {
          this.publishStage = stage;
          this.publishLabel = label;
          this.publishTotal = total;
        });

        this.published = result.repo
          ? `${ result.plugin } ${ result.version } to ${ result.repo }`
          : `${ result.plugin } ${ result.version }`;
        this.publishLog = result.log;

        return true;
      } catch (e) {
        this.publishError = e.message || String(e);
        // PublishError carries the output and the step it died at; anything else is a message.
        this.publishLog = e.log || '';
        this.publishLabel = e.stage || this.publishLabel;

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
      @back="$router.push({ name: 'home' })"
      @files="onLeftTab('changes')"
      @publish="publishTo('local')"
      @publish-select="onPublishSelect"
      @settings="showSettings = true"
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
        :style="{ width: `calc(${ split }% - 4px)` }"
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
          :connected="terminalConnected"
          @update:tab="onLeftTab"
          @send="sendToAssistant"
        >
          <template #terminal>
            <PodTerminal
              ref="terminal"
              :extension="extension"
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
        :aria-valuenow="Math.round(split)"
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

    <EditorSettingsModal
      v-if="showSettings"
      @close="closeSettings"
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

  &__panes {
    // Fill the page; min-height lets the iframes shrink rather than overflow it.
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    width: 100%;

    // While dragging, the pointer is captured by the divider — but the iframes
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

<style lang="scss">
  // Unscoped, and it has to be: everything below belongs to the shell's 'plain' template, so
  // nothing this page renders is inside the scope that would reach it. All of it is keyed on
  // a class the page puts on <html> while it is mounted (see mounted()), so no other page
  // under the same template is affected.
  html.barn-editor-page {
    // The header bar goes, the top-level menu stays. They are one element in the shell -
    // TopLevelMenu is the first child of <header> - so this cannot be `display: none`. The
    // grid row is collapsed by zeroing the variable that sizes it, the element is allowed to
    // overflow what is left, and everything in it except the menu is hidden.
    //
    // Which leaves the way out of this page intact: the rail is fixed-positioned, so it is
    // still where it always is once the row it nominally lives in is gone.
    // Through `body` rather than on the element itself: the themes declare this on `:root`,
    // which is this same element, and a class on it is no more specific than they are. One
    // step down settles it without an !important.
    body {
      --header-height: 0px;
    }

    header[data-testid="header"] {
      border:     none;
      background: none;
      overflow:   visible;
      // Zeroing the grid row is not enough on its own. The element keeps its own 55px height,
      // so it goes on overlapping the page under it, and an invisible 55px band across the top
      // swallowed every click on the bars below - which is how this was found.
      height:         0;
      min-height:     0;
      pointer-events: none;

      > *:not(:first-child) {
        display: none;
      }

      // The rail is the exception, because it is the one part of the header that stays.
      > :first-child {
        pointer-events: auto;
      }
    }

    .main-layout > .indented-panel {
      width:       100%;
      margin:      0;
      padding-top: 0 !important;
    }
  }
</style>
