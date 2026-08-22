<script>
// The masthead from the Extension Studio design (Figma frame 03, node 9:177).
//
// Everything on this bar is a reading of something or an action on it: the extension's name,
// the branch it is on, the cluster the preview runs in, whether the working tree has
// uncommitted changes, what phase the extension is in, the snapshots of its tree, the undo of
// the last edit, Publish, and the overflow list of the other screens about this extension.
//
// The three controls that used to live on a bar of their own under it - the publish status
// strip, the extension picker and the settings cog - come in through slots rather than this
// component knowing what any of them are.
import { SBadge, SChip, SButton, SMenu, SModal, SField } from './ui';
import PublishSplit from './PublishSplit.vue';
import { toastSuccess, toastError } from '../toast';
import {
  listBranches, countChanges, createSnapshot, listSnapshots, restoreSnapshot, undoLastChange, EXT_NS
} from '../extensions';
import {
  FILES_ROUTE, REVIEW_ROUTE, VERIFICATION_ROUTE, BRIEF_ROUTE
} from '../editor-product';

/** Which screen each line of the overflow menu goes to. */
const OVERFLOW_ROUTES = {
  files:        FILES_ROUTE,
  review:       REVIEW_ROUTE,
  verification: VERIFICATION_ROUTE,
  brief:        BRIEF_ROUTE,
};

/** A default name for a snapshot: the time it was taken, which is the one fact about it. */
function defaultSnapshotLabel() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');

  return `${ pad(now.getHours()) }:${ pad(now.getMinutes()) } on ${ now.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) }`;
}

