<script>
// The masthead from the Extension Studio design (Figma frame 03, node 9:177).
//
// Everything on this bar is a reading of something or an action on it: the extension's name,
// the branch it is on, the cluster the preview runs in, whether the last publish failed or the
// working tree has uncommitted changes, what phase the extension is in, the snapshots of its
// tree, the undo of the last edit, Publish, and the overflow list of the other screens about
// this extension.
//
// Two of those are newer than the rest. The badge reads the recorded publish failure, because
// screen 08 is this screen in its failed state and the build state belongs beside the name
// (19:956). And the clock line's first half is true now: while this workspace is open the tree
// is watched and a snapshot is taken when it moves (see AUTO_MIN_MS), so "the workspace
// autosaves" is a description rather than a claim.
//
// The three controls that used to live on a bar of their own under it - the publish status
// strip, the extension picker and the settings cog - come in through slots rather than this
// component knowing what any of them are.
import {
  SChip, SButton, SMenu, SModal, SField
} from './ui';
import PublishSplit from './PublishSplit.vue';
import { toastSuccess, toastError } from '../toast';
import {
  listBranches, countChanges, approvalState, createSnapshot, listSnapshots, restoreSnapshot,
  checkoutBranch, publishedVersion, workingDiff
} from '../extensions';
import {
  FILES_ROUTE, REVIEW_ROUTE, VERIFICATION_ROUTE, BRIEF_ROUTE
} from '../editor-product';
import { readFailure, FAILURE_EVENT } from '../publish-failure';
import { findWayBack, rollBack, rollBackLabel } from '../roll-back';

/** Which screen each line of the overflow menu goes to. */
const OVERFLOW_ROUTES = {
  files:        FILES_ROUTE,
  review:       REVIEW_ROUTE,
  verification: VERIFICATION_ROUTE,
  brief:        BRIEF_ROUTE,
};

/** Snapshot tags are `barn-snap/<epoch ms>`, which is where the exact time comes from. */
function snapshotTakenAt(snapshot) {
  const stamp = parseInt(String(snapshot?.ref || '').split('/').pop(), 10);

  return Number.isFinite(stamp) && stamp > 0 ? stamp : 0;
}

/**
 * The autosave, which is what makes the clock line's first half true (9:202).
 *
 * The design's line says the workspace autosaves and when the last snapshot was. The second
 * half was always a real reading; this is the first: while the workspace is open, the tree is
 * watched, and a snapshot is taken when it has moved. Not on a clock - a timer that snapshots
 * a tree nobody touched fills the menu with identical points - and never oftener than
 * AUTO_MIN_MS, counted from the newest snapshot in the pod rather than from this tab's own
 * last one, so two open tabs do not each take one of the same tree.
 *
 * Snapshots are cheap and non-destructive: a commit object built from a scratch index and a
 * tag pointing at it (see createSnapshot). Nothing about the working tree, the index or the
 * branch changes, which is what makes taking one in the background acceptable at all.
 */
const AUTO_MIN_MS = 3 * 60 * 1000;

/** A stable, cheap fingerprint of the working diff. Only equality is ever asked of it. */
function fingerprint(text) {
  let hash = 0;

  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }

  return `${ hash }:${ text.length }`;
}

/** A default name for a snapshot: the time it was taken, which is the one fact about it. */
function defaultSnapshotLabel() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');

  return `${ pad(now.getHours()) }:${ pad(now.getMinutes()) } on ${ now.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) }`;
}

