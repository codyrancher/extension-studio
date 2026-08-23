<script>
// Where to push, asked at the moment of pushing.
//
// This was a setting once, on the assumption that an extension has a repository the way it has
// a name. It does not: it has one the first time somebody decides it does, and the decision is
// worth seeing again on the next push rather than being applied silently to it.
//
// So the answer is remembered and offered back, and the question is still asked. Blank the
// first time, filled in and one Return away every time after that.
import {
  SModal, SButton, SField, SBanner
} from './ui';
import { readSettings } from '../extensions';

export default {
  name: 'PublishGithubModal',

  components: {
    SModal, SButton, SField, SBanner
  },

  props: {
    /** Which extension is being published, which is whose remembered answer to offer back. */
    extension: {
      type:     String,
      required: true,
    },
  },

  emits: ['close', 'publish', 'settings'],

  data() {
    return {
      repo:     '',
      hasToken: true,
      loading:  true,
      pushing:  false,
    };
  },

  computed: {
    repoInvalid() {
      return !!this.repo && !/^[\w.-]+\/[\w.-]+$/.test(this.repo);
    },

    canPublish() {
      return !!this.repo && !this.repoInvalid && this.hasToken;
    },
  },

  async mounted() {
    // Both halves come from the same Secret: what was pushed to last time, and whether there
    // is a token to push with at all. Failing to read it is the same as having neither.
    const settings = await readSettings(this.extension).catch(() => ({ repo: '', hasToken: false }));

    this.repo = settings.repo;
    this.hasToken = settings.hasToken;
    this.loading = false;
  },

  methods: {
    publish() {
      if (!this.canPublish || this.pushing) {
        return;
      }

      this.pushing = true;

      // The page runs it, because the page owns the status strip the progress goes to. The
      // callback travels with it so this button stays busy until the push is over - which is
      // what AsyncButton's `done` used to be.
      this.$emit('publish', {
        repo: this.repo,
        done: () => {
          this.pushing = false;
        },
      });
    },
  },
};
</script>

<template>
  <SModal
    :title="`Publish ${ extension } to GitHub`"
    icon="github"
    :width="560"
    :busy="pushing"
    @close="$emit('close')"
  >
    <div class="publish-github">
      <SBanner v-if="!loading && !hasToken" type="warning">
        There is no GitHub token yet, and pushing needs one.
        <a href="#" @click.prevent="$emit('settings')">Add one in settings</a>, then come back.
      </SBanner>

      <SField
        v-model="repo"
        label="GitHub repository"
        placeholder="owner/name"
        :disabled="loading || pushing"
        :error="repoInvalid ? 'That has to be owner/name.' : ''"
        input-testid="barn-publish-github-repo"
        @enter="publish"
      />

      <!--
        What this actually does, said before it is done.

        The design for screen 07 calls this destination a pull request, and a reader who took
        that on trust would press this expecting a branch and a review. `publishExtensionToGithub`
        runs `git push <remote> HEAD:refs/heads/main`: it lands on the default branch, with
        nobody's approval, and there is no way back from here. Until that function pushes a
        branch and opens a PR, this is the sentence that keeps the promise honest.
      -->
      <p
        class="publish-github__where"
        data-testid="barn-publish-github-where"
      >
        This pushes straight to <strong>main</strong> in that repository. It does not open a pull
        request, and there is nothing here to undo it with.
      </p>
    </div>

    <template #footer>
      <SButton variant="ghost" :disabled="pushing" @click="$emit('close')">
        Cancel
      </SButton>
      <SButton
        variant="primary"
        icon="upload"
        :loading="pushing"
        :disabled="!canPublish"
        @click="publish"
      >
        Publish
      </SButton>
    </template>
  </SModal>
</template>

<style lang="scss" scoped>
.publish-github {
  display:        flex;
  flex-direction: column;
  gap:            var(--studio-space-12);

  a { color: var(--studio-text-link); }

  &__where {
    margin: 0;
    font:   var(--studio-caption-12);
    color:  var(--studio-text-secondary);
  }
}
</style>
