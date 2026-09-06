<script>
// A terminal onto one of this Studio's dev-server pods, drawn by the agents extension.
//
// The terminal used to be this extension's own component (PodTerminal.vue), and the agent pod
// and its drawer with it. They are the agents extension now - one terminal for every extension
// in the dashboard, offered on `window.__agents` - and what is left here is the placing of it:
// which pod (this extension's), which container, what to run (the same shell.sh the pod boots
// with), where a pasted image goes. What is deliberately not here is a terminal.
import { Banner } from '@components/Banner';
import { extensionPod, EXT_NS, EXT_CONTAINER } from '../extensions';

/** Where the agents extension puts its API, and the name it had while this extension owned it. */
const GLOBALS = ['__agents', '__extensionStudio'];
const READY_EVENTS = ['agents:ready', 'extension-studio:ready'];

function agentsApi() {
  const api = GLOBALS.map((name) => window[name]).find((candidate) => candidate?.terminal?.component);

  return api || null;
}

export default {
  name: 'AgentsTerminal',

  components: { Banner },

  emits: ['state'],

  props: {
    // Which extension's pod to open the session in.
    extension: {
      type:     String,
      required: true,
    },

    // Which tmux session to attach to. One pane, one session.
    session: {
      type:    String,
      default: 'editor',
    },

    // What the pane runs: the assistant's claude session, or a plain login shell.
    mode: {
      type:      String,
      default:   'claude',
      validator: (value) => ['claude', 'shell'].includes(value),
    },
  },

  data() {
    return { api: agentsApi(), waited: false };
  },

  computed: {
    terminal() {
      return this.api?.terminal?.component || null;
    },

    // shell.sh's arguments are positional: session, directory, home, mode. The two empty ones
    // are the pod's defaults - this pod's own tree and /app/.home - which shell.sh fills in.
    command() {
      return ['/bin/sh', '/seed/shell.sh', this.session, '', '', this.mode];
    },

    findPod() {
      return () => extensionPod(this.extension);
    },

    namespace() {
      return EXT_NS;
    },

    container() {
      return EXT_CONTAINER;
    },
  },

  mounted() {
    if (this.api) {
      return;
    }

    // The agents bundle may load after this one. It says when it has.
    const onReady = () => {
      this.api = agentsApi();
      if (this.api) {
        this.stop();
      }
    };

    this.stop = () => {
      READY_EVENTS.forEach((name) => window.removeEventListener(name, onReady));
      clearInterval(this.poll);
      clearTimeout(this.deadline);
    };
    READY_EVENTS.forEach((name) => window.addEventListener(name, onReady));
    this.poll = setInterval(onReady, 500);
    this.deadline = setTimeout(() => {
      this.stop();
      this.waited = true;
      this.$emit('state', 'closed');
    }, 15000);
  },

  beforeUnmount() {
    this.stop?.();
  },

  methods: {
    /** Type a line into the session from outside it, as the composer does. */
    sendText(text) {
      this.$refs.pane?.sendText?.(text);
    },

    reconnect() {
      this.$refs.pane?.reconnect?.();
    },
  },
};
</script>

<template>
  <div class="studio-terminal">
    <Banner
      v-if="!terminal && waited"
      color="warning"
      class="studio-terminal__missing"
    >
      The terminal is the <b>agents</b> extension's, and it is not loaded in this dashboard. Install it from Extensions, then reload.
    </Banner>
    <component
      :is="terminal"
      v-else-if="terminal"
      ref="pane"
      :session="session"
      :mode="mode"
      :command="command"
      :find-pod="findPod"
      :namespace="namespace"
      :container="container"
      image-dir="/app/.images"
      home="/app/.home"
      waiting-text="Waiting for the dev server pod"
      :label="extension"
      class="studio-terminal__pane"
      @state="$emit('state', $event)"
    />
    <div
      v-else
      class="studio-terminal__waiting"
    >
      Waiting for the agents extension
    </div>
  </div>
</template>

<style lang="scss" scoped>
.studio-terminal {
  display:        flex;
  flex-direction: column;
  height:         100%;
  min-width:      0;

  &__pane {
    flex:       1 1 auto;
    min-height: 0;
  }

  &__waiting {
    padding:   12px;
    color:     var(--muted);
    font-size: 12px;
  }

  &__missing { margin: 12px; }
}
</style>