export default {
  name: 'EditorMasthead',

  components: {
    SBadge, SChip, SButton, SMenu, SModal, SField, PublishSplit
  },

  props: {
    extension: {
      type:     String,
      required: true,
    },

    /** Passed through to the publish button, which is the one action here that is wired. */
    publishOptions: {
      type:    Array,
      default: () => [],
    },

    publishing: {
      type:    Boolean,
      default: false,
    },

    /** Which step of the running publish the page is on, for the phase chip. */
    publishStage: {
      type:    Number,
      default: 0,
    },

    publishTotal: {
      type:    Number,
      default: 0,
    },

    /** Whether the pod's dev server is answering, which is the page's own poll. */
    ready: {
      type:    Boolean,
      default: false,
    },
  },

  emits: ['back', 'publish', 'publish-select', 'files', 'settings', 'refresh', 'changed'],

  data() {
    return {
      branch:    '',
      changes:   0,
      // Whether the working tree has been counted even once. Until it has, "no changes" would
      // be a claim about a number nobody has read - and the chip would say the tree was clean
      // for the second before the count came back, on a tree that is not.
      read:      false,
      pollTimer: null,
      // The snapshots of this extension's tree, newest first, and whether they have been read
      // even once - "no snapshots yet" and "not asked yet" are different things to say.
      snapshots:      [],
      snapshotsRead:  false,
      // The name being typed for a new snapshot, while the dialog asking for it is open.
      naming:      false,
      snapLabel:   '',
      // The snapshot the confirm dialog is about, or null.
      restoring:   null,
      // One at a time: all three of these shell into the pod.
      busy:        false,
    };
  },

  computed: {
    // The design shows "Preview on: local". It is `local` for the same reason EXT_CLUSTER is:
    // the pod runs in the cluster this extension is installed into.
    previewOn() {
      return 'local';
    },

    namespace() {
      return EXT_NS;
    },

    // Real, now that the working tree is counted: the design's badge says Unsaved when there
    // is something uncommitted and Live when there is not.
    state() {
      return this.changes > 0 ? 'unsaved' : 'live';
    },

    /**
     * What the extension is doing, in the order the answers matter.
     *
     * Not a workflow phase - there is no workflow - but the four states the page can actually
     * distinguish: the pod is not serving yet, a publish is running, the tree has been edited
     * since its last commit, or it has not. Read rather than set, so it cannot say Iterating
     * about a pod that has not booted.
     */
    phase() {
      if (!this.ready) {
        return {
          label: 'Starting the pod', icon: 'clock', tone: 'warning'
        };
      }

      if (!this.read) {
        return { label: 'Reading the extension', icon: 'clock' };
      }

      if (this.publishing) {
        const of = this.publishTotal ? ` ${ this.publishStage }/${ this.publishTotal }` : '';

        return {
          label: `Publishing${ of }`, icon: 'rocket', tone: 'info'
        };
      }

      if (this.changes > 0) {
        return {
          label: 'Iterating', icon: 'refresh', tone: 'info'
        };
      }

      return {
        label: 'No changes', icon: 'check', tone: 'success'
      };
    },

    /**
     * The snapshot menu: take one at the top, then the ones there are.
     *
     * Each snapshot's own line restores it, which is destructive, so choosing one opens the
     * confirm dialog rather than doing it.
     */
    snapshotItems() {
      const items = [{ id: 'take', label: 'Take a snapshot', icon: 'save' }, { divider: true }];

      if (!this.snapshots.length) {
        items.push({
          id: 'none', label: this.snapshotsRead ? 'No snapshots yet' : 'Reading the snapshots', disabled: true
        });

        return items;
      }

      items.push({ id: 'head', label: 'Restore the tree to', disabled: true });

      this.snapshots.forEach((snap) => {
        items.push({
          id: `restore:${ snap.ref }`, label: snap.label, note: snap.when, icon: 'undo'
        });
      });

      return items;
    },

    /** The other screens about this extension, plus the two things that are not a screen. */
    overflowItems() {
      return [
        { id: 'files', label: 'Files and history', icon: 'file' },
        { id: 'review', label: 'Review changes', icon: 'compare' },
        { id: 'verification', label: 'Verification', icon: 'check' },
        { id: 'brief', label: 'The brief', icon: 'book' },
        { divider: true },
        { id: 'refresh', label: 'Re-read this extension', icon: 'refresh' },
        { divider: true },
        {
          id: 'remove', label: 'Remove the local install', icon: 'trash', danger: true
        },
      ];
    },
  },

  watch: {
    extension() {
      // A different pod: what is on screen is the last one's until this one has been read.
      this.read = false;
      this.snapshots = [];
      this.snapshotsRead = false;
      this.refresh();
    },
  },

  async mounted() {
    await this.refresh();
    this.pollTimer = setInterval(() => this.refresh(), 60000);
  },

  beforeUnmount() {
    clearInterval(this.pollTimer);
  },

  methods: {
    async refresh() {
      // Real: the pod's package is a git repository, so this is the branch it is actually on.
      const branches = await listBranches(this.extension).catch(() => null);

      this.branch = branches?.current || '';
      this.changes = await countChanges(this.extension).catch(() => 0);
      this.read = true;
    },

    /**
     * Re-read the snapshots.
     *
     * On opening the menu rather than on a timer: it is another exec into the pod, and the
     * list only changes when somebody on this page changes it.
     */
    async loadSnapshots() {
      this.snapshots = await listSnapshots(this.extension).catch(() => []);
      this.snapshotsRead = true;
    },

    onSnapshotSelect(id) {
      if (id === 'take') {
        this.snapLabel = defaultSnapshotLabel();
        this.naming = true;

        return;
      }

      if (id.startsWith('restore:')) {
        const ref = id.slice('restore:'.length);

        this.restoring = this.snapshots.find((snap) => snap.ref === ref) || null;
      }
    },

    async takeSnapshot() {
      if (this.busy) {
        return;
      }

      const label = this.snapLabel.trim() || defaultSnapshotLabel();

      this.busy = true;

      try {
        const sha = await createSnapshot(this.extension, label);

        this.naming = false;
        toastSuccess(this.$store, `"${ label }" holds the working tree as it is now (${ sha.slice(0, 7) }).`, { title: 'Snapshot taken' });
        await this.loadSnapshots();
      } catch (e) {
        toastError(this.$store, e.message || String(e));
      } finally {
        this.busy = false;
      }
    },

    async doRestore() {
      if (this.busy || !this.restoring) {
        return;
      }

      const snap = this.restoring;

      this.busy = true;

      try {
        await restoreSnapshot(this.extension, snap.ref);
        this.restoring = null;
        toastSuccess(this.$store, `The files in "${ snap.label }" are back as they were. Anything created since is still there.`, { title: 'Snapshot restored' });
        await this.refresh();
        this.$emit('changed');
      } catch (e) {
        toastError(this.$store, e.message || String(e));
      } finally {
        this.busy = false;
      }
    },

    /**
     * Put the most recently edited file back, or delete it if the assistant created it.
     *
     * One file, not the tree: that is what undoLastChange does, and the toast names the file
     * so it is never a mystery which one moved.
     */
    async undo() {
      if (this.busy) {
        return;
      }

      this.busy = true;

      try {
        const path = await undoLastChange(this.extension);

        if (!path) {
          toastSuccess(
            this.$store,
            'Nothing has changed since the last commit, so there was nothing to put back.',
            { title: 'Nothing to undo' },
          );
        } else {
          // Neither "restored" nor "deleted": undoLastChange does whichever the file needed
          // and does not say which, and guessing wrong in the toast is worse than not saying.
          toastSuccess(this.$store, `The last change to ${ path } has been undone.`, { title: 'Undone' });
          this.$emit('changed');
        }

        await this.refresh();
      } catch (e) {
        toastError(this.$store, e.message || String(e));
      } finally {
        this.busy = false;
      }
    },

    onOverflow(id) {
      const route = OVERFLOW_ROUTES[id];

      if (route) {
        this.$router.push({ name: route, params: { extension: this.extension } });

        return;
      }

      if (id === 'refresh') {
        this.refresh();
        this.loadSnapshots();
        this.$emit('refresh');

        return;
      }

      if (id === 'remove') {
        // The page owns this one: it asks first, and reports on the same strip a publish does.
        this.$emit('publish-select', 'remove');
      }
    },
  },
};
</script>

