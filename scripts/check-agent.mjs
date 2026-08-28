// The global agent pod and the chord that opens it, checked against themselves.
//
// A plain script rather than a jest spec, for the same reason scripts/check-service.mjs is one:
// jest does not run in this repo (its babel config is missing a plugin), and a spec that cannot
// be run is worse than none.
//
//   node scripts/check-agent.mjs
//
// Three halves, which is one more than the name allows. The first renders the objects this
// bundle would create and asserts the things that are invisible until a pod is running and
// wrong - the container's name, where the fingerprints are recorded, what the exec URL says.
// The second asserts the pod's own /seed carries what shell.sh will reach for. The third is the
// admin gate, driven through the real key handler with a stubbed dashboard around it, because
// "a non-admin does not get a terminal" is a claim about that handler and not about a constant.
//
// It needs no cluster and no browser.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const STUDIO = path.join(here, '..', 'pkg', 'extension-studio');
const POD = path.join(STUDIO, 'extension-skeleton', 'pod');

// What the modules under test believe they are running in. Set before they are imported, because
// execUrl reads the origin at call time but a module evaluated without a window at all would not
// get that far.
globalThis.window = { location: { origin: 'https://rancher.example' } };

/**
 * The gate's two dependencies, replaced so the handler can be driven both ways.
 *
 * `isAdminUser` is Rancher's and is not what is under test here - what is under test is that the
 * handler asks it and believes it. A source check below asserts that the import is Rancher's
 * rather than something hand-rolled, which is the other half of the same claim.
 */
const TYPE_MAP_STUB = `data:text/javascript,${ encodeURIComponent(`
  export function isAdminUser(getters) {
    globalThis.__adminAsked.push(getters);
    return globalThis.__admin;
  }
`) }`;

const VUE_STUB = `data:text/javascript,${ encodeURIComponent(`
  export function createApp(component) {
    globalThis.__apps.push(component);
    return {
      use(store) { globalThis.__used.push(store); },
      mount(el) {
        globalThis.__mounted.push(el);
        return { toggle() { globalThis.__toggles++; } };
      },
    };
  }
`) }`;

const PANEL_STUB = `data:text/javascript,${ encodeURIComponent('export default { name: "AgentPanelStub" };') }`;

// The same TypeScript bridge scripts/gen-extension-seed.mjs uses: node strips the types off a .ts
// file by itself, but will not guess the extension on `./agent`, which is how every import in
// this codebase is written.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.code !== 'MODULE_TYPELESS_PACKAGE_JSON') {
    console.warn(warning);
  }
});

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@shell/store/type-map') {
      return { url: TYPE_MAP_STUB, shortCircuit: true };
    }

    if (specifier === 'vue') {
      return { url: VUE_STUB, shortCircuit: true };
    }

    if (specifier.endsWith('.vue')) {
      return { url: PANEL_STUB, shortCircuit: true };
    }

    try {
      return nextResolve(specifier, context);
    } catch (e) {
      if (specifier.startsWith('.')) {
        return nextResolve(`${ specifier }.ts`, context);
      }

      throw e;
    }
  },
});

const agent = await import(path.join(STUDIO, 'agent.ts'));
const extensions = await import(path.join(STUDIO, 'extensions.ts'));
const { EXT_ACCOUNT, EXT_NS } = extensions;
const { execPath } = await import(path.join(POD, 'service', 'exec.mjs'));
const { EXT_CONTAINER } = await import(path.join(POD, 'service', 'names.mjs'));

let pass = 0, fail = 0;

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   ', name);
  } catch (e) {
    fail++;
    console.log('  FAIL ', name, '->', e?.message || e);
  }
}

// ---------------------------------------------------------------------------
// The objects
// ---------------------------------------------------------------------------
console.log('\nthe objects this bundle would create');

const deployment = agent.agentDeploymentBody();
const configMap = agent.agentConfigMapBody();
const container = deployment.spec.template.spec.containers[0];
const VERSION_ANNOTATION = 'barn.rancher.io/source-version';

check('the pod runs the account every pod here runs as', () => {
  assert.equal(deployment.spec.template.spec.serviceAccountName, EXT_ACCOUNT);
  assert.equal(deployment.metadata.namespace, EXT_NS);
  assert.equal(configMap.metadata.namespace, EXT_NS);
});

