<script>
// Bring an extension in from a repository.
//
// The sibling of NewExtensionModal, and deliberately the same shape: a name, a question about
// where the contents come from, and a button that hands the work back to the page. What it
// asks for instead of a seed is a repository, and what it produces is the same thing - a
// `source` string that `ensureExtension` knows how to satisfy (`github:owner/repo#branch`).
//
// So the two modals do not share a creation path so much as they share the only one there is:
// the page's onCreate takes whichever of them emitted, and neither knows what the other did.
//
// The GitHub credential is asked for here rather than behind a link to the settings dialog.
// The link was the honest thing when there was nowhere else to put a token, but taking it
// unmounted this modal and threw away everything typed into it, so somebody who discovered
// mid-form that they needed a token paid for it with the form. A token is three lines of state
// and the field that takes it is the same field either way.
import {
  SModal, SButton, SField, SBanner
} from './ui';
import {
  normalizeExtensionName, listExtensions, readSettings, saveSettings, parseGithubRepoInput
} from '../extensions';

export default {
  name: 'ImportExtensionModal',

  components: {
    SModal, SButton, SField, SBanner
  },

  emits: ['close', 'create'],

  data() {
    return {
      name:   '',
      repo:   '',
      branch: '',
      taken:  [],
      error:  '',
      // Whether there is a token. Unlike publishing, this does not stop an import: a public
      // repository clones without one. It only decides what step 1 says.
      hasToken: true,
      importing: false,
      // The token disclosure: closed until somebody asks for it, because most imports are of
      // a public repository and do not need one.
      tokenOpen:   false,
      token:       '',
      savingToken: false,
      // Whether these two have been taken over by hand. Until they are, the repository fills
      // them, which is what makes the name a suggestion rather than a third thing to type.
      nameDirty:   false,
      branchDirty: false,
    };
  },

  computed: {
    // What the repository field means, which is more than what it says: the natural paste is
    // the URL out of the browser bar, and that is a repository too. See parseGithubRepoInput.
    parsed() {
      return parseGithubRepoInput(this.repo);
    },

    repoPath() {
      return this.parsed?.repo || '';
    },

    parsedBranch() {
      return this.parsed?.branch || '';
    },

    repoInvalid() {
      return !!this.repo.trim() && !this.parsed;
    },

    /**
     * What the field made of what is in it, and before anything is, why it is a field.
     *
     * The design picks the repository off a list of the ones you can reach. Nothing here
     * fetches that list, so rather than leave an empty box implying one is coming, the hint
     * says the listing is not there and names the two things the box does take.
     */
    repoHint() {
      if (!this.repo.trim()) {
        return 'Studio does not list your repositories. Name the one you want, or paste its URL.';
      }

      return this.repoPath && this.repoPath !== this.repo.trim() ? `Reads as ${ this.repoPath }.` : '';
    },

    // What the name will actually be. Applied rather than rejected, the same way the header's
    // box does it: somebody typing "My Thing" means an extension, not a validation error.
    normalized() {
      return normalizeExtensionName(this.name);
    },

    nameTaken() {
      return !!this.normalized && this.taken.includes(this.normalized);
    },

    nameHint() {
      if (!this.normalized) {
        return '';
      }

      if (this.normalized !== this.name) {
        return `It will be called ${ this.normalized }.`;
      }

      return this.nameDirty ? '' : 'Taken from the repository. Change it to call it something else here.';
    },

    /**
     * A branch name git will accept, checked here rather than discovered in the clone.
     *
     * There is no listing to pick from - the token lives in a Secret the browser never reads
     * back, so nothing here can ask GitHub what branches exist - but the shapes git refuses
     * outright are knowable without asking anybody, and a typo caught now is a typo not paid
     * for with a three-minute import that ends in `git clone`'s error.
     */
    branchInvalid() {
      const branch = this.branch.trim();

      if (!branch) {
        return false;
      }

      return !/^[\w./-]+$/.test(branch) || /^[./-]|[./]$|\.\.|\.lock$|\/\//.test(branch);
    },

    canImport() {
      return !!this.normalized && !!this.repoPath && !this.nameTaken && !this.branchInvalid;
    },
  },

  watch: {
    /** The design's "taken from the repository": the name is a suggestion, not a prerequisite. */
    repoPath(value) {
      if (!this.nameDirty) {
        this.name = value ? value.split('/')[1] : '';
      }
    },

    /** A pasted `/tree/<branch>` URL brought its branch with it. */
    parsedBranch(value) {
      if (!this.branchDirty) {
        this.branch = value;
      }
    },
  },

  async mounted() {
    this.taken = (await listExtensions().catch(() => [])).map((each) => each.name);
    // Any extension will do - the token is not one of theirs. See repoKey.
    this.hasToken = (await readSettings('').catch(() => ({ hasToken: false }))).hasToken;
  },

  methods: {
    onNameInput(value) {
      this.name = value;
      this.nameDirty = true;
    },

    onBranchInput(value) {
      this.branch = value;
      this.branchDirty = true;
    },

    /**
     * Store the token and stay here.
     *
     * Straight into the same Secret the settings dialog writes, so which surface it was pasted
     * into makes no difference to what is stored or to what spends it.
     */
    async connect() {
      const token = this.token.trim();

      if (!token || this.savingToken) {
        return;
      }

      this.savingToken = true;
      this.error = '';

      try {
        await saveSettings('', { token });
        this.hasToken = true;
        this.tokenOpen = false;
        this.token = '';
      } catch (e) {
        this.error = e?.message || String(e);
      } finally {
        this.savingToken = false;
      }
    },

    create() {
      if (!this.canImport || this.importing) {
        return;
      }

      this.importing = true;

      // The branch rides on the source rather than as a second argument, because everything
      // downstream of here passes one string around and a second one would have to be threaded
      // through all of it to be read in one place.
      const branch = this.branch.trim();
      const source = `github:${ this.repoPath }${ branch ? `#${ branch }` : '' }`;

      this.$emit('create', {
        name: this.normalized,
        source,
        done: () => {
          this.importing = false;
        },
      });
    },
  },
};
</script>

