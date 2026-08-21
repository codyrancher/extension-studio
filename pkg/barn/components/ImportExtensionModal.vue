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
import {
  SModal, SButton, SField, SBanner
} from './ui';
import { normalizeExtensionName, listExtensions, readSettings } from '../extensions';

export default {
  name: 'ImportExtensionModal',

  components: {
    SModal, SButton, SField, SBanner
  },

  emits: ['close', 'create', 'settings'],

  data() {
    return {
      name:   '',
      repo:   '',
      branch: '',
      taken:  [],
      error:  '',
      // Whether there is a token. Unlike publishing, this does not stop an import: a public
      // repository clones without one. It only decides whether to say so.
      hasToken: true,
      importing: false,
    };
  },

  computed: {
    // What the name will actually be. Applied rather than rejected, the same way the header's
    // box does it: somebody typing "My Thing" means an extension, not a validation error.
    normalized() {
      return normalizeExtensionName(this.name);
    },

    repoInvalid() {
      return !!this.repo && !/^[\w.-]+\/[\w.-]+$/.test(this.repo);
    },

    nameTaken() {
      return !!this.normalized && this.taken.includes(this.normalized);
    },

    canImport() {
      return !!this.normalized && !!this.repo && !this.repoInvalid && !this.nameTaken;
    },
  },

  async mounted() {
    this.taken = (await listExtensions().catch(() => [])).map((each) => each.name);
    // Any extension will do - the token is not one of theirs. See repoKey.
    this.hasToken = (await readSettings('').catch(() => ({ hasToken: false }))).hasToken;
  },

  methods: {
    create() {
      if (!this.canImport || this.importing) {
        return;
      }

      this.importing = true;

      // The branch rides on the source rather than as a second argument, because everything
      // downstream of here passes one string around and a second one would have to be threaded
      // through all of it to be read in one place.
      const source = `github:${ this.repo }${ this.branch ? `#${ this.branch }` : '' }`;

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
    title="Import from GitHub"
    icon="github"
    :width="620"
    :busy="importing"
    @close="$emit('close')"
  >
    <div class="import-extension">
      <SBanner v-if="error" type="error" :message="error" />

      <SBanner v-if="!hasToken" type="warning">
        There is no GitHub token yet. A public repository imports without one; a private one
        does not. <a href="#" @click.prevent="$emit('settings')">Add one in settings</a>, then
        come back.
      </SBanner>

      <SField
        v-model="name"
        label="Name"
        placeholder="my-extension"
        :disabled="importing"
        :error="nameTaken ? `${ normalized } already exists here.` : ''"
        :hint="!nameTaken && normalized && normalized !== name ? `It will be called ${ normalized }.` : ''"
      />

      <SField
        v-model="repo"
        label="GitHub repository"
        placeholder="owner/name"
        :disabled="importing"
        :error="repoInvalid ? 'That has to be owner/name.' : ''"
      />

      <SField
        v-model="branch"
        label="Branch"
        placeholder="the repository's default"
        :disabled="importing"
        hint="Leave blank to take whatever the repository opens on."
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
}
</style>