<template>
  <div class="studio-masthead">
    <!-- Real: leaves the editor the way every other page does. -->
    <SButton
      variant="ghost"
      size="sm"
      icon="chevronLeft"
      icon-only
      aria-label="Back"
      @click="$emit('back')"
    />

    <div class="studio-masthead__name">
      <div class="studio-masthead__title">
        {{ extension }}
      </div>
      <div class="studio-masthead__eyebrow">
        Extension Studio
      </div>
    </div>

    <!-- Real: whether the pod's working tree has anything uncommitted in it. -->
    <SBadge :status="state" />

    <!-- Real: the branch the pod's package repository is on. -->
    <SChip v-if="branch" :label="branch" icon="branch" />

    <!-- Real: the cluster the preview is served from. -->
    <SChip :label="`Preview on: ${ previewOn }`" icon="server" />

    <!--
      Real: which of the four states the extension is in. Informational rather than clickable -
      it is a reading, and there is nothing to press it for.
    -->
    <SChip
      :label="phase.label"
      :icon="phase.icon"
      :tone="phase.tone"
      data-testid="barn-phase-chip"
    />

    <div class="studio-masthead__grow" />

    <!-- What the last publish did and said, when there was one. -->
    <slot name="status" />

    <!-- Real: a snapshot is a commit object holding the whole tree, tagged so it survives. -->
    <SMenu
      class="studio-masthead__menu"
      :items="snapshotItems"
      icon="clock"
      label="Snapshots"
      aria-label="Snapshots"
      data-testid="barn-snapshots-menu"
      @open="loadSnapshots"
      @select="onSnapshotSelect"
    />

    <!-- Real: puts the most recently edited file back to its last committed state. -->
    <SButton
      variant="ghost"
      size="sm"
      icon="undo"
      :loading="busy"
      data-testid="barn-undo-button"
      @click="undo"
    >
      Undo
    </SButton>

    <!-- Real: the Changes tab shows a diff of the working tree against its history. -->
    <SButton
      variant="secondary"
      size="sm"
      icon="compare"
      @click="$emit('files')"
    >
      See what changed
    </SButton>

    <!-- Which extension this editor is pointed at. -->
    <slot name="picker" />

    <!-- Real: the existing split button, unchanged. -->
    <PublishSplit
      class="studio-masthead__publish"
      label="Publish"
      aria-label-trigger="Other ways to publish"
      :items="publishOptions"
      :disabled="publishing"
      @click="$emit('publish')"
      @select="$emit('publish-select', $event)"
    />

    <!-- Real: what the editor itself is configured with. -->
    <SButton
      variant="ghost"
      size="sm"
      icon="gear"
      icon-only
      aria-label="Editor settings"
      data-testid="barn-editor-settings-button"
      @click="$emit('settings')"
    />

    <!-- Real: the other screens about this extension, and the undo of a local publish. -->
    <SMenu
      :items="overflowItems"
      icon="more"
      aria-label="More"
      data-testid="barn-masthead-overflow"
      @select="onOverflow"
    />

    <!-- Naming a snapshot. The default is the time, which is the one thing known about it. -->
    <SModal
      v-if="naming"
      title="Take a snapshot"
      icon="clock"
      :width="460"
      :busy="busy"
      @close="naming = false"
    >
      <p class="studio-masthead__say">
        A snapshot holds every file in the extension as it is right now, including the ones
        the assistant has just created. It is kept in the pod's git repository and does not
        change what you are working on.
      </p>
      <SField
        v-model="snapLabel"
        label="Name"
        placeholder="What this point is"
        autofocus
        @enter="takeSnapshot"
      />

      <template #footer>
        <SButton
          variant="neutral"
          :disabled="busy"
          @click="naming = false"
        >
          Cancel
        </SButton>
        <SButton
          variant="primary"
          :loading="busy"
          @click="takeSnapshot"
        >
          Take it
        </SButton>
      </template>
    </SModal>

    <!-- Restoring is destructive, and the half it does not do has to be said out loud. -->
    <SModal
      v-if="restoring"
      title="Restore this snapshot?"
      icon="undo"
      :width="480"
      :busy="busy"
      @close="restoring = null"
    >
      <p class="studio-masthead__say">
        Every file <strong>{{ restoring.label }}</strong> holds goes back to how it was
        {{ restoring.when }}. Whatever those files say now is overwritten, and there is no undo
        for it beyond taking a snapshot first.
      </p>
      <p class="studio-masthead__say studio-masthead__say--warn">
        Files created since the snapshot was taken are <strong>not</strong> removed. They are
        not in the snapshot, so restoring it leaves them exactly where they are.
      </p>

      <template #footer>
        <SButton
          variant="neutral"
          :disabled="busy"
          @click="restoring = null"
        >
          Cancel
        </SButton>
        <SButton
          variant="danger"
          :loading="busy"
          data-testid="barn-restore-confirm"
          @click="doRestore"
        >
          Restore the files
        </SButton>
      </template>
    </SModal>
  </div>
