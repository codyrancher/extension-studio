<script>
// The masthead from the Extension Studio design (Figma frame 03, node 9:177).
//
// Built to the design, and honest about which half of it exists. What is real is real because
// the code behind it is: the extension's name, the branch it is on, the cluster the preview
// runs in, whether the working tree has uncommitted changes, and Publish. The rest is drawn to
// the design and says so when pressed - a control that looks finished and silently does
// nothing is worse than one that admits it, because a person cannot tell it apart from a bug
// in something that does work.
//
// Every placeholder goes through toastNotYet, which names the control in the message, so a
// report of one is actionable without a screenshot.
//
// It also carries the three controls that used to live on a bar of their own under it: the
// publish status strip, the extension picker and the settings cog. The design has no such bar
// - it has this masthead and then the two panels - so they come in through slots rather than
// this component knowing what any of them are.
import { SBadge, SChip, SButton } from './ui';
import PublishSplit from './PublishSplit.vue';
import { toastNotYet } from '../toast';
import { listBranches, countChanges, EXT_NS } from '../extensions';

export default {
  name: 'EditorMasthead',

  components: {
    SBadge, SChip, SButton, PublishSplit
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
  },

  emits: ['back', 'publish', 'publish-select', 'files', 'settings'],

  data() {
    return {
      branch:     '',
      changes:    0,
      pollTimer:  null,
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
  },

  watch: {
    extension: 'refresh',
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
    },

    notYet(what) {
      toastNotYet(this.$store, what);
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
    <SBadge :state="state" />

    <!-- Real: the branch the pod's package repository is on. -->
    <SChip v-if="branch" :label="branch" icon="branch" />

    <!-- Real: the cluster the preview is served from. -->
    <SChip :label="`Preview on: ${ previewOn }`" icon="server" />

    <!-- Placeholder: there is no notion of a phase. -->
    <SChip
      label="Iterating"
      icon="refresh"
      tone="info"
      clickable
      @click="notYet('the phase chip')"
    />

    <div class="studio-masthead__grow" />

    <!-- What the last publish did and said, when there was one. -->
    <slot name="status" />

    <!-- Placeholder: nothing snapshots the tree, so there is nothing to have saved. -->
    <SButton
      variant="ghost"
      size="sm"
      icon="clock"
      @click="notYet('snapshots')"
    >
      Snapshots
    </SButton>

    <!-- Placeholder: undo would need those snapshots to exist first. -->
    <SButton
      variant="ghost"
      size="sm"
      icon="undo"
      @click="notYet('undo last change')"
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
      data-testid="barn-publish-button"
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

    <SButton
      variant="ghost"
      size="sm"
      icon="more"
      icon-only
      aria-label="More"
      @click="notYet('the masthead overflow menu')"
    />
  </div>
</template>

<style lang="scss" scoped>
.studio-masthead {
  display:       flex;
  align-items:   center;
  gap:           var(--studio-space-8);
  padding:       var(--studio-space-8) var(--studio-space-16);
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