export default {
  name: 'EditorMasthead',

  components: {
    SChip, SButton, SMenu, SModal, SField, PublishSplit
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

  emits: ['back', 'publish', 'publish-select', 'files', 'refresh', 'changed'],

  data() {
    return {
      branch:    '',
      branches:  [],
      changes:   0,
      // The version this Rancher is currently loading, for the phase chip's "since v0.1.0".
      version:   '',
      // Re-read on a timer so "Snapshot saved 12s ago" counts up rather than freezing.
      now:       Date.now(),
      nowTimer:  null,
      // Whether the working tree has been counted even once. Until it has, "no changes" would
      // be a claim about a number nobody has read - and the chip would say the tree was clean
      // for the second before the count came back, on a tree that is not.
      read:      false,
      pollTimer: null,
      // The working tree as the autosave last saw it, and whether it has been seen at all.
      // Null until the first read: the first look establishes what "unchanged" means, and a
      // snapshot taken on it would be a snapshot of something nobody did while watching.
      autoPrint: null,
      autoTaking: false,
      // Why the last automatic snapshot did not happen, when one did not. Said out loud rather
      // than swallowed: the line beside it claims the workspace autosaves, and a pod whose
      // repository git will not write to is exactly where that claim would quietly stop being
      // true - which is the failure `createSnapshot` was just made strict to expose.
      autoError: '',
      // Where the preview runs and what else there is, read rather than asserted.
      /**
       * Where the tree would go back to, resolved only while there is a failure to go back
       * from (19:959).
       *
       * Read rather than assumed, because the button has to say where it goes: the design's
       * label is "Roll back to last working build" and printing that over a pod whose only
       * point is a hand-made snapshot would be the button lying. `findWayBack` answers with
       * the best point that exists and what it is worth; null means the pod has no history
       * at all and there is nothing to offer.
       */
      wayBack:   null,
      rollingBack: false,
      // The recorded publish failure for this extension, when there is one. The badge is the
      // design's Failed state (19:956) and the record is where that fact lives, so the bar
      // reads it rather than being told about it by whoever ran the publish.
      failure:   null,
      // The snapshots of this extension's tree, newest first, and whether they have been read
      // even once - "no snapshots yet" and "not asked yet" are different things to say.
      snapshots:      [],
      snapshotsRead:  false,
      // The name being typed for a new snapshot, while the dialog asking for it is open.
      naming:      false,
      snapLabel:   '',
      // The snapshot the confirm dialog is about, or null.
      restoring:   null,
      // One at a time: all four of these shell into the pod.
      busy:        false,
    };
  },

  computed: {
    /**
     * What the roll back says it does, from roll-back.ts so the masthead and the failure panel
     * print the same phrase for the same point.
     */
    rollBackLabel() {
      return rollBackLabel(this.wayBack);
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

      // Nothing, when there is nothing to say.
      //
      // Two labels have gone from here. "Iterating · N change sets to review" was the third
      // place on one screen carrying the same number, and "No changes" was a badge announcing
      // the absence of news - a green tick on a masthead for the state every extension is in
      // most of the time, which is exactly when a person is not looking for a status.
      //
      // What is left is the three states nothing else reports and that do not last: the pod
      // coming up, the extension being read, and a publish running. The chip is present when
      // one of those is true and absent otherwise, so its being there means something.
      return null;
    },

    /**
     * The design's "Snapshot saved 12s ago", from the newest snapshot there is.
     *
     * Manual, and the readout does not pretend otherwise: nothing in this product autosaves, so
     * this reports when somebody last took one rather than implying a timer. The exact moment
     * comes off the tag - snapshots are tagged `barn-snap/<epoch ms>` - so it can count in
     * seconds, which git's own relative date cannot.
     */
    lastSnapshot() {
      if (!this.snapshotsRead) {
        return { label: 'Reading the snapshots', title: '' };
      }

      const at = snapshotTakenAt(this.snapshots[0]);

      if (!at) {
        if (this.autoError) {
          return {
            label: 'Autosave failed · no snapshot yet',
            title: `The tree has changed and it could not be snapshotted, so there is still nothing to go back to: ${ this.autoError }`,
          };
        }

        return {
          label: 'No snapshot yet',
          title: 'Nothing has been snapshotted in this pod yet. While this workspace is open the tree is watched and one is taken automatically when it changes; you can also take one from this menu at any time.',
        };
      }

      const secs = Math.max(0, Math.round((this.now - at) / 1000));
      let when = `${ secs }s ago`;

      if (secs >= 3600) {
        when = `${ Math.round(secs / 3600) }h ago`;
      } else if (secs >= 60) {
        when = `${ Math.round(secs / 60) }m ago`;
      }

      if (this.autoError) {
        return {
          label: `Autosave failed · last snapshot ${ when }`,
          title: `The tree has changed and it could not be snapshotted, so nothing since "${ this.snapshots[0].label }" is kept: ${ this.autoError }`,
        };
      }

      return {
        label: `Snapshot saved ${ when }`,
        title: `"${ this.snapshots[0].label }" - the newest snapshot in this pod. While this workspace is open the tree is watched and one is taken automatically when it changes, at most every ${ Math.round(AUTO_MIN_MS / 60000) } minutes; the Studio also takes one before anything that could lose work, and this menu takes one on demand.`,
      };
    },

    /**
     * The branch menu: every branch in the pod's repository, the current one marked.
     *
     * A switch is a real `git checkout` in the pod, so it is the one chip on this bar that
     * changes something. Uncommitted work blocks it and git says so; the toast passes that on
     * rather than swallowing it, because a branch that silently did not change is worse than a
     * refusal.
     */
    branchItems() {
      if (!this.branches.length) {
        return [{
          id: 'none', label: this.read ? 'No branches yet' : 'Reading the branches', disabled: true,
        }];
      }

      return this.branches.map((name) => ({
        id:    `switch:${ name }`,
        label: name,
        icon:  name === this.branch ? 'check' : 'branch',
        note:  name === this.branch ? 'current' : '',
      }));
    },

    overflowItems() {
      return [
        { id: 'files', label: 'Files and history', icon: 'file' },
        { id: 'review', label: 'Review changes', icon: 'compare' },
        { id: 'verification', label: 'Verification', icon: 'check' },
        { id: 'brief', label: 'The brief', icon: 'book' },
        { divider: true },
        {
          id: 'snapshot', label: 'Take a snapshot', icon: 'clock', note: this.lastSnapshot.label,
        },
        // The snapshots themselves, so restoring one is still reachable now that the menu it
        // used to live in is gone. Capped: the kebab is a menu about the extension, not a
        // history browser, and the newest few are the ones anybody goes back to.
        ...this.snapshots.slice(0, 5).map((snap) => ({
          id: `restore:${ snap.ref }`, label: snap.label, note: snap.when, icon: 'undo',
        })),
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
      this.failure = readFailure(this.extension);
      this.wayBack = null;
      this.readWayBack();
      this.autoPrint = null;
      this.read = false;
      this.branches = [];
      this.version = '';
      this.snapshots = [];
      this.snapshotsRead = false;
      this.refresh();
    },
  },

  async mounted() {
    this.failure = readFailure(this.extension);
    this.readWayBack();
    // A publish fails under a masthead that is already on screen, and sessionStorage has no
    // change event within the tab that wrote it, so the record announces itself.
    window.addEventListener(FAILURE_EVENT, this.onFailureChanged);

    await this.refresh();
    this.pollTimer = setInterval(() => this.refresh(), 60000);
    this.nowTimer = setInterval(() => {
      this.now = Date.now();
    }, 1000);
  },

  beforeUnmount() {
    clearInterval(this.pollTimer);
    clearInterval(this.nowTimer);
    window.removeEventListener(FAILURE_EVENT, this.onFailureChanged);
  },

  methods: {
    async refresh() {
      // Real: the pod's package is a git repository, so this is the branch it is actually on.
      const branches = await listBranches(this.extension).catch(() => null);

      this.branch = branches?.current || '';
      this.branches = branches?.branches || [];
      // Change sets waiting for review, the same number the Changes tab shows.
      //
      // This was `countChanges`, a `git status` line count of the working tree against the
      // baseline. Two problems with it now: it counted files rather than change sets, so the
      // bar said "Review 1 change" beside a tab badge reading 10; and it measured the working
      // tree, which after a turn is clean, so it counted almost nothing. Publishing is now
      // gated on review, so the number next to Publish should be the size of the queue that
      // gate is watching.
      const approval = await approvalState(this.extension).catch(() => null);

      this.changes = approval
        ? approval.pending.length
        : await countChanges(this.extension).catch(() => 0);
      this.version = await publishedVersion(this.extension).catch(() => '');
      this.read = true;
      // The bar carries "Snapshot saved Ns ago", so the snapshots are no longer only the
      // menu's business - they have to be read before anybody opens it.
      await this.loadSnapshots();
      await this.autoSnapshot();
    },

    /**
     * Snapshot the tree if it has moved since the last look. See AUTO_MIN_MS.
     *
     * The whole working diff is read and fingerprinted rather than the change count compared:
     * a count does not move when a line is edited in place, which is most of what editing is,
     * and an autosave that missed those would be worse than none.
     */
    async autoSnapshot() {
      if (this.autoTaking || this.busy) {
        return;
      }

      const asked = this.extension;
      const diff = await workingDiff(asked).catch(() => null);

      if (diff === null || asked !== this.extension) {
        return;
      }

      const print = fingerprint(diff);

      // The first read is the reference point, not a change.
      if (this.autoPrint === null) {
        this.autoPrint = print;

        return;
      }

      if (print === this.autoPrint) {
        return;
      }

      // Counted from the newest snapshot in the pod, whoever took it: a second tab, or a
      // snapshot taken by hand a moment ago, is already a point to come back to.
      if (Date.now() - snapshotTakenAt(this.snapshots[0]) < AUTO_MIN_MS) {
        return;
      }

      this.autoTaking = true;

      try {
        await createSnapshot(asked, `autosave ${ defaultSnapshotLabel() }`);
        this.autoPrint = print;
        this.autoError = '';
        await this.loadSnapshots();
      } catch (e) {
        // Not a toast - nothing here was asked for by a person, and a toast every minute on a
        // pod whose git is unwritable would be worse than the fault. It goes on the readout
        // instead, which is the thing that would otherwise be claiming an autosave happened.
        // `autoPrint` is deliberately not advanced, so the next poll tries the same tree again.
        this.autoError = e?.message || String(e);
      } finally {
        this.autoTaking = false;
      }
    },

    /**
     * Re-read the snapshots.
     *
     * On opening the menu rather than on a timer: it is another exec into the pod, and the
     * list only changes when somebody on this page changes it.
     */
    /** Just the branches, for the menu: the rest of `refresh` is not worth an exec on a click. */
    async loadBranches() {
      const branches = await listBranches(this.extension).catch(() => null);

      this.branch = branches?.current || this.branch;
      this.branches = branches?.branches || this.branches;
    },

    async loadSnapshots() {
      this.snapshots = await listSnapshots(this.extension).catch(() => []);
      this.snapshotsRead = true;
    },

    /**
     * Switch the pod's repository to another branch.
     *
     * The one control on this bar that writes: `git checkout` in the pod, and then a re-read,
     * because the change count and the working tree belong to whichever branch is out.
     */
    async onBranchSelect(id) {
      if (this.busy || !id.startsWith('switch:')) {
        return;
      }

      const branch = id.slice('switch:'.length);

      if (branch === this.branch) {
        return;
      }

      this.busy = true;

      try {
        const out = await checkoutBranch(this.extension, branch);

        await this.refresh();

        if (this.branch === branch) {
          toastSuccess(this.$store, `The pod's package is on ${ branch }. The preview rebuilds from whatever is on it.`, { title: 'Branch switched' });
          this.$emit('changed');
        } else {
          // git refuses a checkout that would lose uncommitted work, and its reason is the
          // useful part - a chip that quietly stayed on the old branch would not be.
          toastError(this.$store, out.trim().split('\n').slice(0, 4).join(' ') || `git would not switch to ${ branch }.`, { title: 'Still on ' + this.branch });
        }
      } catch (e) {
        toastError(this.$store, e.message || String(e));
      } finally {
        this.busy = false;
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
     * Where "back" is, resolved only when there is a failure.
     *
     * Four reads into the pod, so not on the minute poll and not on a screen with nothing
     * wrong: a workspace whose last publish worked has no roll back drawn and therefore
     * nothing to resolve.
     */
    async readWayBack() {
      const asked = this.extension;

      if (!this.failure) {
        this.wayBack = null;

        return;
      }

      const found = await findWayBack(asked).catch(() => null);

      if (asked === this.extension) {
        this.wayBack = found?.target || null;
      }
    },

    /**
     * The design's masthead roll back (19:959), which is the same action as the failure
     * panel's (19:786) because it is the same function.
     *
     * Everything about it - resolving the point, snapshotting the failed tree first and
     * refusing to go on if that snapshot cannot be taken, restoring, and clearing the failure
     * record - lives in roll-back.ts, so the two affordances cannot drift into two behaviours.
     * This end only says what happened and re-reads the bar.
     */
    async rollBackNow() {
      if (this.rollingBack) {
        return;
      }

      this.rollingBack = true;

      try {
        const done = await rollBack(this.extension, this.wayBack);

        if (done.ok) {
          toastSuccess(this.$store, done.message, { title: done.title });
        } else {
          toastError(this.$store, done.message, { title: done.title });
        }

        this.$emit('changed');
      } finally {
        this.rollingBack = false;
        this.snapshotsRead = false;
        await this.refresh();
        await this.readWayBack();
      }
    },

    /** The failure was recorded, dismissed or rolled back somewhere else on the page. */
    onFailureChanged() {
      this.failure = readFailure(this.extension);
      this.readWayBack();
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

      // Where the snapshot menu's own "Take one now" went. The dialog is unchanged; only the
      // way in moved, now that the action bar no longer carries a snapshot control.
      if (id === 'snapshot') {
        this.snapLabel = defaultSnapshotLabel();
        this.naming = true;

        return;
      }

      // Destructive, so this opens the confirm dialog rather than doing it - the same rule the
      // snapshot menu had before it was removed.
      if (id.startsWith('restore:')) {
        const ref = id.slice('restore:'.length);

        this.restoring = this.snapshots.find((snap) => snap.ref === ref) || null;

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
      :icon-size="16"
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

    <!--
      The state badge was here - "Unsaved" when the working tree had anything uncommitted.
      Taken out: every turn now ends in a commit, so the tree is almost never uncommitted and
      the badge said "Unsaved" about a moment that lasts as long as the assistant is typing.
      What is actually outstanding is the review queue, and the Changes tab counts that.
    -->

    <!--
      The branch switcher used to sit here, between the state badge and the preview target.
      Taken out of the action bar: switching branch is not something anybody does in the middle
      of a change, and it sat beside "See what changed" reading like part of that flow. Its
      machinery is untouched below - `branch`, `branchItems`, `loadBranches`, `onBranchSelect` -
      so putting it back is putting the menu back, and the Files screen still shows and switches
      the branch, which is where somebody looking for it would go.
    -->

    <!--
      "Preview on: local" (16:511) was here. Taken out: extension pods are only ever created in
      the local cluster, so it was a chip that could not say anything else.
    -->

    <!--
      Real: which of the four states the extension is in. Informational rather than clickable -
      it is a reading, and there is nothing to press it for.
    -->
    <SChip
      v-if="phase"
      :label="phase.label"
      :icon="phase.icon"
      :tone="phase.tone"
      data-testid="barn-phase-chip"
    />

    <div class="studio-masthead__grow" />

    <!-- What the last publish did and said, when there was one. -->
    <slot name="status" />

    <!--
      The snapshot reading used to sit here, as a menu whose trigger read "Snapshot saved 12s
      ago" (9:202). Taken out of the action bar on request. The snapshots themselves are
      untouched - the tree is still watched and one is still taken when it moves, and the
      failure panel's roll back still depends on them - so what went is the readout and the
      way in, not the safety net. Taking one by hand and restoring one both moved into the
      overflow menu, because a recovery path with no way to reach it is not a recovery path.
    -->

    <!--
      Real, and only while there is something to go back from (19:959). The same action as the
      failure panel's roll back, because both call roll-back.ts: the failed tree is snapshotted
      first and nothing is restored if that snapshot cannot be taken. The label names the point
      that was actually found rather than promising "the last working build" over a pod whose
      only point is a snapshot somebody took.
    -->
    <SButton
      v-if="failure && wayBack"
      variant="secondary"
      size="sm"
      icon="undo"
      :loading="rollingBack"
      :title="wayBack.note"
      data-testid="barn-rollback-masthead"
      @click="rollBackNow"
    >
      {{ rollBackLabel }}
    </SButton>

    <!--
      Undo was here: it put the most recently edited file back to its last committed state.
      Taken out. Every turn now ends in a commit and the Changes tab can reject a change set,
      which reverts a whole turn with a commit of its own rather than one file to a state
      nobody chose - so this was the one control on the bar that undid something the review
      flow could not see.
    -->

    <!--
      "Review N change sets" was here, opening the Changes tab. Taken out with the strip in the
      composer that said the same thing: the count is on the Changes tab's own badge, the phase
      chip a few centimetres to the left already reports it, and Publish now refuses while
      anything is unreviewed - so the bar states the queue twice and offers a third way to a
      tab that is always visible.
    -->

    <!--
      The extension picker sat here, between "See what changed" and Publish. Taken out: it was a
      dropdown of every extension in the Studio in the middle of a bar about *this* one, and the
      four controls either side of it all act on the extension already open. The slot stays, so
      putting it back is filling it again, and the Studio's own list is still how somebody moves
      between extensions.
    -->
    <slot name="picker" />

    <!-- Real: the existing split button, unchanged. -->
    <PublishSplit
      class="studio-masthead__publish"
      label="Publish"
      icon="rocket"
      aria-label-trigger="Other ways to publish"
      :items="publishOptions"
      :disabled="publishing"
      @click="$emit('publish')"
      @select="$emit('publish-select', $event)"
    />

    <!--
      The gear that used to sit here is gone, and its absence is the point. It opened the bare
      token modal from the toolbar, with nothing in flight and nothing to lose - which is the
      surface the redesign replaces with a settings page, and the only caller of that modal that
      could not justify itself. The other three (screen 02's connect, the publish dialog's "add a
      token", screen 12's PR chip) all open it mid-task with typed state that a navigation would
      destroy, so they keep it. Settings now lives at /barn/settings, reachable from the header
      kebab on every Studio screen.
    -->

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
  // The bar now carries the phase chip's change count, the branch menu and the snapshot time
  // as well as everything it did before, which is more than a narrow window fits. Wrapping is
  // the safety valve: at the design's width it changes nothing, and below it the controls go
  // onto a second row rather than off the end of the page where they cannot be reached.
  flex-wrap:     wrap;
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

  // A chip used as a menu trigger: the chip draws the box, so the button adds only the hit
  // area around it.
  &__chip-menu :deep(.s-menu__trigger) {
    padding: 2px var(--studio-space-4);
    gap:     var(--studio-space-4);
  }

  &__saved {
    font:        var(--studio-caption-12);
    white-space: nowrap;
  }

  // The snapshot menu sits in a row of ghost buttons, so its trigger is one of them.
  &__menu :deep(.s-menu__trigger) {
    box-sizing: border-box;
    min-height: var(--studio-control-sm, 30px);
    height:     var(--studio-control-sm, 30px);
    padding:    0 var(--studio-space-8);
    // The file's autosave group (9:202, layout_AL77CD) is a 13px glyph and a Caption/12
    // reading 6px apart. It was a 16px glyph 4px from its label.
    gap:     var(--studio-space-6);
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
  // No height override here on purpose. Both halves are now drawn to the file's Button metrics
  // (5px 11px, Heading/14 SemiBold), which comes out at 30px on its own; pinning a height on
  // top of that is what would put it out of line again the next time the type ramp moves.
}
</style>