check('its container is not called what an extension\'s is', () => {
  // The whole reason the service's exec route grew a container parameter. Naming this one
  // `devserver` would make that parameter unnecessary and the name a lie at the same time.
  assert.notEqual(container.name, EXT_CONTAINER);
  assert.equal(container.name, 'agent');
});

check('it starts no dev server and serves no port', () => {
  assert.deepEqual(container.command, ['/bin/sh', '/seed/boot.sh']);
  assert.equal(container.ports, undefined);
  assert.equal(container.readinessProbe, undefined);
});

check('conversations and the claude login are on the node rather than in the pod', () => {
  const volume = deployment.spec.template.spec.volumes.find((v) => v.name === 'workspace');

  assert.ok(volume.hostPath.path.startsWith('/var/lib/rancher/extension-studio/'));
  assert.ok(container.volumeMounts.some((m) => m.name === 'workspace' && m.mountPath === '/workspace'));
  assert.equal(deployment.spec.strategy.type, 'Recreate');
});

check('the fingerprint is on all three of the places that read it', () => {
  const version = agent.agentSourceVersion();

  // The ConfigMap and the Deployment for ensureCurrent, which compares metadata.annotations, and
  // the pod template because a mounted ConfigMap that changes under a running pod is not re-read.
  assert.equal(configMap.metadata.annotations[VERSION_ANNOTATION], version);
  assert.equal(deployment.metadata.annotations[VERSION_ANNOTATION], version);
  assert.equal(deployment.spec.template.metadata.annotations[VERSION_ANNOTATION], version);
});

check('the fingerprint moves when the source does', () => {
  const before = agent.agentSourceVersion();
  const files = agent.agentSourceFiles();

  assert.ok(Object.keys(files).length > 1);
  // Not a mutation of the real set - agentSourceFiles copies - so this is the arithmetic on its
  // own: a changed byte has to change the answer or a stale pod is never noticed.
  assert.notEqual(before, contentVersionOf({ ...files, 'boot.sh': `${ files['boot.sh'] }\n# no` }));
});

check('both objects are steps, so they are created by the loop everything else uses', () => {
  const steps = agent.agentSteps();

  assert.deepEqual(steps.map((s) => s.id), ['agent-source', 'agent-deployment']);
  // The ConfigMap first: a Deployment whose seed volume names an absent ConfigMap schedules a
  // pod that never starts, and the event that says so is on the pod.
  assert.equal(steps[0].type, 'configmaps');
  assert.equal(steps[1].type, 'apps.deployments');
  steps.forEach((step) => assert.equal(step.name, agent.AGENT_OBJECT));
});

// ---------------------------------------------------------------------------
// The way in
// ---------------------------------------------------------------------------
console.log('\nthe exec URL a pane opens');

check('a pane names the agent container, not an extension\'s', () => {
  const url = new URL(agent.agentShellUrl('agent-pod-1', 'agent-2'));

  assert.equal(url.searchParams.get('container'), 'agent');
  assert.equal(url.protocol, 'wss:');
  assert.equal(url.searchParams.get('tty'), '1');
  assert.equal(url.searchParams.get('stdin'), '1');
});

check('shell.sh is given all four of its positional arguments', () => {
  const url = new URL(agent.agentShellUrl('agent-pod-1', 'agent-2'));

  // Positional and none of them skippable: the mode is the fourth, so the directory and the home
  // in front of it have to be spelled out even though shell.sh has defaults - and its defaults
  // are /app, which this pod does not have.
  assert.deepEqual(url.searchParams.getAll('command'), [
    '/bin/sh', '/seed/shell.sh', 'agent-2', '/workspace/sessions/agent-2', '/workspace/.home', 'claude',
  ]);
});

check('one directory per conversation, because claude keys its history by directory', () => {
  const dirOf = (session) => new URL(agent.agentShellUrl('p', session)).searchParams.getAll('command')[3];

  assert.notEqual(dirOf('agent-1'), dirOf('agent-2'));
});

check('an extension pane is untouched by the container parameter', () => {
  const url = new URL(extensions.extensionShellUrl('base-pod', 'editor', 'shell'));

  assert.equal(url.searchParams.get('container'), 'devserver');
});

