<script>
// The publish dialog from the Studio design (Figma frame 07, node 16:459).
//
// It exists because publishing had no question in front of it. The masthead's primary button ran
// `publishTo('local')` on the press: several minutes of `build-pkg` inside a pod other screens
// are also using, ending in a UIPlugin upserted into the Rancher everybody signed in is looking
// at, with no confirmation, no summary of what was in it and no way to pick anywhere else. Two
// verifiers refused to press it for exactly that reason, which is a fair description of a
// control nobody can safely try.
//
// What is here is what can be read. The changeset is `git status` and `git diff --numstat` in
// the pod, so the file count and the line counts are the tree's own; the version is the one this
// Rancher is currently loading, off the UIPlugin. The destinations are the two the product
// actually has, each stating what it does and whether it can be undone.
//
// What is deliberately NOT here is the rest of what the frame draws: the pre-flight checks
// ("Build succeeds", "No credentials in the diff", "Uses an unstable API"), the sign-off badges,
// the version field and the release summary. Nothing in this product compiles before a publish,
// scans a diff for secrets or analyses a dependency, so every one of those rows would be a tick
// with nothing behind it. A dialog whose job is to tell you what you are about to do is the last
// place to put a reassurance nobody checked.
import {
  SModal, SButton, SIcon, SLabel
} from './ui';
import { changedFiles, publishedVersion } from '../extensions';

/** The two places a publish can go, in the order the design lists them. */
const TARGETS = [
  {
    id:       'local',
    label:    'This Rancher',
    note:     'Builds the package in the pod and points this Rancher at the result. Everybody signed in here gets it on their next page load.',
    undo:     'Reversible: "Remove local install" takes it back off.',
    default:  true,
  },
  {
    id:       'github',
    label:    'GitHub',
    note:     'Commits the package and pushes it to the connected repository. The next screen asks which one, and for a token if there is not one yet.',
    undo:     'Not reversible from here: it pushes to the repository\'s main branch rather than opening a pull request.',
    default:  false,
  },
];

export default {
  name: 'PublishModal',

  components: {
    SModal, SButton, SIcon, SLabel
  },

  props: {
    extension: {
      type:     String,
      required: true,
    },
  },

  emits: ['close', 'publish'],

  data() {
    return {
      chosen:  TARGETS.filter((t) => t.default).map((t) => t.id),
      files:   [],
      version: '',
      // Until the tree has been read, "no changes" would be a claim about a number nobody has
      // asked for - and this dialog exists to say what is in the publish.
      read:    false,
    };
  },

  computed: {
    targets() {
      return TARGETS;
    },

    added() {
      return this.files.reduce((n, f) => n + f.added, 0);
    },

    removed() {
      return this.files.reduce((n, f) => n + f.removed, 0);
    },

    /** The design's "3 files · +128 −4", from the working tree rather than from a caption. */
    summary() {
      if (!this.read) {
        return 'Reading the working tree';
      }

      if (!this.files.length) {
        return this.version
          ? `Nothing has changed since v${ this.version }`
          : 'Nothing has changed since the last commit';
      }

      const n = this.files.length;
      const counts = `+${ this.added } −${ this.removed }`;
      const since = this.version ? ` · since v${ this.version }` : '';

      return `${ n } file${ n === 1 ? '' : 's' } · ${ counts }${ since }`;
    },

    /**
     * The line under it, and the one thing the design asks for that cannot be had.
     *
     * "reviewed by you 2 minutes ago" needs a record of when the change was last reviewed, and
     * nothing writes one. Rather than leave the sentence half-finished, the dialog says what it
     * does know: an uncommitted tree is what gets published, whether or not anybody looked.
     */
    reviewNote() {
      return 'This is the working tree as it stands. Nothing records when it was last reviewed, so this cannot tell you whether it has been.';
    },

    publishLabel() {
      const n = this.chosen.length;

      if (!n) {
        return 'Pick a destination';
      }

      return n === 1 ? 'Publish to 1 place' : `Publish to ${ n } places`;
    },
  },

  async mounted() {
    const [files, version] = await Promise.all([
      changedFiles(this.extension).catch(() => []),
      publishedVersion(this.extension).catch(() => ''),
    ]);

    this.files = files;
    this.version = version;
    this.read = true;
  },

  methods: {
    isChosen(id) {
      return this.chosen.includes(id);
    },

    toggle(id) {
      this.chosen = this.isChosen(id)
        ? this.chosen.filter((each) => each !== id)
        : [...this.chosen, id];
    },

    confirm() {
      if (!this.chosen.length) {
        return;
      }

      // In the order they are drawn, so a publish to both lands in this Rancher before it is
      // handed to the modal that asks about the repository.
      this.$emit('publish', TARGETS.filter((t) => this.isChosen(t.id)).map((t) => t.id));
    },
  },
};
</script>

