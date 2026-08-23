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
//
// This dialog used to say the opposite of that last part: that because the token is never read
// back, Studio could not show which account it belonged to. That was true of the build that
// wrote it and is not true now. `githubIdentity()` puts the question from an extension pod - the
// pod can read the Secret, the browser cannot - and answers with the login, the scopes and the
// expiry, so the dialog names the account for exactly the same reason the page does. It is asked
// here too rather than only on the page, because this is the surface somebody is looking at when
// an import or a publish has just been refused, and "which account is this?" is the question
// they have.
import {
  SModal, SButton, SField, SBanner, SIcon
} from './ui';
import {
  TokenRejected, connectGithub, disconnectGithub, githubConnected, readStudioSettings,
  asSentence, githubErrorText, connectionSummary, tokenRejected
} from '../studio-settings';
import { githubIdentity } from '../extensions';
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

      // What GitHub says about the stored token right now, asked from a pod. Null until it
      // answers; the refusal is kept rather than swallowed, because "GitHub would not say" and
      // "GitHub says this token is no good" are different facts and this row has to tell them
      // apart - it is often the reason the dialog opened.
      identity:        null,
      identityError:   '',
      identityLoading: false,
    };
  },

  computed: {
    tokenPlaceholder() {
      return this.hasToken ? 'Stored. Type here to replace it.' : 'ghp_...';
    },

    /** What GitHub said a moment ago, or what was recorded when the token was pasted. */
    accountLogin() {
      return this.identity?.login || this.connection?.login || '';
    },

    /** Scopes, expiry and when it was stored, worded the way the settings page words them. */
    connectionDetail() {
      return this.hasToken ? connectionSummary(this.identity, this.connection) : '';
    },

    rejected() {
      return tokenRejected(this.identityError);
    },

    identitySaid() {
      return asSentence(githubErrorText(this.identityError));
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

    // After the dialog is on the screen: this one goes out to GitHub by way of a pod exec and is
    // much the slowest of the three, and the token field must not wait for it.
    await this.readIdentity();
  },

  methods: {
    /**
     * What GitHub says the stored token is, asked from a pod.
     *
     * The browser cannot ask this itself - Studio never reads the credential back into a page,
     * and GitHub's CORS policy would not expose the expiry header to one anyway - so the
     * question is put from a pod, which can read the Secret, and only the answer comes back.
     */
    async readIdentity() {
      this.identity = null;
      this.identityError = '';

      if (!this.hasToken) {
        return;
      }

      this.identityLoading = true;

      try {
        this.identity = await githubIdentity();
      } catch (e) {
        // Flattened and capped: GitHub's 401 body arrives as pretty-printed JSON and this is one
        // line of a dialog.
        this.identityError = String(e?.message || e).replace(/\s+/g, ' ').trim().slice(0, 160);
      } finally {
        this.identityLoading = false;
      }
    },

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

        // The row states what GitHub says about the token that is stored now, not the one that
        // was stored a moment ago.
        await this.readIdentity();
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
        this.identity = null;
        this.identityError = '';
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
        Used to clone repositories when you import one, to push when you publish an extension to
        GitHub, and to open the pull request that records the hand-off. The pods that do all
        three read it, so treat it as a credential Studio shares with anything it runs, and scope
        it to the repositories you want it to touch.
      </p>

      <div v-if="!loading" class="editor-settings__state">
        <SIcon name="github" :size="16" />

        <div class="editor-settings__state-text">
          <p class="editor-settings__state-head" data-testid="barn-settings-account">
            <template v-if="hasToken && accountLogin">
              Connected as {{ accountLogin }}
            </template>
            <template v-else-if="hasToken">
              A GitHub token is stored
            </template>
            <template v-else>
              No GitHub token is stored
            </template>
          </p>
          <p class="editor-settings__state-note" data-testid="barn-settings-detail">
            <template v-if="!hasToken">
              Importing a public repository still works. A private one, and publishing to GitHub,
              do not.
            </template>
            <template v-else>
              <template v-if="connectionDetail">{{ connectionDetail }}.</template>
              <template v-if="identityLoading">
                Asking GitHub whose token this is, from an extension pod.
              </template>
              <template v-else-if="identityError && rejected">
                {{ identitySaid }} Type a replacement below; the one stored now will fail the
                next import or push.
              </template>
              <template v-else-if="identityError">
                {{ identitySaid }} So nothing above was read from GitHub just now; it is what was
                recorded when the token was stored.
              </template>
              <template v-else-if="identity">
                Read from GitHub a moment ago. The question is put from an extension pod, which
                is what can read the Secret; the credential never comes back into this dialog.
              </template>
              <template v-else>
                Stored, and nothing has been asked about it.
              </template>
              Typing below replaces it.
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