check('the service defaults the same way and honours an override', () => {
  assert.match(execPath('p', ['id'], false), new RegExp(`container=${ EXT_CONTAINER }`));
  assert.match(execPath('p', ['id'], false, 'agent'), /container=agent/);
  // argv, still: a joined string would be one binary whose name has spaces in it.
  assert.deepEqual([...new URLSearchParams(execPath('p', ['sh', '-c', 'ls'], false).split('?')[1])].
    filter(([k]) => k === 'command').map(([, v]) => v), ['sh', '-c', 'ls']);
});

// ---------------------------------------------------------------------------
// The pod's own /seed
// ---------------------------------------------------------------------------
console.log('\nwhat the pod is seeded with');

const seed = agent.agentSourceFiles();

check('everything shell.sh reaches for is in the ConfigMap', () => {
  // Read out of shell.sh rather than listed here, so a script it starts depending on tomorrow
  // fails this instead of failing in a pane with "No such file or directory".
  //
  // Names with an extension only. shell.sh also globs `/seed/skills<sep>*`, which is a set that
  // is allowed to be empty - the agent is given no skills - and a glob that matches nothing is
  // a loop that does not run rather than a missing file.
  const wanted = [...seed['shell.sh'].matchAll(/\/seed\/([a-z0-9-]+\.[a-z0-9]+)/g)].map((m) => m[1]);

  assert.ok(wanted.length >= 4);

  for (const file of new Set(wanted)) {
    assert.ok(seed[file], `shell.sh runs /seed/${ file }, which is not in the agent's ConfigMap`);
  }
});

check('the terminal scripts are the same ones an extension pane runs', () => {
  const shared = fs.readFileSync(path.join(POD, 'shell.sh'), 'utf8').split('__PATH_SEPARATOR__').join('__');

  assert.equal(seed['shell.sh'], shared);
  assert.equal(seed['claude-session.sh'], fs.readFileSync(path.join(POD, 'claude-session.sh'), 'utf8'));
});

check('its CLAUDE.md is the agent\'s and not an extension\'s', () => {
  const extension = fs.readFileSync(path.join(POD, 'session-claude.md'), 'utf8');

  assert.notEqual(seed['session-claude.md'], extension);
  assert.equal(seed['session-claude.md'], fs.readFileSync(path.join(POD, 'agent', 'session-claude.md'), 'utf8'));
});

check('that CLAUDE.md answers the three questions it exists to answer', () => {
  const md = seed['session-claude.md'];

  // How to reach every extension pod, container and all.
  assert.match(md, /kubectl -n extension-studio exec[^\n]*-c devserver/);
  // Where the API document is, and what happens if it tries its own token - the experiment this
  // was written after, rather than a guess.
  assert.match(md, /openapi\.json/);
  assert.match(md, /ServiceAccount token[\s\S]{0,200}must authenticate/);
  // And the thing that costs somebody else their afternoon.
  assert.match(md, /[Dd]o not restart[^\n]*dev server/);
});

check('the pod boots into something that stays up and installs the tools', () => {
  assert.match(seed['boot.sh'], /\/seed\/terminal-tools\.sh/);
  assert.match(seed['boot.sh'], /exec tail -f \/dev\/null/);
});

