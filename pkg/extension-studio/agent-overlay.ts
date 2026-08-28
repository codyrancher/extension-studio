// The chord that opens the agent, from anywhere in Rancher.
//
// This bundle is a UIPlugin, so index.ts runs on every page load of the whole dashboard - the
// Studio's screens, Rancher's own, a cluster's Workloads list. That is already a global hook,
// and it is the only one needed: a keydown listener on the document, and a panel appended to
// the body. There is no slot to claim and nothing to register with, which is the point - the
// header's single NavHeaderRight slot is the mechanism this product deliberately gave up, since
// the last extension to claim it silently wins.
//
// ---------------------------------------------------------------------------
// Who this is offered to, and why that is a decision rather than an omission.
//
// The pane runs as the `extension-studio` ServiceAccount, which is bound to cluster-admin. The
// exec WebSocket is authenticated as whoever is looking at the page, so Kubernetes refuses
// anybody without exec rights in this namespace - but exec in one namespace is not
// cluster-admin, and a user with edit on `extension-studio`, or a project containing it, has the
// first without the second. For them this chord is a one-keystroke privilege escalation, so the
// affordance is offered to Rancher admins only, and to everybody else it does not exist: no
// disabled button, no refusal, no hint that a chord is there. A control that only ever says no
// is noise.
//
// Say the honest thing about what that gate is: it is a UI gate, not a security boundary. A
// non-admin with exec rights in this namespace can still reach the pod with `kubectl`, and
// nothing in a browser can stop that. The real fix is to scope the pod's ServiceAccount below
// cluster-admin, and it is not done here because the agent's whole usefulness is that it can
// reach every extension pod and ask the cluster anything - a narrower grant is a design, not a
// smaller number.
// ---------------------------------------------------------------------------
import { createApp } from 'vue';
import { isAdminUser } from '@shell/store/type-map';
import AgentPanel from './components/AgentPanel.vue';

/**
 * `event.code`, not `event.key`.
 *
 * Shift and a backtick produce `~` on a US layout and something else again elsewhere, so the
 * character the browser reports is not the key the chord is named after. `Backquote` is the
 * physical key, which is what "ctrl+shift+`" means to the person pressing it.
 */
const CHORD_CODE = 'Backquote';

/** Where the panel is mounted. Identified so a second bundle load finds it instead of stacking. */
const HOST_ID = 'extension-studio-agent-overlay';

let panel: any = null;
let listening = false;

/**
 * The dashboard's Vuex store, taken off the app Vue mounted.
 *
 * There is no import for it: `@shell/config/store` builds one, and the running dashboard's is
 * the one already mounted on `#app`. Vue 3 puts the app it mounted on the element, so this reads
 * that rather than constructing a second store which would answer about nobody.
 *
 * Null is a real answer and the gate below fails closed on it - on the login page, or before the
 * app has mounted, there is no user to be an admin.
 */
function dashboardStore(): any {
  return (document.querySelector('#app') as any)?.__vue_app__?.config?.globalProperties?.$store || null;
}

function isAdmin(): boolean {
  const store = dashboardStore();

  return !!store && isAdminUser(store.getters);
}

/**
 * Whether this keystroke is somebody typing rather than asking for the panel.
 *
 * The panel itself is exempt, and that exemption is the whole reason this is not a one-line
 * check. xterm's input is a textarea, so once the panel is open every keystroke in it looks like
 * typing - and the chord that opens the panel is also the chord that closes it. Without this,
 * the panel could be opened and never closed from the keyboard.
 */
function isTyping(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;

  if (!target || document.getElementById(HOST_ID)?.contains(target)) {
    return false;
  }

  return /^(input|textarea|select)$/i.test(target.tagName) || target.isContentEditable;
}

/** The panel, made the first time it is wanted so a non-admin never builds one. */
function panelInstance(): any {
  if (panel) {
    return panel;
  }

  const host = document.createElement('div');

  host.id = HOST_ID;
  document.body.appendChild(host);

  // Its own Vue app rather than a component slotted into the dashboard's, because there is no
  // slot to put it in. The dashboard's store is handed to it so the panel can make the same
  // admin check the handler above makes, from its own render.
  const app = createApp(AgentPanel);

  app.use(dashboardStore());
  panel = app.mount(host);

  return panel;
}

function onKeyDown(event: KeyboardEvent): void {
  if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || event.code !== CHORD_CODE) {
    return;
  }

  if (isTyping(event) || !isAdmin()) {
    return;
  }

  event.preventDefault();
  panelInstance().toggle();
}

/**
 * Listen for the chord, and hand back the way to stop.
 *
 * Guarded against a second call: a bundle evaluated twice would otherwise leave two listeners on
 * the document, and the chord would open the panel and immediately close it again.
 */
export function registerAgentOverlay(): () => void {
  if (listening) {
    return () => {};
  }

  listening = true;
  window.addEventListener('keydown', onKeyDown);

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    listening = false;
    panel = null;
    document.getElementById(HOST_ID)?.remove();
  };
}
