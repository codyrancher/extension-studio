<script>
// The GitHub credential, asked for in the middle of whatever needed it.
//
// This used to be the Studio's settings: a dialog titled "Editor settings" holding one token
// field behind a Save button, and the only settings surface in the product. Screen 09's caption
// is "connection, permissions, access and data in one place", and the frame's own note says it
// replaces this dialog - so the settings moved to pages/settings.vue and what is left here is
// not settings at all. It is one credential, asked for where it was found to be missing.
//
// That distinction is the whole design of this file:
//
//   - It does not offer the permission level, the preview target, access or the sign-off
//     policy. Exactly one surface edits those, and it is the page.
//   - It does keep the token, because the four callers open this from inside something - an
//     import, a create, a review that cannot ask the assistant - and the design puts connecting
//     inside those flows rather than sending somebody away and hoping they come back.
//   - It has no Save button, the same as the page: Enter stores, Disconnect removes, and both
//     happen when you do them.
//
// The credential is write-only in both places. It goes into a Secret and never comes back out;
// what comes back is the account GitHub named when it was stored, which is not secret. Both
// halves of that are `studio-settings.ts`, shared with the page so the two cannot drift.
import {
  SModal, SButton, SField, SBanner, SIcon
} from './ui';
import {
  TokenRejected, connectGithub, disconnectGithub, githubConnected, readStudioSettings
} from '../studio-settings';
import { SETTINGS_ROUTE } from '../editor-product';

export default {
  name: 'EditorSettingsModal',

  components: {
    SModal, SButton, SField, SBanner, SIcon
  },

  emits: ['close', 'saved'],

  data() {
    return {
      token:         '',
      hasToken:      false,
      connection:    null,
      loading:       true,
      error:         '',
      storing:       false,
      disconnecting: false,
      removed:       false,
    };
  },

  computed: {
    tokenPlaceholder() {
      return this.hasToken ? 'Stored. Type here to replace it.' : 'ghp_...';
    },
  },

  async mounted() {
    try {
      const [connected, stored] = await Promise.all([githubConnected(), readStudioSettings()]);

      this.hasToken = connected;
      this.connection = stored.github;
    } catch (e) {
      this.error = e?.message || String(e);
    } finally {
      this.loading = false;
    }
  },

  methods: {
    async store() {
      const token = this.token.trim();

      if (!token || this.storing) {
        return;
      }

      this.storing = true;
      this.error = '';
      this.removed = false;

      try {
        const { connection } = await connectGithub(token);

        this.hasToken = true;
        this.connection = connection;
        this.token = '';
        this.$emit('saved');
      } catch (e) {
        this.error = e instanceof TokenRejected ? e.message : (e?.message || String(e));
      } finally {
        this.storing = false;
      }
    },

    /** Clicking away from a pasted token stores it too. Length-guarded; Enter is not. */
    storeOnBlur() {
      if (this.token.trim().length >= 20) {
        this.store();
      }
    },

    async disconnect() {
      if (this.disconnecting || !this.hasToken) {
        return;
      }

      this.disconnecting = true;
      this.error = '';

      try {
        await disconnectGithub();

        this.hasToken = false;
        this.connection = null;
        this.token = '';
        this.removed = true;
        this.$emit('saved');
      } catch (e) {
        this.error = e?.message || String(e);
      } finally {
        this.disconnecting = false;
      }
    },

    openSettings() {
      this.$emit('close');
      this.$router.push({ name: SETTINGS_ROUTE });
    },
  },
};
</script>

<template>
  <SModal
    title="Connect GitHub"
    icon="github"
    :width="560"
    :busy="storing || disconnecting"
    @close="$emit('close')"
  >
    <div class="editor-settings">
      <SBanner v-if="error" type="error" :message="error" />

      <p class="editor-settings__intro">
        Used to clone repositories when you import one, and to push when you publish an extension
        to GitHub. The pods that do both read it, so treat it as a credential Studio shares with
        anything it runs, and scope it to the repositories you want it to touch.
      </p>

      <div v-if="!loading" class="editor-settings__state">
        <SIcon name="github" :size="16" />

        <div class="editor-settings__state-text">
          <p class="editor-settings__state-head">
            <template v-if="hasToken && connection && connection.login">
              Connected as {{ connection.login }}
            </template>
            <template v-else-if="hasToken">
              A GitHub token is stored
            </template>
            <template v-else>
              No GitHub token is stored
            </template>
          </p>
          <p class="editor-settings__state-note">
            <template v-if="hasToken && connection && connection.scopes">
              Scopes: {{ connection.scopes }}. Typing below replaces it.
            </template>
            <template v-else-if="hasToken">
              It is never read back into this page, so Studio cannot show which account it
              belongs to. Typing below replaces it, and records the account at that moment.
            </template>
            <template v-else>
              Importing a public repository still works. A private one, and publishing to GitHub,
              do not.
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
        input-testid="barn-settings-token"
        label="GitHub token"
        type="password"
        :placeholder="tokenPlaceholder"
        :disabled="loading || storing || disconnecting"
        hint="Press Enter to store it. There is no Save button: it is written when you do that."
        @enter="store"
        @blur="storeOnBlur"
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
      <SButton
        variant="ghost"
        icon="gear"
        data-testid="barn-settings-open"
        @click="openSettings"
      >
        All Studio settings
      </SButton>
      <span class="editor-settings__grow" />
      <SButton variant="neutral" :disabled="storing || disconnecting" @click="$emit('close')">
        Close
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
    color:         var(--studio-text-secondary);
  }

  &__state-text {
    flex:      1 1 auto;
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

  &__grow { flex: 1 1 auto; }
}
</style>
