<script>
// What the editor is configured with, which is currently the one thing publishing to GitHub
// needs and cannot work out for itself.
//
// The token is write-only from here. It is stored in a Secret rather than this browser (see
// SETTINGS_SECRET) because the thing that eventually spends it is a pod, and it never comes
// back out: the field says whether one is set and offers to replace it, which is the whole of
// what a settings form has to know. Showing a saved credential back to the page would put it
// in the DOM of a tab somebody leaves open on a shared screen, and buys nothing - nobody
// reads a token to check it, they replace it.
//
// The corollary is that this surface cannot name the account, its scopes or its expiry, and
// says so rather than leaving a blank where the design draws them. All three would mean
// reading the credential back and spending it against api.github.com from the browser, which
// is the thing the Secret exists to avoid.
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
      // '' means "left alone" and is not written; see save below. Removing one is Disconnect,
      // which does it there and then, because a blank field cannot mean both "keep" and
      // "delete" and a destructive action behind a second button is a destructive action
      // people perform by accident.
      token:    '',
      hasToken: false,
      loading:  true,
      error:    '',
      removed:  false,
      // The primary button's own spinner, which AsyncButton used to own.
      saving:        false,
      disconnecting: false,
    };
  },

  computed: {
    tokenPlaceholder() {
      return this.hasToken ? 'Stored. Leave blank to keep it.' : 'ghp_...';
    },
  },

  watch: {
    /** "Removed" is about what is stored, and typing a replacement is no longer about that. */
    token(value) {
      if (value) {
        this.removed = false;
      }
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
    /**
     * Remove the credential, now, on one click.
     *
     * Not armed-and-saved. Everything else on this form is a value being replaced, where
     * changing your mind means closing without saving; this is the one action with nothing to
     * replace it with, and leaving it pending meant the state on screen disagreed with the
     * state in the cluster until somebody pressed a second button.
     */
    async disconnect() {
      if (this.disconnecting || !this.hasToken) {
        return;
      }

      this.disconnecting = true;
      this.error = '';

      try {
        await saveSettings('', { token: '' });
        this.hasToken = false;
        this.token = '';
        this.removed = true;
        this.$emit('saved');
      } catch (e) {
        this.error = e?.message || String(e);
      } finally {
        this.disconnecting = false;
      }
    },

    async save() {
      // undefined rather than '' when the field was left alone, because '' is the deliberate
      // clear and Disconnect owns that. Whitespace counts as left alone for the same reason:
      // a stray space must not read as "delete the credential".
      const token = this.token.trim() || undefined;

      this.saving = true;

      try {
        await saveSettings('', { token });
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
    :busy="saving || disconnecting"
    @close="$emit('close')"
  >
    <div class="editor-settings">
      <SBanner v-if="error" type="error" :message="error" />

      <p class="editor-settings__intro">
        Used to clone repositories when you import one, and to push when you publish an
        extension to GitHub. The pods that do both read it, so treat it as a credential Studio
        shares with anything it runs, and scope it to the repositories you want it to touch.
      </p>

      <div v-if="!loading" class="editor-settings__state">
        <div class="editor-settings__state-text">
          <p class="editor-settings__state-head">
            {{ hasToken ? 'A GitHub token is stored' : 'No GitHub token is stored' }}
          </p>
          <p class="editor-settings__state-note">
            <template v-if="hasToken">
              It is never read back into this page, so Studio cannot show which account it
              belongs to, what it may do, or when it expires. Typing one below replaces it.
            </template>
            <template v-else>
              Importing a public repository still works. A private one, and publishing to
              GitHub, do not.
            </template>
          </p>
        </div>

        <SButton
          v-if="hasToken"
          variant="ghost"
          data-testid="barn-settings-disconnect"
          :loading="disconnecting"
          @click="disconnect"
        >
          Disconnect
        </SButton>
      </div>

      <SBanner
        v-if="removed"
        type="info"
        message="The stored token was removed."
      />

      <SField
        v-model="token"
        class="editor-settings__token"
        data-testid="barn-settings-token"
        label="GitHub token"
        type="password"
        :placeholder="tokenPlaceholder"
        :disabled="loading || disconnecting"
        @enter="save"
      />

      <p class="editor-settings__hint">
        Needs the <code>repo</code> scope only.
        <a
          href="https://github.com/settings/tokens/new?scopes=repo&amp;description=Rancher%20Extension%20Studio"
          target="_blank"
          rel="noopener noreferrer"
        >Create one on GitHub with the scope pre-selected</a>. It is stored in a Secret in this
        Rancher rather than in your browser, which also means it is shared with everyone using
        this Rancher's Studio rather than held per user.
      </p>
    </div>

    <template #footer>
      <SButton variant="ghost" :disabled="saving || disconnecting" @click="$emit('close')">
        Cancel
      </SButton>
      <SButton
        variant="primary"
        data-testid="barn-settings-save"
        :loading="saving"
        :disabled="loading || disconnecting || !token.trim()"
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

  &__state {
    display:       flex;
    align-items:   center;
    gap:           var(--studio-space-12);
    padding:       var(--studio-space-12);
    background:    var(--studio-surface-subtle);
    border:        1px solid var(--studio-border);
    border-radius: var(--studio-radius-control);
  }

  &__state-text {
    flex:     1 1 auto;
    min-width: 0;
  }

  &__state-head {
    font:   var(--studio-body-13-semi);
    color:  var(--studio-text);
    margin: 0;
  }

  &__state-note {
    font:   var(--studio-caption-12);
    color:  var(--studio-text-secondary);
    margin: var(--studio-space-2) 0 0;
  }

  // The design sets a pasted token in a monospace face, which is the right one for a string
  // nobody reads as words and everybody scans for a prefix.
  &__token :deep(.s-field__input) {
    font: var(--studio-mono-12);
  }

  &__hint {
    font:   var(--studio-caption-12);
    color:  var(--studio-text-tertiary);
    margin: 0;

    a { color: var(--studio-text-link); }

    code { font: var(--studio-mono-11); }
  }
}
</style>
