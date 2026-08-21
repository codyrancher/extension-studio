<script>
// What the editor is configured with, which is currently the two things publishing to GitHub
// needs and cannot work out for itself.
//
// The token is write-only from here. It is stored in a Secret rather than this browser (see
// SETTINGS_SECRET) because the thing that eventually spends it is a pod, and it never comes
// back out: the field says whether one is set and offers to replace it, which is the whole of
// what a settings form has to know. Showing a saved credential back to the page would put it
// in the DOM of a tab somebody leaves open on a shared screen, and buys nothing - nobody
// reads a token to check it, they replace it.
import {
  SModal, SButton, SField, SBanner
} from './ui';
import { readSettings, saveSettings } from '../extensions';

export default {
  name: 'EditorSettingsModal',

  components: {
    SModal, SButton, SField, SBanner
  },

  emits: ['close', 'saved'],

  data() {
    return {
      // '' means "left alone" and is not written; see save below. Clearing one is the Remove
      // link, because a blank field cannot mean both "keep" and "delete".
      token:    '',
      hasToken: false,
      loading:  true,
      error:    '',
      // Set by the Clear button, which is the only way to remove a token: a blank field means
      // "keep", so it cannot also mean "delete".
      clearToken: false,
      // The primary button's own spinner, which AsyncButton used to own.
      saving:     false,
    };
  },

  computed: {
    tokenPlaceholder() {
      return this.hasToken ? 'Stored. Leave blank to keep it.' : 'ghp_...';
    },

  },

  async mounted() {
    try {
      // Any extension will do: the token is the one setting left here and it is the same for
      // all of them. The repository moved to the point of publishing, where it is asked.
      this.hasToken = (await readSettings('')).hasToken;
    } catch (e) {
      this.error = e?.message || String(e);
    } finally {
      this.loading = false;
    }
  },

  methods: {
    async save() {
      this.saving = true;

      try {
        await saveSettings('', {
          // undefined rather than '' when it was left alone, because '' is the deliberate clear.
          token: this.clearToken ? '' : (this.token || undefined),
        });
        this.$emit('saved');
        this.$emit('close');
      } catch (e) {
        this.error = e?.message || String(e);
      } finally {
        this.saving = false;
      }
    },
  },
};
</script>

<template>
  <SModal
    title="Editor settings"
    icon="gear"
    :width="560"
    :busy="saving"
    @close="$emit('close')"
  >
    <div class="editor-settings">
      <SBanner v-if="error" type="error" :message="error" />

      <p class="editor-settings__intro">
        Used to import and publish extensions to GitHub.
      </p>

      <SField
        v-model="token"
        label="GitHub token"
        type="password"
        :placeholder="tokenPlaceholder"
        :disabled="loading || clearToken"
      />

      <p v-if="hasToken" class="editor-settings__hint">
        One is stored; typing here replaces it.
        <a href="#" @click.prevent="clearToken = !clearToken">{{ clearToken ? 'Keep it' : 'Remove it' }}</a>
      </p>

      <SBanner
        v-if="clearToken"
        type="warning"
        message="The stored token will be removed when you save."
      />
    </div>

    <template #footer>
      <SButton variant="ghost" @click="$emit('close')">
        Cancel
      </SButton>
      <SButton
        variant="primary"
        :loading="saving"
        :disabled="loading"
        @click="save"
      >
        Save
      </SButton>
    </template>
  </SModal>
</template>

<style lang="scss" scoped>
.editor-settings {
  display:        flex;
  flex-direction: column;
  gap:            var(--studio-space-12);

  &__intro {
    font:   var(--studio-body-13);
    color:  var(--studio-text-secondary);
    margin: 0;
  }

  &__hint {
    font:   var(--studio-caption-12);
    color:  var(--studio-text-tertiary);
    margin: 0;

    a { color: var(--studio-text-link); }
  }
}
</style>
