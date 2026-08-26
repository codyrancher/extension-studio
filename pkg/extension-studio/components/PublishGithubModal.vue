<script>
// Where to push, asked at the moment of pushing.
//
// This was a setting once, on the assumption that an extension has a repository the way it has
// a name. It does not: it has one the first time somebody decides it does, and the decision is
// worth seeing again on the next push rather than being applied silently to it.
//
// So the answer is remembered and offered back, and the question is still asked. Blank the
// first time, filled in and one Return away every time after that.
//
// A MISSING TOKEN NO LONGER STOPS THE HAND-OVER, matching the reversal in `handOverForReview()`.
// This dialog used to hold its own button disabled until a GitHub token existed, which made the
// whole bottom lane of the product unreachable in any cluster without one: nothing could be
// handed over, so nothing reached the review queue, so neither sign-off could be given and the
// distribution gate could never be approached. A third party's credential is not what decides
// whether somebody here may ask a colleague to look at their change.
//
// What the hand-over IS, is the packet: a ref, a note and a branch in the pod, plus the entry in
// the review record. Screens 11, 12 and 13 read those two stores and not GitHub. The pull request
// is the hand-off's record where there is a GitHub to record it on, and where there is not, this
// dialog says so before the button is pressed and `pushError` says so on the packet afterwards.
// Neither claims a pull request that does not exist.
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
      // Unknown until the Secret's metadata lands, and every sentence that depends on it is
      // guarded by `loading` so nothing claims a connection this Studio may not have.
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

    /**
     * Whether this hand-over will reach GitHub at all.
     *
     * The same two conditions `handOverForReview()` reads before it assembles anything, in the
     * same order, so what this dialog says will happen is what happens. Everything else about
     * the hand-over - the packet, the branch in the pod, the review record, the queue entry -
     * happens either way.
     */
    willPush() {
      return this.hasToken && !!this.repo && !this.repoInvalid;
    },

    /**
     * The button is held back for one reason only: a repository box with something in it that is
     * not `owner/name`, which is a typo rather than a decision.
     *
     * No token, or no repository with no token, is not a refusal. It is a hand-over that stays in
     * the cluster, and the banner and the paragraph below both say so before it is pressed. A
     * token with no repository still is a refusal, because that is somebody who can push and has
     * not said where.
     */
    canPublish() {
      if (this.loading || this.repoInvalid) {
        return false;
      }

      return this.hasToken ? !!this.repo : true;
    },

    /**
     * Why the repository box may not be doing anything, said under the box.
     *
     * Without a token nothing is pushed, so a repository typed here is a note for next time
     * rather than a destination. A field that quietly has no effect is the kind of small lie
     * this product keeps deleting, so it says so.
     */
    repoHint() {
      if (this.loading || this.hasToken) {
        return '';
      }

      return 'Not used by this hand-over: with no token there is nothing to push with. It is kept for the hand-over after a token is added.';
    },

    /** What the button does, said on the button. */
    confirmLabel() {
      return this.willPush ? 'Publish' : 'Hand over';
    },

    /** The dialog is only "to GitHub" when it is going there. */
    title() {
      return this.willPush
        ? `Publish ${ this.extension } to GitHub`
        : `Hand ${ this.extension } over for review`;
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
    :title="title"
    :icon="willPush ? 'github' : 'branch'"
    :width="560"
    :busy="pushing"
    @close="$emit('close')"
  >
    <div class="publish-github">
      <!--
        Information, not a blocker. The hand-over happens; the pull request does not. Saying
        which is which is the whole job of this banner, and it is why it is `info` rather than
        `warning`: nothing here has gone wrong and nothing is being refused.
      -->
      <SBanner
        v-if="!loading && !hasToken"
        type="info"
        data-testid="barn-publish-github-no-token"
      >
        There is no GitHub token in this Studio, so this hand-over stays in the cluster: the packet
        and its branch are written in the pod, the review record gets the entry, and the change
        appears in the review queue for somebody to sign. No pull request will record it, and the
        packet will say that rather than imply one exists.
        <a href="#" @click.prevent="$emit('settings')">Add a token in settings</a> and hand over
        again to put the record on GitHub too.
      </SBanner>

      <SField
        v-model="repo"
        label="GitHub repository"
        placeholder="owner/name"
        :disabled="loading || pushing"
        :error="repoInvalid ? 'That has to be owner/name.' : ''"
        :hint="repoHint"
        input-testid="barn-publish-github-repo"
        @enter="publish"
      />

      <!--
        What this actually does, said before it is done, and in two versions because it does two
        different things.

        Read off the code rather than off the design. `handOverForReview()` assembles the packet
        first and always. With a token and a repository it then calls
        `publishExtensionToGithub(name, repo, onProgress, packet.branch, packet.sha)` and opens
        the pull request; the packet's own commit is what is pushed, not HEAD, and
        `publishExtensionToGithub()` throws when it is given no branch at all, so there is no path
        from this button to the default branch. Without them it writes the reason onto the packet
        as `pushError` and stops there, with the hand-over itself already done.

        Three states, one test id. Which of the two it does depends on the Secret, and until that
        has been read neither sentence is known to be true - so the loading state says it is
        reading rather than picking one and correcting itself a moment later.
      -->
      <p
        v-if="loading"
        class="publish-github__where"
        data-testid="barn-publish-github-where"
      >
        Reading what this Studio is connected to.
      </p>

      <p
        v-else-if="willPush"
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

      <p
        v-else
        class="publish-github__where"
        data-testid="barn-publish-github-where"
      >
        This hands the change over for review inside this cluster. It assembles the work into a
        packet - a tagged commit, a provenance note and a branch
        <template v-if="branch">
          (<strong>{{ branch }}</strong>)
        </template>
        in the pod - and writes it into the review record, which is what the review queue and the
        two sign-off screens read. Nothing leaves the cluster and no pull request is opened, so
        the way back is to sign off or to hand over again; the packet is numbered and the next
        hand-over makes the next one rather than replacing this one.
      </p>
    </div>

    <template #footer>
      <!--
        Test ids on the two buttons, and on SButton rather than on a wrapper: SButton's root is
        the `<button>` itself, so the attribute reaches the real control. Without them the only
        way to drive this dialog was by button text, and the hand-over is the one destination on
        screen 07 whose effect nobody can see without driving it.
      -->
      <SButton
        variant="ghost"
        :disabled="pushing"
        data-testid="barn-publish-github-cancel"
        @click="$emit('close')"
      >
        Cancel
      </SButton>
      <SButton
        variant="primary"
        :icon="willPush ? 'upload' : 'list'"
        :loading="pushing"
        :disabled="!canPublish"
        data-testid="barn-publish-github-confirm"
        @click="publish"
      >
        {{ confirmLabel }}
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
