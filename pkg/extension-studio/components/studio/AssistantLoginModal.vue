<script>
// Signing the pod's assistant back in, when its credential has run out.
//
// The credential lives in the pod, not in this browser: one shared login is pulled from a
// Kubernetes Secret before claude starts and pushed back when it refreshes, so an expiry is
// something every pod sees at once. Until now the only way through it was the sentence on the
// status strip - "run /login in the terminal" - which is true and is not a control.
//
// There are two credentials that work, and they are reached differently. A Claude subscription
// is an OAuth round trip through claude.com: `claude setup-token` runs in the pod, prints an
// address, and waits at a prompt for the code that address gives back. An API key is just a
// string, and needs none of that.
//
// Which is why this asks first. The OAuth flow costs a round trip into the pod before it can
// show anything, and this dialog used to start it on open - so somebody who had a key in their
// clipboard sat and watched a pause for a flow they were never going to use. Nothing starts
// until the choice is made, and once it is, the wait has a spinner on it instead of a sentence
// claiming an address is on its way.
import {
  SModal, SButton, SField, SIcon
} from '../ui';
import { setAssistantToken, beginAssistantLogin, completeAssistantLogin } from '../../extensions';

export default {
  name: 'AssistantLoginModal',

  components: {
    SModal, SButton, SField, SIcon
  },

  props: {
    extension: {
      type:     String,
      required: true,
    },
  },

  emits: ['close', 'signed-in'],

  data() {
    return {
      // 'choose' until somebody says which credential they have; then the one they picked.
      mode:     'choose',
      token:    '',
      saving:   false,
      error:    '',
      // The authorise page, once the pod has started the flow and printed it.
      url:      '',
      starting: false,
    };
  },

  computed: {
    /** What is about to happen to what has been typed, said before it is sent. */
    hint() {
      const value = this.token.trim();

      if (!value) {
        return this.mode === 'key'
          ? 'An Anthropic API key.'
          : 'The code from the page above.';
      }

      if (value.startsWith('sk-ant-')) {
        return 'Looks like an API key, and is stored as it is.';
      }

      return this.url
        ? 'Sent back to the waiting sign-in, which exchanges it for a token.'
        : 'Stored as an OAuth token.';
    },
  },

  methods: {
    /**
     * The subscription route: start the flow in the pod and wait for the address it prints.
     *
     * Guarded, because coming back to this screen a second time must not start a second
     * `claude setup-token` - the first one is still sitting at its prompt waiting for a code.
     */
    async useSubscription() {
      this.mode = 'oauth';
      this.error = '';

      if (this.url || this.starting) {
        return;
      }

      this.starting = true;

      try {
        this.url = await beginAssistantLogin(this.extension);
      } catch (e) {
        this.error = e?.message || String(e);
      } finally {
        this.starting = false;
      }
    },

    /** The key route: nothing to start, so this is just the field. */
    useKey() {
      this.mode = 'key';
      this.error = '';
    },

    back() {
      this.mode = 'choose';
      this.error = '';
    },

    async save() {
      const value = this.token.trim();

      if (!value) {
        this.error = 'Paste the token first.';

        return;
      }

      this.saving = true;
      this.error = '';

      try {
        // The code from the authorise page goes back to the waiting process, which exchanges it
        // and prints a token. A token pasted directly is stored as-is - both end in the same
        // place, and which one somebody has depends on where they got it.
        //
        // No toast on the way out. The dialog closing is the confirmation, and the strip behind
        // it stops saying the assistant is not signed in - two signals for one event, and the
        // toast was the one that covered the pane it was reporting on.
        if (this.url && !value.startsWith('sk-ant-')) {
          await completeAssistantLogin(this.extension, value);
        } else {
          await setAssistantToken(this.extension, value);
        }

        this.$emit('signed-in');
        this.$emit('close');
      } catch (e) {
        // Kept in the dialog rather than thrown as a toast: whoever is looking at it is mid-way
        // through fixing something, and the thing that failed is the field in front of them.
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
    title="Sign the assistant in"
    icon="sparkle"
    :width="560"
    @close="$emit('close')"
  >
    <!--
      The choice, before anything is started. Both routes end in the same place; which one
      somebody takes depends on what they already have.
    -->
    <div v-if="mode === 'choose'" class="login-modal__choices">
      <button
        type="button"
        class="login-modal__choice"
        data-testid="login-use-subscription"
        @click="useSubscription"
      >
        <SIcon name="user" :size="16" />
        <span class="login-modal__choice-text">
          <span class="login-modal__choice-title">Use your Claude subscription</span>
          <span class="login-modal__choice-note">Authorise through claude.com in a new tab.</span>
        </span>
        <SIcon name="chevronRight" :size="14" />
      </button>

      <button
        type="button"
        class="login-modal__choice"
        data-testid="login-use-key"
        @click="useKey"
      >
        <SIcon name="lock" :size="16" />
        <span class="login-modal__choice-text">
          <span class="login-modal__choice-title">Use an API key</span>
          <span class="login-modal__choice-note">Paste a key starting <code>sk-ant-</code>.</span>
        </span>
        <SIcon name="chevronRight" :size="14" />
      </button>
    </div>

    <template v-else>
      <button type="button" class="login-modal__back" data-testid="login-back" @click="back">
        <SIcon name="chevronLeft" :size="12" />
        <span>Back</span>
      </button>

      <!--
        A spinner rather than a sentence. Starting the flow means running a command in the pod
        and waiting for it to print an address, which takes long enough to look like nothing is
        happening - and the sentence this replaced promised an address "below" that was not
        there yet.
      -->
      <div
        v-if="mode === 'oauth' && starting"
        class="login-modal__waiting"
        data-testid="login-starting"
        role="status"
        aria-live="polite"
      >
        <SIcon name="spinner" :size="16" class="login-modal__spin" />
        <span>Starting the sign-in in the pod. This produces the address to authorise at.</span>
      </div>

      <ol v-else-if="mode === 'oauth' && url" class="login-modal__steps">
        <li>
          <a
            :href="url"
            target="_blank"
            rel="noopener noreferrer"
            data-testid="login-url"
          >Authorise with your Claude account</a>
          <span class="login-modal__muted">· opens claude.com in a new tab</span>
        </li>
        <li>Paste the code it gives you back here.</li>
      </ol>

      <SField
        v-if="mode === 'key' || !starting"
        v-model="token"
        :label="mode === 'key' ? 'API key' : 'Code from that page'"
        :placeholder="mode === 'key' ? 'sk-ant-…' : 'Paste the code'"
        :hint="hint"
        autofocus
        data-testid="login-token"
        @keydown.enter="save"
      />
    </template>

    <p v-if="error" class="login-modal__error" data-testid="login-error">
      {{ error }}
    </p>

    <template #footer>
      <SButton variant="ghost" @click="$emit('close')">
        Cancel
      </SButton>
      <SButton
        v-if="mode !== 'choose'"
        variant="primary"
        :loading="saving"
        :disabled="(mode === 'oauth' && starting) || !token.trim()"
        data-testid="login-save"
        @click="save"
      >
        Sign in
      </SButton>
    </template>
  </SModal>
</template>

<style lang="scss" scoped>
.login-modal {
  &__error {
    margin:    8px 0 0;
    font-size: 12px;
    color:     var(--error);
  }

  &__steps {
    margin:      0 0 12px;
    padding-left: 18px;
    font-size:   13px;
    line-height: 1.8;
    color:       var(--body-text);
  }

  &__muted {
    color:     var(--muted);
    font-size: 12px;
  }

  &__choices {
    display:        flex;
    flex-direction: column;
    gap:            8px;
    margin:         0 0 4px;
  }

  &__choice {
    display:       flex;
    align-items:   center;
    gap:           12px;
    width:         100%;
    padding:       12px 14px;
    border:        1px solid var(--studio-border);
    border-radius: 4px;
    background:    transparent;
    color:         var(--body-text);
    text-align:    left;
    cursor:        pointer;

    // Rancher's shell sets `min-height: 40px; line-height: 40px; white-space: nowrap` on the
    // bare `button` selector, which every button in an extension inherits. Left alone it spaces
    // these two lines forty pixels apart and refuses to wrap the note. Undone here rather than
    // globally, because the rule belongs to the dashboard and this only owns its own dialog.
    line-height:   1.4;
    min-height:    0;
    white-space:   normal;

    &:hover {
      border-color: var(--primary);
      background:   var(--studio-surface-subtle, var(--body-bg));
    }
  }

  &__choice-text {
    display:        flex;
    flex-direction: column;
    gap:            2px;
    flex:           1;
    min-width:      0;
  }

  &__choice-title {
    font-size:   13px;
    font-weight: 600;
  }

  &__choice-note {
    font-size:   12px;
    line-height: 1.4;
    color:       var(--muted);

    code {
      padding:       0 4px;
      border-radius: 3px;
      background:    var(--studio-surface-subtle, var(--body-bg));
      font-size:     11px;
    }
  }

  &__back {
    display:     flex;
    align-items: center;
    gap:         4px;
    margin:      0 0 12px;
    padding:     0;
    border:      none;
    background:  transparent;
    font-size:   12px;
    color:       var(--muted);
    cursor:      pointer;

    &:hover { color: var(--body-text); }
  }

  &__waiting {
    display:       flex;
    align-items:   center;
    gap:           10px;
    margin:        0 0 12px;
    padding:       12px 14px;
    border:        1px solid var(--studio-border);
    border-radius: 4px;
    font-size:     13px;
    color:         var(--body-text);
  }

  &__spin { animation: login-modal-spin 1s linear infinite; }
}

@keyframes login-modal-spin {
  to { transform: rotate(360deg); }
}
</style>