</template>

<style lang="scss" scoped>
.studio-masthead {
  display:       flex;
  align-items:   center;
  gap:           var(--studio-space-10);
  padding:       var(--studio-space-10) var(--studio-space-16);
  border-bottom: 1px solid var(--studio-border);
  background:    var(--studio-surface);
  flex:          0 0 auto;

  &__name {
    display:        flex;
    flex-direction: column;
    margin-right:   var(--studio-space-4);
    min-width:      0;
  }

  &__title {
    font:  var(--studio-heading-16);
    color: var(--studio-text);
  }

  &__eyebrow {
    font:           var(--studio-caption-11-caps);
    letter-spacing: var(--studio-tracking-caps);
    text-transform: uppercase;
    color:          var(--studio-text-tertiary);
  }

  &__grow { flex: 1 1 auto; }

  // The snapshot menu sits in a row of ghost buttons, so its trigger is one of them.
  &__menu :deep(.s-menu__trigger) {
    padding: 5px var(--studio-space-8);
    gap:     var(--studio-space-4);
  }

  &__say {
    margin: 0 0 var(--studio-space-12);
    font:   var(--studio-body-13);
    color:  var(--studio-text-secondary);

    &--warn { color: var(--studio-text); }
  }

  // The split button is the shell's, so its height comes from the shell's stylesheet and
  // not from ours. Scoped CSS reaches a child component's root element only, which is why
  // this needs :deep to get at the buttons inside it.
  &__publish {
    :deep(button) {
      height: 30px;
    }
  }
}
</style>
