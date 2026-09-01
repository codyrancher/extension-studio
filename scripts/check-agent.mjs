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
      _context: { components: {}, directives: {}, provides: {} },
      config:   { globalProperties: {} },
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

async function checkAsync(name, fn) {
  try {
    await fn();
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
    '/bin/sh', '/seed/shell.sh', 'agent-2', '/workspace/conversations', '/workspace/.home', 'claude',
  ]);
});

check('every conversation runs in one directory, so each can see the others', () => {
  // The opposite of what this asserted first. A directory per conversation kept claude's
  // histories apart, which meant the resume picker in one tab could not offer any of the
  // others - and the tabs are meant to be one place. Sharing the directory is what makes them
  // visible to each other; claude-session.sh is what stops a pane adopting the wrong one.
  const dirOf = (session) => new URL(agent.agentShellUrl('p', session)).searchParams.getAll('command')[3];

  assert.equal(dirOf('agent-1'), dirOf('agent-2'));
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

check('the session script runs as the user whose tmux server it is', () => {
  // Root's tmux server has never held a session, so kill-session run as root reports no such
  // session and everything written would be owned by the wrong user.
  assert.match(seed['sessions.sh'], /setpriv --reuid=1000/);
});

check('a conversation is a directory, not a tmux session', () => {
  // The distinction the first version got wrong twice: every conversation vanished from the
  // strip when the pod rolled, and `new` could hand back a name whose directory still existed.
  assert.match(seed['sessions.sh'], /SESSIONS=\/workspace\/sessions/);
  assert.doesNotMatch(seed['sessions.sh'], /tmux ls/);
});

check('a new conversation is allocated with mkdir, which is the only atomic thing here', () => {
  // Two browser tabs pressing + at the same moment see the same list and would pick the same
  // next number; mkdir is what makes only one of them win it.
  assert.match(seed['sessions.sh'], /mkdir "\$SESSIONS\/\$id" 2>\/dev\/null/);
});

check('a pane resumes its own conversation rather than the newest', () => {
  // --continue takes whatever was touched last in the directory, which with one shared
  // directory is any pane's. Each records the id of the conversation it opened and resumes by
  // name; the id is only recorded when exactly one transcript appeared, because two panes
  // starting together cannot be told apart and a wrong id is worse than none.
  assert.match(seed['claude-session.sh'], /--resume "\$CONVERSATION"/);
  assert.match(seed['claude-session.sh'], /ID_FILE=\$\{2:-\}/);
  assert.match(seed['claude-session.sh'], /comm -13 "\$BEFORE" "\$AFTER"/);
  // And the extension terminals, which still have a directory each, keep --continue.
  assert.match(seed['claude-session.sh'], /--continue/);
  assert.match(seed['shell.sh'], /claude-session\.sh '\$MC_QUEUE' '\$MC_CONVERSATION'/);
});

check('ending one takes its name and its id, and leaves the transcripts alone', () => {
  // Left behind, the directory is a name `new` can never reuse, so that still goes. The
  // transcripts do not: every conversation shares one directory now, so "this conversation's
  // transcripts" is the whole set, and a closed tab is the conversation somebody is most
  // likely to want back out of the resume picker.
  assert.match(seed['sessions.sh'], /kill-session/);
  assert.match(seed['sessions.sh'], /rm -rf "\$SESSIONS\/\$ID"/);
  assert.match(seed['sessions.sh'], /rm -f "\$SESSIONS\/\$ID\.id"/);
  assert.doesNotMatch(seed['sessions.sh'], /rm -rf "\$AGENT_HOME\/\.claude\/projects\//);
  // Spelled out rather than $HOME: this arrives as root and setpriv changes the user without
  // changing the environment, so $HOME here is /root and every path built from it is wrong.
  assert.match(seed['sessions.sh'], /^AGENT_HOME=\/workspace\/\.home$/m);
  assert.doesNotMatch(seed['sessions.sh'], /"\$HOME\//);
});

check('the name lives in the pod, beside the conversation', () => {
  assert.match(seed['sessions.sh'], /\.title/);
  // Sanitised, because `list` is one line per conversation and a tab is not a paragraph.
  assert.match(seed['sessions.sh'], /tr -d '\\000-\\037'/);
  assert.match(seed['sessions.sh'], /cut -c1-200/);
});

check('the id it is handed is checked rather than trusted', () => {
  // It names a directory that is about to be rm -rf'd.
  assert.match(seed['sessions.sh'], /\*\[!a-zA-Z0-9-\]\*/);
});

check('the claude CLI is the harness\'s kind of install, in the durable home', () => {
  const tools = seed['terminal-tools.sh'];

  // npm-global could never update itself in a pod - /usr/local/lib is root's and the pane is
  // not - and `claude doctor` said so. The native installer lands in the home that outlives the
  // pod, which also stops a restart reinstalling it.
  assert.match(tools, /claude\.ai\/install\.sh/);
  assert.match(tools, /CLAUDE_BIN="\$APP_HOME\/\.local\/bin\/claude"/);
  // And npm stays as the fallback rather than being deleted: a pane with an older claude beats
  // a pane with none.
  assert.match(tools, /falling back to npm[\s\S]{0,120}npm install -g/);
  // The pane has to be able to find it.
  assert.match(seed['shell.sh'], /PANE_PATH="\$HOME_DIR\/\.local\/bin:\$PATH"/);
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

// ---------------------------------------------------------------------------
// The conversations, as the pod reports them
// ---------------------------------------------------------------------------
console.log('\nreading the pod\'s own list of conversations');

const LISTING = 'agent-2\tsomething a person typed\nagent-10\tten\nagent-1\t1\nnot-a-session\tjunk\n\n';
let lastExec = null;

globalThis.fetch = async(url, init) => {
  if (url.includes('/v1/pods/extension-studio')) {
    return jsonResponse({
      data: [{
        metadata: { name: 'agent-pod-1', labels: { app: 'extension-studio-agent' } },
        status:   { phase: 'Running' },
      }],
    });
  }

  if (url.includes('/exec')) {
    lastExec = { url, body: JSON.parse(init.body) };

    return jsonResponse({ stdout: globalThis.__stdout, stderr: '', code: globalThis.__code ?? 0 });
  }

  return jsonResponse({}, 404);
};

await checkAsync('the listing is parsed into ids and the names people gave them', async() => {
  globalThis.__stdout = LISTING;

  const sessions = await agent.agentSessions();

  // Numeric order, not the string order a strip would otherwise show as 1, 10, 2. And the line
  // that is not a conversation is dropped rather than becoming a tab that cannot be opened.
  assert.deepEqual(sessions.map((s) => s.id), ['agent-1', 'agent-2', 'agent-10']);
  assert.equal(sessions.find((s) => s.id === 'agent-2').title, 'something a person typed');
});

await checkAsync('it runs in the agent pod\'s own container', async() => {
  globalThis.__stdout = LISTING;
  await agent.agentSessions();

  assert.equal(lastExec.body.container, 'agent');
  assert.deepEqual(lastExec.body.command, ['/bin/sh', '/seed/sessions.sh', 'list']);
});

await checkAsync('the pod allocates the name for a new conversation, not the browser', async() => {
  globalThis.__stdout = 'agent-4\n';

  assert.equal(await agent.startAgentSession(), 'agent-4');
  // `new` rather than a name we chose: two browser tabs pressing + at once would choose the
  // same one, and a name whose directory still exists would reopen a finished conversation.
  assert.deepEqual(lastExec.body.command, ['/bin/sh', '/seed/sessions.sh', 'new']);
});

await checkAsync('a name is sent as argv, so a title with a quote in it is not shell', async() => {
  globalThis.__stdout = '';
  await agent.renameAgentSession('agent-1', "don't; rm -rf /");

  assert.deepEqual(lastExec.body.command, [
    '/bin/sh', '/seed/sessions.sh', 'rename', 'agent-1', "don't; rm -rf /",
  ]);
});

await checkAsync('a script that fails says so rather than answering with nothing', async() => {
  globalThis.__stdout = '';
  globalThis.__code = 2;

  await assert.rejects(() => agent.startAgentSession());
  // The listing is the exception, and deliberately: a pod that has only just started is a list
  // of none, not an error over a panel that is merely early.
  assert.deepEqual(await agent.agentSessions(), []);
  globalThis.__code = 0;
});

// ---------------------------------------------------------------------------
// The drawer, which is the one part that is this browser's business
// ---------------------------------------------------------------------------
console.log('\nremembering the drawer, per browser');

const drawer = await import(path.join(STUDIO, 'agent-drawer.ts'));

/** The fields a caller cares about, without the geometry defaults every read fills in. */
function drawerShape(state) {
  return { open: state.open, active: state.active, placement: state.placement };
}

check('what is written comes back', () => {
  const entries = installFakeStorage();
  const written = {
    open: true, active: 'agent-3', placement: 'right', geometry: { height: 300, width: 400 },
  };

  drawer.writeDrawerState(written);
  assert.deepEqual(drawer.readDrawerState(), written);
  // One key, namespaced, because this is Rancher's own origin.
  assert.match([...entries.keys()][0], /^extension-studio\./);
});

check('anything that is not a drawer state reads as closed', () => {
  const entries = installFakeStorage();

  drawer.writeDrawerState({ open: true, active: 'agent-3', placement: 'bottom' });

  const key = [...entries.keys()][0];

  // Empty, unparseable, the wrong type, and the right shape with the wrong types in it. Each
  // one is a real way for this to be wrong: cleared storage, a half-written value, a key another
  // version of this wrote, and a hand-edited one.
  for (const junk of ['', 'not json', 'null', '"a string"', '{"open":"yes"}', '{"open":true,"active":7}']) {
    entries.set(key, junk);
    assert.deepEqual(
      drawerShape(drawer.readDrawerState()),
      junk === '{"open":true,"active":7}'
        ? { open: true, active: '', placement: 'bottom' }
        : { open: false, active: '', placement: 'bottom' },
      `"${ junk }" was read as something other than closed`,
    );
  }

  entries.set(key, '{"open":true}');
  assert.deepEqual(drawerShape(drawer.readDrawerState()), { open: true, active: '', placement: 'bottom' });
});

check('storage that throws is a drawer that does not reopen, not a page that breaks', () => {
  installFakeStorage({ throws: true });

  assert.deepEqual(drawerShape(drawer.readDrawerState()), { open: false, active: '', placement: 'bottom' });
  assert.doesNotThrow(() => drawer.writeDrawerState({ open: true, active: 'agent-1' }));
});

// ---------------------------------------------------------------------------
// Reopening it after a reload
// ---------------------------------------------------------------------------
console.log('\nreopening the drawer after a full page load');

check('a drawer that was closed builds nothing and watches nothing', () => {
  installFakeStorage();
  reset();
  globalThis.__watchers = [];

  const stopClosed = registerFresh();

  assert.equal(globalThis.__apps.length, 0);
  assert.equal(liveWatchers(), 0);
  stopClosed();
});

await checkAsync('a drawer that was open survives being evaluated before the app mounts', async() => {
  installFakeStorage();
  drawer.writeDrawerState({ open: true, active: 'agent-2' });
  reset();
  globalThis.__watchers = [];
  globalThis.__admin = true;
  globalThis.__appMounted = false;

  const stopEarly = registerFresh();

  // Nothing to read a store off yet, and this is the case that used to fail silently: asked
  // once, answered null, and the drawer never came back on a refresh.
  assert.equal(globalThis.__apps.length, 0);

  globalThis.__appMounted = true;
  await new Promise((resolve) => setTimeout(resolve, 600));

  assert.equal(globalThis.__apps.length, 1, 'the drawer was not rebuilt once the app mounted');
  stopEarly();
});

check('a drawer that was open waits for the schemas rather than asking too early', () => {
  installFakeStorage();
  drawer.writeDrawerState({ open: true, active: 'agent-2' });
  reset();
  globalThis.__watchers = [];
  globalThis.__admin = false;

  const stopOpen = registerFresh();

  // Nothing yet: on a cold load this runs before Rancher has fetched the schemas isAdminUser
  // reads, and asking now would answer "not an admin" for an admin and drop the drawer.
  assert.equal(globalThis.__apps.length, 0);
  assert.equal(liveWatchers(), 1);

  settleAdmin(true);

  assert.equal(globalThis.__apps.length, 1, 'the drawer was not rebuilt when the answer arrived');
  // And it stops watching, rather than rebuilding a drawer on every later store change.
  assert.equal(liveWatchers(), 0);
  stopOpen();
});

check('and never for somebody the schemas never call an admin', () => {
  installFakeStorage();
  drawer.writeDrawerState({ open: true, active: 'agent-2' });
  reset();
  globalThis.__watchers = [];
  globalThis.__admin = false;

  const stopNonAdmin = registerFresh();

  settleAdmin(false);
  assert.equal(globalThis.__apps.length, 0);
  assert.equal(document.body.children.length, 0);
  stopNonAdmin();
});

// ---------------------------------------------------------------------------
// The strip
// ---------------------------------------------------------------------------
console.log('\nthe tab strip');

const panelSource = fs.readFileSync(path.join(STUDIO, 'components', 'AgentPanel.vue'), 'utf8');

// ---------------------------------------------------------------------------
// The identity a pane runs as
// ---------------------------------------------------------------------------
//
// The agent used to have only the pod's ServiceAccount, which Rancher refuses outright and
// which is cluster-admin where it works. Every check here is about one property: what a pane
// does, it does as the person who opened the panel.

const { SEEDS } = await import(path.join(STUDIO, 'extension-seed.generated.ts'));
const extensionSeed = SEEDS.base || {};
const credentialSource = fs.readFileSync(path.join(STUDIO, 'agent-credential.ts'), 'utf8');
const podCredential = seed['rancher-credential.sh'];
const podShell = seed['shell.sh'];
const sharedLogin = seed['claude-credentials.mjs'];

check('the agent pod is seeded with the credential step, and an extension pod is not', () => {
  assert.ok(podCredential, 'rancher-credential.sh is not in the agent seed');
  assert.ok(!extensionSeed['rancher-credential.sh'], 'an extension pod was given the agent credential step');

  // Which is why the call has to be guarded: shell.sh is shared with every extension pod.
  assert.match(podShell, /\[ -f \/seed\/rancher-credential\.sh \]/);
});

check('the credential is read as the pod and used as the person', () => {
  // The Secret is read with the ServiceAccount, because the file being written IS the
  // credential kubectl would otherwise use to read its own replacement.
  assert.match(podCredential, /KUBECONFIG=\/dev\/null kubectl/);
  // And what it writes points at Rancher, not at the apiserver: the token is a Rancher one.
  assert.match(podCredential, /server: \$RANCHER_URL\/k8s\/clusters\/local/);
});

check('neither file it writes is readable by anything else on the node', () => {
  assert.match(podCredential, /chmod 600 "\$tmp"/);
  // The mode is set before the rename, so the file is never briefly world-readable.
  assert.match(podCredential, /chmod 600 "\$tmp"\s*\n\s*mv "\$tmp" "\$dest"/);
});

check('a pod with no credential yet still opens a terminal', () => {
  assert.match(podCredential, /no Rancher credential yet/);
  assert.match(podCredential, /exit 0/);
  assert.match(podShell, /rancher-credential\.sh "\$HOME_DIR" \|\| true/);
});

check('the shared claude login stays a property of the pod', () => {
  // It reads a Secret in dev-system, where the person who opened the panel may have no rights
  // at all - so it must not pick up the kubeconfig the credential step just wrote.
  assert.match(sharedLogin, /KUBECONFIG: '\/dev\/null'/);
});

check('the token is minted as the caller, and the old ones go after the new one lands', () => {
  // Norman's /v3/token, because it is the only route that answers with the secret half.
  assert.match(credentialSource, /rancherFetch\('\/v3\/token', \{\s*method: 'POST'/);
  assert.match(credentialSource, /ttl:/);
  // Order matters: a revoke that ran first would leave the agent with nothing if the write failed.
  const write = credentialSource.indexOf('await writeSecret(minted)');
  const revoke = credentialSource.indexOf('await revokeOthers(minted)');

  assert.ok(write > -1 && revoke > write, 'tokens are revoked before the new one is stored');
});

check('stale tokens are swept, and only this person\'s', () => {
  // Revoking just "the one the Secret used to hold" leaks: a mint whose write lost a race is a
  // token nothing has a record of, and it would live out its TTL in the person's key list.
  assert.match(credentialSource, /token\?\.description === TOKEN_DESCRIPTION/);
  assert.match(credentialSource, /token\?\.id !== minted\.id/);
  // An admin sees everybody's tokens, so an unscoped sweep would end a colleague's session.
  assert.match(credentialSource, /token\?\.userId === minted\.userId/);
});

check('the credential is in place before any pane starts', () => {
  // The pane reads the Secret on the way up, so a pane that started first would be the one
  // with no identity.
  const ensure = panelSource.indexOf('ensureAgentCredential()');
  const sessions = panelSource.indexOf('await agentSessions()');

  assert.ok(ensure > -1 && sessions > ensure, 'the conversations load before the credential is minted');
  // And it is not fatal: an agent with no Rancher identity can still hold a conversation.
  assert.match(panelSource, /ensureAgentCredential\(\)\.catch\(/);
});

check('the shared CLAUDE.md is refreshed, not frozen on the day the pod was made', () => {
  // Conversations share one directory, so the file belongs to none of them: written once, it
  // froze the guidance - which is how an agent went on reporting that the Studio API was closed
  // to it hours after it had been given a credential that opens it.
  assert.match(podShell, /\*\/conversations\) REFRESH_CLAUDE_MD=yes/);
  // And a directory one conversation has to itself still keeps its own copy.
  assert.match(podShell, /if \[ ! -f "\$WORKDIR\/CLAUDE\.md" \]; then\s*\n\s*REFRESH_CLAUDE_MD=yes/);
});

check('the extension trees are mounted, not reached for', () => {
  const spec = agent.agentDeploymentBody().spec.template.spec;
  const volume = spec.volumes.find((v) => v.name === 'extensions');
  const mount = spec.containers[0].volumeMounts.find((v) => v.name === 'extensions');

  assert.ok(volume, 'the agent pod does not mount the extension trees');

  // The parent of every extension's /app, so an extension made after this pod started is simply
  // there - a per-extension mount would mean restarting this pod, and ending every conversation
  // in it, every time somebody created one.
  assert.equal(volume.hostPath.path, '/var/lib/rancher/extension-studio');
  assert.equal(mount.mountPath, '/workspace/extensions');

  // Nested inside the workspace mount, which kubelet resolves by mounting in path order.
  const workspace = spec.containers[0].volumeMounts.find((v) => v.name === 'workspace');

  assert.ok(mount.mountPath.startsWith(`${ workspace.mountPath }/`));

  // Writable. This pod could already write into any of those trees over the exec subresource,
  // so read-only would buy nothing and cost the point of the mount.
  assert.ok(!mount.readOnly);
});

check('the agent is told where the trees are and what not to do with them', () => {
  const guide = seed['session-claude.md'];

  assert.match(guide, /\/workspace\/extensions\/<name>-extension\/?\s+is that pod's \/app/);
  // The one that would otherwise be found the expensive way.
  assert.match(guide, /Do not grep it whole/);
  assert.match(guide, /node_modules/);
});

check('the agent is pointed at what already knows how to edit an extension', () => {
  const guide = seed['session-claude.md'];

  // One call, rather than a round of probing per fact.
  assert.match(guide, /\/v1\/extensions\/base/);
  // The trap: an extension made from another is served out of the other one's directory.
  assert.match(guide, /tree.{0,40}is not .{0,20}app\/pkg/);
  assert.match(guide, /\/app\/pkg\/base/);
  // And the pod's own guide, which is the thing that stops the conventions being re-derived.
  assert.match(guide, /CLAUDE\.md/);
  assert.match(guide, /vue-cli-service serve. is watching/);
});

check('the detail route reports the tree rather than leaving it to be guessed', async() => {
  const { HANDLERS } = await import(path.join(POD, 'service', 'handlers.mjs'));

  assert.ok(HANDLERS.getExtension, 'getExtension is not wired up');

  const source = fs.readFileSync(path.join(POD, 'service', 'handlers.mjs'), 'utf8');

  // Read from the running pod, not worked out from the name and not from the seed: a tree that
  // has been renamed since it was created is an ordinary thing, and the seed cannot know.
  assert.match(source, /async function packaging\(cred, pod, seed\)/);
  assert.match(source, /ls -d \*\/ 2>\/dev\/null \| head -1/);
  // With the seed as the fallback for a pod that is not up, which is the old behaviour.
  assert.match(source, /\|\| seededDirectory\(seed\)/);
  assert.match(source, /bits\[0\] === 'pkg'/);
  assert.match(source, /tree:\s+`\/app\/pkg\/\$\{ directory \}`/);
  assert.match(source, /guide: `\/app\/pkg\/\$\{ directory \}\/CLAUDE\.md`/);
  // The container is a constant here and a guess anywhere else.
  assert.match(source, /container: EXT_CONTAINER/);
});

check('what the agent is told about authenticating is what is true', () => {
  const guide = seed['session-claude.md'];

  assert.match(guide, /~\/\.kube\/config/);
  assert.match(guide, /~\/\.rancher\/env/);
  assert.match(guide, /EXTENSION_STUDIO_API/);
  // The registry, which is the other half of "what can I reach".
  assert.match(guide, /\/v1\/apis/);
  // And the trap that costs an hour: the proxy eats the Authorization header.
  assert.match(guide, /consumes\s*(?:#\s*)?\n?\s*(?:#\s*)?the Authorization header/);
  // The old advice said the API was closed to it. It is not any more.
  assert.doesNotMatch(guide, /Everything else on it is closed to you/);
});

const overlaySource = fs.readFileSync(path.join(STUDIO, 'agent-overlay.ts'), 'utf8');

check('the row is Rancher\'s, down to the classes and the roles', () => {
  // Written out rather than imported, because Tabbed cannot carry a control on a tab: its label
  // is escaped text with no slot, and its one slot is after the whole list. What it can still
  // be is recognisably the same row.
  assert.match(panelSource, /class="tabs horizontal"/);
  assert.match(panelSource, /role="tablist"/);
  assert.match(panelSource, /\{ tab: true, active: session\.id === active \}/);
  assert.match(panelSource, /role="tab"/);
  assert.match(panelSource, /:aria-selected="session\.id === active"/);
  assert.match(panelSource, /:aria-controls="session\.id"/);
  assert.match(panelSource, /class="tab-list-footer"/);
  assert.match(panelSource, /role="tabpanel"/);
  // And its keyboard behaviour, which is the part a copied stylesheet would silently drop.
  assert.match(panelSource, /@keydown\.right\.prevent="selectNext\(1\)"/);
  assert.match(panelSource, /@keydown\.left\.prevent="selectNext\(-1\)"/);
  // The reason it is not the component, in the file, so the next reader does not assume this
  // was written out of ignorance.
  assert.match(panelSource, /Tabbed[\s\S]{0,600}cannot express/);
});

check('the controls are on each tab rather than at the end of the row', () => {
  // One edit and one close at the end of a row act on whichever tab is active, which means
  // selecting the third conversation before you can close it.
  const tabControls = panelSource.match(/mc-agent__tab-control/g) || [];

  assert.ok(tabControls.length >= 3, 'expected a rename and a close on the tab, and an add');
  assert.match(panelSource, /@click\.stop="startRename\(session\.id\)"/);
  assert.match(panelSource, /@click\.stop="closeSession\(session\.id\)"/);
});

check('the active tab is not accented', () => {
  // Rancher colours it var(--active) and underlines it. The underline and the weight stay; the
  // colour does not, because an accent on a terminal's chrome fights the terminal.
  const active = panelSource.slice(panelSource.indexOf('&.active {'));

  // An inset shadow rather than a border, so the underline takes no layout height and every
  // control on the bar sits on one line whether its tab is the active one or not.
  assert.match(active, /box-shadow: inset 0 -2px 0 var\(--body-text\)/);
  assert.match(active, /font-weight: 600/);
  assert.doesNotMatch(panelSource, /var\(--link\)|var\(--active,|var\(--primary\)/);
});

check('the panel has no close control; the chord is the whole dismissal story', () => {
  // The chord can replace a control that hides the panel. It cannot replace one that ends a
  // conversation, which is why the per-tab close stays.
  assert.doesNotMatch(panelSource, /Close the drawer|Close the agent/);
  assert.match(panelSource, /`End \$\{ session\.title \}/);
  // And the row ends with the options menu, in the place that control used to occupy.
  const footer = panelSource.slice(panelSource.indexOf('class="tab-list-footer"'));

  assert.ok(
    footer.indexOf('<SMenu') > footer.indexOf('Another conversation'),
    'the three-dot menu is not the last thing in the row',
  );
});

check('middle click closes a tab, and does not start Chromium\'s autoscroll', () => {
  assert.match(panelSource, /@auxclick="onAuxClick\(session\.id, \$event\)"/);
  assert.match(panelSource, /@mousedown="onAuxDown"/);
  // The press as well as the click: preventing only the click leaves the scroll cursor stuck
  // over the panel.
  assert.match(panelSource, /onAuxDown\(event\) \{[\s\S]{0,200}preventDefault\(\)/);
  assert.match(panelSource, /MIDDLE_BUTTON = 1/);
});

check('a conversation can be renamed, and the name goes to the pod', () => {
  assert.match(panelSource, /renameAgentSession/);
  assert.match(panelSource, /@dblclick\.prevent="startRename\(session\.id\)"/);
  // Not in the browser: a name kept here would be this browser's name for it, and the person
  // in the next tab would see the ordinal.
  assert.doesNotMatch(panelSource, /window\.localStorage/);
});

// ---------------------------------------------------------------------------
// Where the panel sits
// ---------------------------------------------------------------------------
console.log('\nwhere the panel sits');

const menuSource = fs.readFileSync(path.join(STUDIO, 'components', 'ui', 'SMenu.vue'), 'utf8');

check('three placements are offered, in the order a browser offers them', () => {
  const row = panelSource.slice(panelSource.indexOf('PLACEMENT_CHOICES'));
  const ids = [...row.matchAll(/id: '(window|left|bottom|right)'/g)].map((m) => m[1]);

  assert.deepEqual(ids, ['left', 'bottom', 'right']);
  // Icons, not words: this is the row devtools puts at the top of the same menu.
  assert.match(row, /icon: 'dockLeft'/);
});

check('the separate window is gone, not disabled', () => {
  // A control that is present and refuses is worse than one that was never offered, and code
  // that was reachable yesterday is the kind that gets rediscovered as a bug.
  const icons = fs.readFileSync(path.join(STUDIO, 'components', 'ui', 'SIcon.vue'), 'utf8');
  const drawerSource = fs.readFileSync(path.join(STUDIO, 'agent-drawer.ts'), 'utf8');

  // Identifiers, not prose: the comment that explains why it is gone is allowed to name it.
  assert.doesNotMatch(panelSource, /dockWindow/);
  assert.doesNotMatch(panelSource, /this\.floating|floating\(\)/);
  assert.doesNotMatch(panelSource, /onGrab\('move'|onGrab\('se'/);
  assert.doesNotMatch(panelSource, /mc-agent__bar|mc-agent--window/);
  assert.doesNotMatch(icons, /dockWindow/);
  // And the geometry it needed goes with it.
  assert.doesNotMatch(drawerSource, /^\s+x: number/m);
});

check('the row is a menu item rather than a popup of its own', () => {
  // SMenu was extended to carry it, rather than the panel drawing a second differently styled
  // menu beside SMenu's.
  assert.match(panelSource, /choices: PLACEMENT_CHOICES/);
  assert.match(menuSource, /item\.choices/);
  assert.match(menuSource, /role="menuitemradio"/);
  assert.match(menuSource, /:aria-checked="choice\.id === item\.value"/);
});

check('the menu is named as the place further options go', () => {
  assert.match(panelSource, /where further options go/);
});

check('every placement has exactly one thing that resizes', () => {
  // An icon that is present and does nothing was the thing to avoid; so was a placement that
  // renders and cannot be dragged.
  assert.match(panelSource, /placement === 'bottom'[\s\S]{0,200}onGrab\('n'/);
  assert.match(panelSource, /placement === 'left'[\s\S]{0,200}onGrab\('e'/);
  assert.match(panelSource, /onGrab\('w'/);
});

check('the panel takes its room from the dashboard rather than sitting on top of it', () => {
  // Twice now this has been reported as "the terminal overlays Rancher". Both times the panel
  // was drawn correctly and nothing had given up any room for it.
  assert.match(panelSource, /padding-bottom: \$\{ height \}px/);
  assert.match(panelSource, /padding-left: \$\{ width \}px/);
  assert.match(panelSource, /padding-right: \$\{ width \}px/);

  // On `.dashboard-root`, which every layout renders - not on the default layout's grid rows,
  // which `home.vue` and `plain.vue` do not have.
  assert.match(panelSource, /\.dashboard-root \{/);
  assert.doesNotMatch(panelSource, /style\.setProperty\('--wm/);
});

check('a closed panel reserves nothing, and neither does one that has gone away', () => {
  assert.match(panelSource, /if \(!this\.open\) \{\s*return '';/);
  assert.match(panelSource, /beforeUnmount\(\)[\s\S]{0,400}getElementById\(RESERVATION_ID\)\?\.remove\(\)/);
});

check('the overlay lets the dev server replace it', () => {
  // It is a plain module that registers a listener and mounts its own Vue app, so nothing else
  // in the graph accepts an update for it: without this a compiled change is simply not on the
  // page, and the dev server gets blamed for doing what it was asked.
  assert.match(overlaySource, /webpackHot/);
  assert.match(overlaySource, /hot\.accept\(\)/);
  assert.match(overlaySource, /hot\.dispose\(/);
  // And it hands back the room it had taken, or the gap outlives the panel that owned it.
  assert.match(overlaySource, /hot\.dispose\([\s\S]{0,900}mc-agent-reservation/);
});

check('a stored placement is validated, and an unknown one is the bottom', () => {
  const entries = installFakeStorage();

  drawer.writeDrawerState({
    open: true, active: 'agent-1', placement: 'left', geometry: { height: 300, width: 400 },
  });
  assert.equal(drawer.readDrawerState().placement, 'left');

  const key = [...entries.keys()][0];

  entries.set(key, '{"open":true,"placement":"ceiling"}');
  assert.equal(drawer.readDrawerState().placement, drawer.DEFAULT_PLACEMENT);
  assert.equal(drawer.DEFAULT_PLACEMENT, 'bottom');

  // The case that guard exists for: a browser where somebody chose the separate window before
  // it was taken out still has `window` in its storage.
  entries.set(key, '{"open":true,"placement":"window","active":"agent-1"}');
  assert.equal(drawer.readDrawerState().placement, 'bottom');
  assert.equal(drawer.readDrawerState().open, true, 'the rest of the record should survive');

  // And a geometry that is not numbers does not become a panel sized NaN.
  entries.set(key, '{"open":true,"placement":"right","geometry":{"width":"wide"}}');
  assert.ok(Number.isFinite(drawer.readDrawerState().geometry.width));
});

console.log(`\n${ pass } passed, ${ fail } failed`);
process.exit(fail ? 1 : 0);

/** A fetch answer, for the stub above. */
function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, json: async() => body };
}

/** How many store watchers are still live, since stopping one does not unlist it here. */
function liveWatchers() {
  return globalThis.__watchers.filter((entry) => entry.live).length;
}

/** Register the overlay from a clean slate, whatever the previous check left behind. */
function registerFresh() {
  overlay.registerAgentOverlay()();

  return overlay.registerAgentOverlay();
}

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
  globalThis.document.body.children.length = 0;
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

  // The store's `watch` is what the drawer restore hangs on, so it is real enough to fire:
  // every registered watcher is kept, and `settleAdmin` below runs them.
  globalThis.__watchers = [];
  globalThis.__store = {
    getters: {},
    watch(getter, cb) {
      const entry = { getter, cb, live: true };

      globalThis.__watchers.push(entry);

      return () => {
        entry.live = false;
      };
    },
  };

  const app = {
    __vue_app__: {
      _context: { components: {}, directives: { 'clean-tooltip': {} }, provides: { store: {} } },
      config:   { globalProperties: { $store: globalThis.__store, t: () => '' } },
    },
  };

  // `__mounted` here is the dashboard's own mount, not the panel's: a UIPlugin is evaluated
  // during the bootstrap, before `vueApp.mount('#app')`, so `#app.__vue_app__` is genuinely
  // absent for the first moment of every page load and the restore has to survive that.
  globalThis.__appMounted = true;

  globalThis.document = {
    cookie:        'CSRF=abc',
    body:          { children: [], appendChild(node) { this.children.push(node); } },
    createElement: () => panelHost,
    querySelector: (selector) => (selector === '#app' && globalThis.__appMounted ? app : null),
    getElementById: (id) => (panelHost.id === id ? panelHost : null),
  };

  installFakeStorage();

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

/** localStorage, which is allowed to be absent, empty, or to throw. */
function installFakeStorage({ throws = false } = {}) {
  const entries = new Map();

  globalThis.window.localStorage = {
    getItem(key) {
      if (throws) {
        throw new Error('storage is disabled for this origin');
      }

      return entries.has(key) ? entries.get(key) : null;
    },
    setItem(key, value) {
      if (throws) {
        throw new Error('storage is disabled for this origin');
      }

      entries.set(key, String(value));
    },
  };

  return entries;
}

/** Let every live store watcher see the admin answer it is waiting for. */
function settleAdmin(admin) {
  globalThis.__admin = admin;
  globalThis.__watchers.filter((entry) => entry.live).forEach((entry) => entry.cb(entry.getter()));
}
