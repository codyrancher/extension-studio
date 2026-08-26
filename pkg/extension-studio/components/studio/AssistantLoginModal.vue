<script>
// Signing the pod's assistant back in, when its credential has run out.
//
// The credential lives in the pod, not in this browser: one shared login is pulled from a
// Kubernetes Secret before claude starts and pushed back when it refreshes, so an expiry is
// something every pod sees at once. Until now the only way through it was the sentence on the
// status strip - "run /login in the terminal" - which is true and is not a control.
//
// `/login` itself is an OAuth round trip through a browser, and nothing here can perform that
// on the pod's behalf. So this dialog offers the two things it honestly can: take the token
// that flow produces and put it where claude looks, or hand somebody to the terminal with the
// command already typed.
import {
  SModal, SButton, SField, SIcon
} from '../ui';
import { setAssistantToken, beginAssistantLogin, completeAssistantLogin } from '../../extensions';
import { toastSuccess } from '../../toast';

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
      token:    '',
      saving:   false,
      error:    '',
      // The authorise page, once the pod has started the flow and printed it.
      url:      '',
      starting: true,
    };
  },

  computed: {
    /** What is about to happen to what has been typed, said before it is sent. */
    hint() {
      const value = this.token.trim();

      if (!value) {
        return this.url
          ? 'The code from the page above.'
          : 'An Anthropic API key.';
      }

      if (value.startsWith('sk-ant-')) {
        return 'Looks like an API key, and is stored as it is.';
      }

      return this.url
        ? 'Sent back to the waiting sign-in, which exchanges it for a token.'
        : 'Stored as an OAuth token.';
    },
  },

  async mounted() {
    // Started on open rather than behind a button: this dialog exists because somebody is
    // locked out, and the first thing they need is the address. `claude setup-token` is what
    // prints it, and it waits at a prompt in the pod until the code comes back.
    try {
      this.url = await beginAssistantLogin(this.extension);
    } catch (e) {
      this.error = e?.message || String(e);
    } finally {
      this.starting = false;
    }
  },

  methods: {
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
        const kind = this.url && !value.startsWith('sk-ant-')
          ? await completeAssistantLogin(this.extension, value)
          : await setAssistantToken(this.extension, value);

        toastSuccess(
          this.$store,
          `${ this.extension }'s assistant is using ${ kind === 'apikey' ? 'an API key' : 'an OAuth token' } from now on.`,
          { title: 'Signed in' },
        );
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
    <p class="login-modal__say">
      The credential belongs to the pod this extension runs in, not to this browser, and it is
      shared by every extension here - so when it expires, they all stop at once.
    </p>

    <p v-if="starting" class="login-modal__say" data-testid="login-starting">
      Starting the sign-in in the pod, which is what produces the address below.
    </p>

    <ol v-else-if="url" class="login-modal__steps">
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
      v-model="token"
      :label="url ? 'Code from that page' : 'Token'"
      :placeholder="url ? 'Paste the code' : 'sk-ant-…'"
      :hint="hint"
      autofocus
      data-testid="login-token"
      @keydown.enter="save"
    />

    <p v-if="error" class="login-modal__error" data-testid="login-error">
      {{ error }}
    </p>

    <div class="login-modal__terminal">
      <SIcon name="terminal" :size="14" />
      <span>
        Already have an API key? Paste that instead - anything starting <code>sk-ant-</code> is
        stored as it is, without the page above.
      </span>
    </div>

    <template #footer>
      <SButton variant="ghost" @click="$emit('close')">
        Cancel
      </SButton>
      <SButton
        variant="primary"
        :loading="saving"
        :disabled="!token.trim()"
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
  &__say {
    margin:    0 0 12px;
    font-size: 13px;
    color:     var(--body-text);
  }

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

  &__terminal {
    display:       flex;
    align-items:   center;
    gap:           8px;
    margin-top:    16px;
    padding:       10px 12px;
    border:        1px solid var(--studio-border);
    border-radius: 4px;
    font-size:     12px;
    color:         var(--muted);

    span { flex: 1; }
  }
}
</style>