<template>
  <SModal
    title="Import an extension from GitHub"
    icon="github"
    :width="680"
    :busy="importing"
    @close="$emit('close')"
  >
    <div class="import-extension">
      <SBanner v-if="error" type="error" :message="error" />

      <p class="import-extension__lede">
        The repository is cloned into your workspace. Nothing is pushed back until you publish.
      </p>

      <div class="import-extension__connect">
        <p class="import-extension__connect-head">
          {{ hasToken ? 'GitHub connected' : 'Connect GitHub' }}
        </p>

        <p class="import-extension__connect-copy">
          <template v-if="hasToken">
            A token is stored, so a private repository clones too. Studio keeps it in a Secret
            for the pod that runs the clone and never reads it back into this page, so it
            cannot say which account it belongs to.
          </template>
          <template v-else>
            A public repository imports without a token. A private one needs one, and you can
            paste it here without leaving this dialog or losing what you have typed.
          </template>

          <a
            href="#"
            data-testid="barn-import-token-toggle"
            @click.prevent="tokenOpen = !tokenOpen"
          >{{ tokenOpen ? 'Never mind' : (hasToken ? 'Replace it' : 'Paste a personal access token') }}</a>
        </p>

        <div v-if="tokenOpen" class="import-extension__token">
          <SField
            v-model="token"
            class="import-extension__token-field"
            data-testid="barn-import-token-field"
            label="Personal access token"
            type="password"
            placeholder="ghp_..."
            :disabled="savingToken"
            @enter="connect"
          />

          <p class="import-extension__token-help">
            Needs the <code>repo</code> scope only.
            <a
              href="https://github.com/settings/tokens/new?scopes=repo&amp;description=Rancher%20Extension%20Studio"
              target="_blank"
              rel="noopener noreferrer"
            >Create one on GitHub with the scope pre-selected</a>. It is stored in a Secret in
            this Rancher, not in your browser, because the thing that spends it is a pod -
            which also means it is shared with everyone using this Rancher's Studio, not held
            per user.
          </p>

          <SButton
            variant="secondary"
            data-testid="barn-import-token-save"
            :loading="savingToken"
            :disabled="!token.trim()"
            @click="connect"
          >
            Connect
          </SButton>
        </div>
      </div>

      <SField
        v-model="repo"
        data-testid="barn-import-repo"
        label="GitHub repository"
        placeholder="owner/name, or paste the repository URL"
        :disabled="importing"
        :error="repoInvalid ? 'That has to be owner/name, or a github.com repository URL.' : ''"
        :hint="repoHint"
      />

      <SField
        data-testid="barn-import-name"
        label="Name in Studio"
        placeholder="my-extension"
        :model-value="name"
        :disabled="importing"
        :error="nameTaken ? `${ normalized } already exists here.` : ''"
        :hint="nameHint"
        @update:model-value="onNameInput"
      />

      <SField
        data-testid="barn-import-branch"
        label="Branch"
        placeholder="the repository's default"
        :model-value="branch"
        :disabled="importing"
        :error="branchInvalid ? 'That is not a branch name git will accept.' : ''"
        hint="Leave blank for the repository's default."
        @update:model-value="onBranchInput"
        @enter="create"
      />
    </div>

    <template #footer>
      <SButton variant="ghost" :disabled="importing" @click="$emit('close')">
        Cancel
      </SButton>
      <SButton
        variant="primary"
        icon="download"
        data-testid="barn-import-submit"
        :loading="importing"
        :disabled="!canImport"
        @click="create"
      >
        Import
      </SButton>
    </template>
  </SModal>
</template>

<style lang="scss" scoped>
.import-extension {
  display:        flex;
  flex-direction: column;
  gap:            var(--studio-space-12);

  a { color: var(--studio-text-link); }

  &__lede {
    font:   var(--studio-body-13);
    color:  var(--studio-text-secondary);
    margin: 0;
  }

  &__connect {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-8);
    padding:        var(--studio-space-12);
    background:     var(--studio-surface-subtle);
    border:         1px solid var(--studio-border);
    border-radius:  var(--studio-radius-control);
  }

  &__connect-head {
    font:   var(--studio-body-13-semi);
    color:  var(--studio-text);
    margin: 0;
  }

  &__connect-copy {
    font:   var(--studio-caption-12);
    color:  var(--studio-text-secondary);
    margin: 0;
  }

  &__token {
    display:        flex;
    flex-direction: column;
    align-items:    flex-start;
    gap:            var(--studio-space-8);
  }

  // The design sets a pasted token in a monospace face, which is the right one for a string
  // nobody reads as words and everybody scans for a prefix.
  &__token-field :deep(.s-field__input) {
    font: var(--studio-mono-12);
  }

  &__token-help {
    font:   var(--studio-caption-12);
    color:  var(--studio-text-tertiary);
    margin: 0;

    code { font: var(--studio-mono-11); }
  }
}
</style>
