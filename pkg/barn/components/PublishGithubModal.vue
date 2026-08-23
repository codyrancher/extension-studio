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
import { distributionGate } from '../review';

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
      // What the gate knows before the button is drawn. A hand-over needs neither a sign-off
      // nor a brief; the distribution needs both, and this is the same reading.
      gate:     null,
    };
  },

  computed: {
    repoInvalid() {
      return !!this.repo && !/^[\w.-]+\/[\w.-]+$/.test(this.repo);
    },

    /**
     * Whether anybody wrote down what this change is for.
     *
     * Not a precondition of the hand-over: `assemblePacket()` records a missing brief on the
     * packet and in the pull request rather than refusing, because refusing broke a capability
     * that worked. It is a precondition of the *distribution*, which is what `distributionGate()`
     * is answering here, so the warning is worth showing at the moment somebody asks for a
     * review.
     */
    briefMissing() {
      return this.gate?.state === 'no-brief';
    },

    /** The branch this will push. `n` is the next packet: packets are numbered, never reused. */
    branch() {
      return this.gate ? `barn/${ this.extension }/${ this.gate.packet + 1 }` : '';
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

    // Separately, and after the fields are filled in: it is one exec into the pod and the
    // repository box is worth having before it lands.
    this.gate = await distributionGate(this.extension).catch(() => null);
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

      <SBanner
        v-if="briefMissing"
        type="warning"
        data-testid="barn-publish-github-no-brief"
      >
        {{ gate.reason }} The hand-over will go ahead anyway, and the pull request will say plainly
        that no brief was written. What it costs is the outcome sign-off, which has no acceptance
        criteria to walk and no recorded requester until somebody writes one.
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

        Read off the code rather than off the design. `handOverForReview()` assembles the packet,
        calls `publishExtensionToGithub(name, repo, onProgress, packet.branch, packet.sha)` and
        then opens the pull request; the packet's own commit is what is pushed, not HEAD, and
        `publishExtensionToGithub()` now throws when it is given no branch at all, so there is no
        path from this button to the default branch.
      -->
      <p
        class="publish-github__where"
        data-testid="barn-publish-github-where"
      >
        This hands the change over for review. It assembles the work into a packet, pushes that
        packet to a branch of its own
        <template v-if="branch">
          (<strong>{{ branch }}</strong>)
        </template>
        in that repository, and opens a pull request against the default branch. Nothing is
        merged and nothing is written to <strong>main</strong>, so closing the pull request and
        deleting the branch is the way back.
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