check('the session list is taken as the user whose tmux server it is', () => {
  // Root's tmux server has never held a session, so a listing that forgot this would report
  // none, for ever, in a pod full of conversations.
  assert.match(seed['sessions.sh'], /setpriv --reuid=1000/);
  assert.match(seed['sessions.sh'], /tmux ls/);
  assert.match(seed['sessions.sh'], /kill-session/);
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------
console.log('\nwho the chord is offered to');

installFakeDashboard();

const overlay = await import(path.join(STUDIO, 'agent-overlay.ts'));
const stop = overlay.registerAgentOverlay();

check('a non-admin pressing the chord gets nothing at all', () => {
  globalThis.__admin = false;
  reset();
  chord();

  assert.equal(globalThis.__toggles, 0, 'the panel was opened');
  assert.equal(globalThis.__apps.length, 0, 'a panel was built for somebody who may not use it');
  assert.equal(document.body.children.length, 0, 'something was put in the page');
  assert.equal(globalThis.__adminAsked.length, 1, 'the handler did not ask whether they were an admin');
});

check('an admin pressing the chord gets the panel', () => {
  globalThis.__admin = true;
  reset();
  chord();

  assert.equal(globalThis.__toggles, 1);
  assert.equal(globalThis.__apps.length, 1);
  assert.equal(document.body.children.length, 1);
});

check('the same chord is what closes it, so it is one toggle rather than two handlers', () => {
  globalThis.__admin = true;
  reset();
  chord();

  assert.equal(globalThis.__toggles, 1);
  // And no second panel: the app is built once and kept.
  assert.equal(globalThis.__apps.length, 0);
});

check('the gate is Rancher\'s definition of an admin, not one of ours', () => {
  const source = fs.readFileSync(path.join(STUDIO, 'agent-overlay.ts'), 'utf8');
  const panel = fs.readFileSync(path.join(STUDIO, 'components', 'AgentPanel.vue'), 'utf8');

  assert.match(source, /import \{ isAdminUser \} from '@shell\/store\/type-map'/);
  // Both ends: the handler will not open it, and the panel will not render a terminal if it is
  // reached some other way.
  assert.match(panel, /import \{ isAdminUser \} from '@shell\/store\/type-map'/);
  assert.match(panel, /v-if="open && admin"/);
  // And nothing that reads a role name, which is the hand-rolled version this replaces.
  assert.doesNotMatch(source + panel, /globalRole|admin-?role|GlobalRoleBinding/i);
});

check('typing a backtick in a form does not open a terminal over the form', () => {
  globalThis.__admin = true;
  reset();
  chord({ tagName: 'INPUT' });
  chord({ tagName: 'TEXTAREA' });
  chord({ isContentEditable: true });

  assert.equal(globalThis.__toggles, 0);
  // And it never even asked, so the check is not the thing keeping it shut.
  assert.equal(globalThis.__adminAsked.length, 0);
});

check('but typing in the panel does, since xterm\'s input is a textarea', () => {
  globalThis.__admin = true;
  reset();
  chord({ tagName: 'TEXTAREA', inPanel: true });

  // Without this the panel could be opened from the keyboard and never closed from it.
  assert.equal(globalThis.__toggles, 1);
});

check('a plain backtick, or ctrl without shift, is not the chord', () => {
  globalThis.__admin = true;
  reset();
  chord({ ctrlKey: false });
  chord({ shiftKey: false });
  chord({ code: 'KeyB' });
  chord({ metaKey: true });

  assert.equal(globalThis.__toggles, 0);
});

stop();

check('stopping removes the listener rather than leaving it on the document', () => {
  reset();
  globalThis.__admin = true;
  chord();

  assert.equal(globalThis.__toggles, 0);
  assert.equal(globalThis.__adminAsked.length, 0);
});

console.log(`\n${ pass } passed, ${ fail } failed`);
process.exit(fail ? 1 : 0);

/** The djb2 in ensure-current.ts, over the same shape agentSourceVersion feeds it. */
function contentVersionOf(files) {
  let hash = 5381;

  for (const text of Object.keys(files).sort().flatMap((key) => [key, files[key]])) {
    for (let i = 0; i < text.length; i++) {
      hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
    }
  }

  return hash.toString(16).padStart(8, '0');
}

function reset() {
  globalThis.__toggles = 0;
  globalThis.__apps = [];
  globalThis.__used = [];
  globalThis.__mounted = [];
  globalThis.__adminAsked = [];
}

/** One press of ctrl+shift+backtick, with whatever it is being pressed on top of. */
function chord({ inPanel = false, ...over } = {}) {
  const target = {
    tagName: 'DIV', isContentEditable: false, ...over, __inPanel: inPanel,
  };

  globalThis.__keydown({
    ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, code: 'Backquote', target, preventDefault() {},
    ...over,
  });
}

/**
 * Just enough of a page for the handler to run in.
 *
 * Hand-rolled rather than jsdom: what the handler touches is five methods, and a dependency that
 * has to be installed is a check that stops being run.
 */
function installFakeDashboard() {
  const panelHost = { id: '', contains: (node) => !!node?.__inPanel, remove() {} };
  const app = { __vue_app__: { config: { globalProperties: { $store: { getters: {} } } } } };

  globalThis.document = {
    body:          { children: [], appendChild(node) { this.children.push(node); } },
    createElement: () => panelHost,
    querySelector: (selector) => (selector === '#app' ? app : null),
    getElementById: (id) => (panelHost.id === id ? panelHost : null),
  };

  globalThis.window.addEventListener = (type, fn) => {
    if (type === 'keydown') {
      globalThis.__keydown = fn;
    }
  };
  globalThis.window.removeEventListener = (type) => {
    if (type === 'keydown') {
      globalThis.__keydown = () => {};
    }
  };

  reset();
}
