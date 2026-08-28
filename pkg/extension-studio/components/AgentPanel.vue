<script>
// The panel the global chord opens: several conversations with the agent pod, as tabs.
//
// Everything below the tab strip is PodTerminal, unchanged, pointed at the agent pod instead of
// an extension's. What this adds is the part a single pane cannot have: more than one
// conversation at a time, and a list of them that is true for everybody rather than true for
// this browser tab.
//
// That list comes from the pod. tmux is where a session actually exists, so it is what is asked
// (see agentSessions), which is what makes a second browser tab, a reload and a colleague's
// session all show the same conversations. Remembering them in localStorage would show each
// browser its own history of what it had opened, including conversations that are long gone and
// excluding the ones somebody else started.
import { isAdminUser } from '@shell/store/type-map';
import PodTerminal from './PodTerminal';
import { agentSessions, endAgentSession } from '../agent';

/** What a session this panel opens is called. Numbered from one, and the number is the tab label. */
const SESSION_PREFIX = 'agent-';

export default {
  name: 'AgentPanel',

  components: { PodTerminal },

  data() {
    return {
      open:     false,
      // Every conversation in the pod, plus any this panel has just asked for and whose tmux
      // session the terminal has not created yet.
      sessions: [],
      active:   '',
      // Which of them have ever been on screen. A tab is mounted on first visit and then kept,
      // with v-show, so switching back is instant and its scrollback is still there; a tab
      // nobody has opened costs nothing.
      seen:     [],
      loading:  false,
    };
  },

  computed: {
    /**
     * Whether to show any of this at all.
     *
     * Rancher's own definition, read from what the user's schemas say they may PUT rather than
     * from a global role name we would have to keep in step with Rancher's. See the note in
     * agent-overlay.ts for why the gate is here as well as on the key handler.
     */
    admin() {
      return isAdminUser(this.$store.getters);
    },
  },

  methods: {
    /** What the chord does. Opening refreshes the list, because the pod may have changed since. */
    toggle() {
      if (!this.admin) {
        return;
      }

      this.open = !this.open;

      if (this.open) {
        this.refresh();
      }
    },

    close() {
      this.open = false;
    },

    async refresh() {
      this.loading = true;

      try {
        const found = await agentSessions();
        // Union, not replacement: a tab opened a second ago has no tmux session until its
        // terminal connects and shell.sh creates one, and dropping it here would make the new
        // tab vanish under the person who asked for it.
        const known = new Set([...found, ...this.sessions.filter((name) => this.seen.includes(name))]);

        this.sessions = [...known].sort(byNumber);
      } finally {
        this.loading = false;
      }

      if (!this.sessions.length) {
        this.newSession();
      } else if (!this.sessions.includes(this.active)) {
        this.show(this.sessions[0]);
      }
    },

    /**
     * Open another conversation.
     *
     * Nothing is created in the pod here. Mounting a terminal on a session name runs shell.sh,
     * and `tmux new-session -A` creates the session if it is not there - so asking the pod to
     * make one first would be a round trip whose only effect is to do it a second earlier.
     */
    newSession() {
      let n = 1;

      while (this.sessions.includes(`${ SESSION_PREFIX }${ n }`)) {
        n++;
      }

      this.sessions = [...this.sessions, `${ SESSION_PREFIX }${ n }`].sort(byNumber);
      this.show(`${ SESSION_PREFIX }${ n }`);
    },

    show(session) {
      this.active = session;

      if (!this.seen.includes(session)) {
        this.seen = [...this.seen, session];
      }
    },

    /**
     * End one conversation.
     *
     * This kills the tmux session, and that is deliberate rather than incidental. The strip is
     * the pod's list, so a close that only dropped the tab would put it back on the next
     * refresh. The thing that leaves conversations running is closing the panel, or the browser,
     * or reloading the page - none of which touch the pod.
     */
    async closeSession(session) {
      this.sessions = this.sessions.filter((name) => name !== session);
      this.seen = this.seen.filter((name) => name !== session);

      if (this.active === session) {
        this.active = this.sessions[0] || '';
      }

      await endAgentSession(session);

      if (!this.sessions.length) {
        this.newSession();
      }
    },

    label(session) {
      return session.startsWith(SESSION_PREFIX) ? session.slice(SESSION_PREFIX.length) : session;
    },
  },
};