<template>
  <SModal
    :title="`Publish ${ extension }`"
    icon="rocket"
    :width="620"
    @close="$emit('close')"
  >
    <p class="publish-modal__say">
      Pick every place this should go. Each one is a separate step and says below whether it can
      be undone.
    </p>

    <!-- the changeset (16:770): what is actually in this publish -->
    <div class="publish-modal__changeset">
      <SIcon name="compare" :size="16" />
      <div class="publish-modal__changeset-text">
        <span
          class="publish-modal__changeset-title"
          data-testid="barn-publish-changeset"
        >{{ summary }}</span>
        <span class="publish-modal__changeset-note">{{ reviewNote }}</span>
        <span v-if="files.length" class="publish-modal__files">
          {{ files.map((f) => f.path).join(', ') }}
        </span>
      </div>
    </div>

    <SLabel text="Destinations" />

    <div class="publish-modal__targets">
      <label
        v-for="target in targets"
        :key="target.id"
        class="publish-modal__target"
        :class="{ 'publish-modal__target--on': isChosen(target.id) }"
      >
        <input
          type="checkbox"
          class="publish-modal__box"
          :checked="isChosen(target.id)"
          :data-testid="`barn-publish-target-${ target.id }`"
          @change="toggle(target.id)"
        >
        <span class="publish-modal__target-text">
          <span class="publish-modal__target-label">{{ target.label }}</span>
          <span class="publish-modal__target-note">{{ target.note }}</span>
          <span class="publish-modal__target-undo">{{ target.undo }}</span>
        </span>
      </label>
    </div>

    <template #footer>
      <SButton
        variant="neutral"
        data-testid="barn-publish-cancel"
        @click="$emit('close')"
      >
        Cancel
      </SButton>
      <SButton
        variant="primary"
        icon="rocket"
        :disabled="!chosen.length"
        data-testid="barn-publish-confirm"
        @click="confirm"
      >
        {{ publishLabel }}
      </SButton>
    </template>
  </SModal>
</template>

<style lang="scss" scoped>
.publish-modal {
  &__say {
    margin: 0 0 var(--studio-space-16);
    font:   var(--studio-body-13);
    color:  var(--studio-text-secondary);
  }

  &__changeset {
    display:       flex;
    gap:           10px;
    padding:       10px var(--studio-space-12);
    margin-bottom: var(--studio-space-16);
    background:    var(--studio-surface-subtle);
    border:        1px solid var(--studio-border-subtle);
    border-radius: var(--studio-radius);
    color:         var(--studio-text-secondary);
  }

  &__changeset-text {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-4);
    min-width:      0;
  }

  &__changeset-title {
    font:  var(--studio-heading-14);
    color: var(--studio-text);
  }

  &__changeset-note {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  &__files {
    font:       var(--studio-mono-12);
    color:      var(--studio-text-secondary);
    word-break: break-word;
  }

  &__targets {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-8);
    margin-top:     var(--studio-space-8);
  }

  &__target {
    display:       flex;
    gap:           10px;
    padding:       10px var(--studio-space-12);
    border:        1px solid var(--studio-border);
    border-radius: var(--studio-radius);
    cursor:        pointer;

    &:hover { border-color: var(--studio-border-strong); }

    &--on {
      border-color: var(--studio-border-focus);
      background:   var(--studio-info-bg);
    }
  }

  &__box {
    margin-top: 3px;
    flex:       0 0 auto;
  }

  &__target-text {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-2);
    min-width:      0;
  }

  &__target-label {
    font:  var(--studio-heading-14);
    color: var(--studio-text);
  }

  &__target-note {
    font:  var(--studio-caption-12);
    color: var(--studio-text-secondary);
  }

  &__target-undo {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }
}
</style>