/** agent-2 before agent-10, which a string sort would not do. */
function byNumber(a, b) {
  const num = (name) => Number(name.replace(/\D+/g, '')) || 0;

  return num(a) - num(b) || a.localeCompare(b);
}
</script>

<template>
  <!--
    The admin check again, and not only on the key handler. A non-admin who reached this some
    other way gets nothing rendered rather than a terminal that would open into a cluster-admin
    ServiceAccount. See agent-overlay.ts for what this gate is and is not.
  -->
  <div
    v-if="open && admin"
    class="mc-agent"
  >
    <header class="mc-agent__bar">
      <span class="mc-agent__title">Agent</span>

      <div
        class="mc-agent__tabs"
        role="tablist"
      >
        <div
          v-for="session in sessions"
          :key="session"
          class="mc-agent__tab"
          :class="{ 'mc-agent__tab--active': session === active }"
        >
          <button
            type="button"
            role="tab"
            :aria-selected="session === active"
            :title="session"
            class="mc-agent__tab-open"
            @click="show(session)"
          >
            {{ label(session) }}
          </button>
          <button
            type="button"
            class="mc-agent__tab-close"
            :title="`End ${ session }`"
            :aria-label="`End ${ session }`"
            @click="closeSession(session)"
          >
            &times;
          </button>
        </div>

        <button
          type="button"
          class="mc-agent__add"
          title="Another conversation"
          aria-label="Another conversation"
          @click="newSession"
        >
          +
        </button>
      </div>

      <span
        v-if="loading"
        class="mc-agent__loading"
      >Reading the pod</span>

      <button
        type="button"
        class="mc-agent__close"
        title="Close (ctrl+shift+`). The conversations keep running."
        aria-label="Close the agent panel"
        @click="close"
      >
        &times;
      </button>
    </header>

    <!--
      Mounted on first visit and kept with v-show. A tab that was unmounted would reconnect and
      redraw every time it came back, which is a second of black for something tmux is holding
      anyway; a tab nobody has opened has no socket at all.
    -->
    <div class="mc-agent__panes">
      <div
        v-for="session in seen"
        v-show="session === active"
        :key="session"
        class="mc-agent__pane"
      >
        <PodTerminal
          target="agent"
          :session="session"
        />
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.mc-agent {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  // Above Rancher's header and its side nav, which sit in the low hundreds, and below the
  // dashboard's own modals, which is where a dialog somebody opened deliberately belongs.
  z-index: 900;
  display: flex;
  flex-direction: column;
  height: 60vh;
  min-height: 240px;
  border-top: 1px solid var(--border);
  background: var(--terminal-bg, var(--body-bg));
  box-shadow: 0 -6px 18px rgba(0, 0, 0, 0.25);

  &__bar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 0 0 auto;
    padding: 4px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--header-bg, var(--body-bg));
    color: var(--body-text);
    font-size: 12px;
  }

  &__title {
    font-weight: 600;
    opacity: 0.75;
  }

  &__tabs {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    overflow-x: auto;
  }

  &__tab {
    display: flex;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: 4px;

    &--active {
      border-color: var(--link);
      color: var(--link);
    }
  }

  &__tab-open,
  &__tab-close,
  &__add,
  &__close {
    padding: 2px 8px;
    border: none;
    background: none;
    color: inherit;
    cursor: pointer;
    font-size: 12px;
    line-height: 18px;
  }

  &__tab-close {
    padding-left: 0;
    opacity: 0.5;

    &:hover {
      opacity: 1;
    }
  }

  &__add {
    border: 1px solid var(--border);
    border-radius: 4px;
  }

  &__loading {
    color: var(--muted);
  }

  &__close {
    margin-left: auto;
    font-size: 16px;
  }

  &__panes {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
  }

  &__pane {
    position: absolute;
    inset: 0;
  }
}
</style>
