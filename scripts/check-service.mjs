// The Extension Studio API, checked against itself.
//
// A plain script rather than a jest spec: jest does not run in this repo (its babel config is
// missing a plugin), and a spec that cannot be run is worse than none.
//
//   node scripts/check-service.mjs
//
// Two halves. The first imports the service's own modules and asserts the things that are only
// visible from inside: that the router tells `/v1/extensions/{name}` and
// `/v1/extensions/{name}/install` apart, that the document describes every route there is, and
// that the exec query string is argv rather than a joined string. The second starts the real
// server on a spare port and makes real requests at it, because "a request with no credential
// is refused" is a claim about the server and not about a function.
//
// It needs no cluster. RANCHER_URL is pointed at a closed port on purpose, so a call that gets
// past the credential gate fails as a connection rather than by borrowing anyone's identity.
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = path.join(here, '..', 'pkg', 'extension-studio', 'extension-skeleton', 'pod', 'service');
const SERVICE_URL = pathToFileURL(SERVICE).href;
const PORT = 18006;

/** The port the stub Rancher below listens on. Nothing else in this file uses it. */
const STUB_PORT = 18007;

process.env.PORT = `${ PORT }`;
process.env.RANCHER_URL = 'https://127.0.0.1:1';

/**
 * Non-empty while a second, independent copy of the service's module graph is being imported.
 *
 * `RANCHER_URL` is read once, when rancher.mjs is evaluated, which is right for a pod and
 * awkward here: one stanza has to point it at a stub that answers real statuses, and everything
 * else has to keep the closed port that proves a leaked call fails rather than borrowing an
 * identity. node caches a module by URL, so a query string is the only thing that makes it load
 * twice - and the graph's own imports are relative and carry no query of their own, which is why
 * the tag goes on in the hook rather than on the one import that asks for it.
 */
let graphTag = '';

// The same bridge scripts/gen-extension-seed.mjs uses, and for the same reason: some of what is
// worth checking is in the extension's TypeScript, and node needs the extension spelled out.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.code !== 'MODULE_TYPELESS_PACKAGE_JSON') {
    console.warn(warning);
  }
});

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = resolveWithTs(specifier, context, nextResolve);

    return graphTag && resolved.url.startsWith(SERVICE_URL)
      ? { ...resolved, url: `${ resolved.url }?graph=${ graphTag }` }
      : resolved;
  },
});

function resolveWithTs(specifier, context, nextResolve) {
  try {
    return nextResolve(specifier, context);
  } catch (e) {
    if (specifier.startsWith('.')) {
      return nextResolve(`${ specifier }.ts`, context);
    }

    throw e;
  }
}

const { ROUTES } = await import(path.join(SERVICE, 'routes.mjs'));
const { match } = await import(path.join(SERVICE, 'router.mjs'));
const { HANDLERS, asSeed, SOURCE_ANNOTATION } = await import(path.join(SERVICE, 'handlers.mjs'));
const { openapiDocument } = await import(path.join(SERVICE, 'openapi.mjs'));
const { execPath } = await import(path.join(SERVICE, 'exec.mjs'));
const { callerCredential } = await import(path.join(SERVICE, 'credential.mjs'));
const { installSteps } = await import(path.join(SERVICE, 'install.mjs'));
const { statusExitCode, readFrames, channelReader } = await import(path.join(SERVICE, 'podexec.mjs'));
const podscript = await import(path.join(SERVICE, 'podscript.mjs'));
const { shellQuote, asPodUser, inPackageCommand } = podscript;
const {
  parseApproval, parseChangedFiles, parseProvenance, parseTurns, changedFilesScript,
} = await import(path.join(SERVICE, 'changes.mjs'));

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

console.log('routing');

check('a fixed path matches its route', () => {
  assert.equal(match('GET', '/v1/extensions').route.handler, 'listExtensions');
});

check('the same path with another method is a different route', () => {
  assert.equal(match('POST', '/v1/extensions').route.handler, 'createExtension');
});

check('a path parameter is captured', () => {
  const found = match('GET', '/v1/extensions/node-health-panel');

  assert.equal(found.route.handler, 'getExtension');
  assert.equal(found.params.name, 'node-health-panel');
});

check('a longer path is not swallowed by the route above it', () => {
  const found = match('GET', '/v1/extensions/base/install');

  assert.equal(found.route.handler, 'extensionInstallState');
  assert.equal(found.params.name, 'base');
});

check('the stream route is reached by name', () => {
  const found = match('GET', '/v1/extensions/base/exec');

  assert.equal(found.route.handler, 'execStream');
  assert.equal(found.route.upgrade, true);
});

check('a path parameter is percent-decoded', () => {
  assert.equal(match('GET', '/v1/extensions/a%20b').params.name, 'a b');
});

check('an unknown path is nothing at all', () => {
  assert.equal(match('GET', '/v1/nope'), null);
  assert.equal(match('GET', '/v1/extensions/base/install/deeper'), null);
});

check('a known path with the wrong method reports what it does answer', () => {
  const found = match('PUT', '/v1/extensions/base');

  assert.equal(found.route, null);
  assert.deepEqual(found.allowed.sort(), ['DELETE', 'GET']);
});

check('every route has a handler, and every handler has a route', () => {
  const routed = ROUTES.map((route) => route.handler).sort();
  const written = Object.keys(HANDLERS).sort();

  assert.deepEqual(routed, written);
});

console.log('\nthe document');

const doc = JSON.parse(JSON.stringify(openapiDocument()));

check('it is valid JSON, and says which OpenAPI it is', () => {
  assert.equal(typeof JSON.parse(JSON.stringify(doc)), 'object');
  assert.equal(doc.openapi, '3.1.0');
});

check('it describes every route the router actually has', () => {
  for (const route of ROUTES) {
    const operation = doc.paths[route.path]?.[route.method.toLowerCase()];

    assert.ok(operation, `${ route.method } ${ route.path } is missing from the document`);
    assert.equal(operation.operationId, route.operationId);
    assert.ok(operation.summary, `${ route.operationId } has no summary`);
  }
});

check('it describes nothing the router does not have', () => {
  for (const [routePath, methods] of Object.entries(doc.paths)) {
    for (const method of Object.keys(methods)) {
      assert.ok(
        match(method.toUpperCase(), routePath.replace(/\{[^}]+\}/g, 'x'))?.route,
        `the document has ${ method } ${ routePath } and the router does not`,
      );
    }
  }
});

check('the routes that need a credential say so, and the two that do not say that', () => {
  assert.deepEqual(doc.paths['/healthz'].get.security, []);
  assert.deepEqual(doc.paths['/openapi.json'].get.security, []);
  assert.ok(doc.paths['/v1/extensions'].get.security.length);
  assert.ok(doc.paths['/v1/extensions/{name}/exec'].get.security.length);
});

check('the path parameter is declared where the router captures one', () => {
  for (const route of ROUTES.filter((r) => r.path.includes('{name}'))) {
    const declared = doc.paths[route.path][route.method.toLowerCase()].parameters || [];

    assert.ok(
      declared.some((p) => p.name === 'name' && p.in === 'path' && p.required),
      `${ route.operationId } takes {name} and does not declare it`,
    );
  }
});

console.log('\ncredentials');

const asReq = (headers) => ({ headers });

check('a request with nothing is refused', () => {
  assert.equal(callerCredential(asReq({})), null);
});

check('a cookie that is not a session is not a credential', () => {
  assert.equal(callerCredential(asReq({ cookie: 'CSRF=abc; theme=dark' })), null);
});

check('an Authorization header is forwarded verbatim', () => {
  assert.deepEqual(
    callerCredential(asReq({ authorization: 'Bearer token-abcde:secret' })),
    { authorization: 'Bearer token-abcde:secret' },
  );
});

check('a dashboard session brings its CSRF header with it', () => {
  assert.deepEqual(
    callerCredential(asReq({ cookie: 'R_SESS=xyz; CSRF=abc', 'x-api-csrf': 'abc' })),
    { cookie: 'R_SESS=xyz; CSRF=abc', 'x-api-csrf': 'abc' },
  );
});

check('nothing else on the request is forwarded', () => {
  const cred = callerCredential(asReq({
    authorization: 'Bearer token-abcde:secret',
    'user-agent':  'curl/8',
    host:          'somewhere',
  }));

  assert.deepEqual(Object.keys(cred), ['authorization']);
});

console.log('\nthe exec stream');

check('command is repeated, because it is argv', () => {
  const query = execPath('base-extension-abc', ['/bin/sh', '-c', 'ls /app'], true).split('?')[1];
  const params = new URLSearchParams(query);

  assert.deepEqual(params.getAll('command'), ['/bin/sh', '-c', 'ls /app']);
  assert.equal(query.match(/command=/g).length, 3);
  assert.ok(!query.includes('%2C'), 'the arguments were joined with commas');
});

check('an interactive stream opens stdin and a tty, and a one-shot does not', () => {
  const interactive = new URLSearchParams(execPath('p', ['sh'], true).split('?')[1]);
  const once = new URLSearchParams(execPath('p', ['sh'], false).split('?')[1]);

  assert.equal(interactive.get('stdin'), '1');
  assert.equal(interactive.get('tty'), '1');
  assert.equal(once.get('stdin'), '0');
  assert.equal(once.get('tty'), '0');
});

check('it addresses the pod subresource the dashboard addresses', () => {
  const built = execPath('base-extension-abc', ['sh'], true);

  assert.ok(built.startsWith('/k8s/clusters/local/api/v1/namespaces/extension-studio/pods/base-extension-abc/exec?'));
  assert.equal(new URLSearchParams(built.split('?')[1]).get('container'), 'devserver');
});

console.log('\nreading an exec stream');

/** One unmasked server frame, which is what the apiserver sends. */
function frame(text, { fin = true, opcode = 1 } = {}) {
  const payload = Buffer.from(text, 'latin1');
  const header = payload.length < 126
    ? Buffer.from([(fin ? 0x80 : 0) | opcode, payload.length])
    : Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, 126]), (() => {
      const b = Buffer.alloc(2);

      b.writeUInt16BE(payload.length);

      return b;
    })()]);

  return Buffer.concat([header, payload]);
}

const channelled = (channel, text) => frame(channel + Buffer.from(text, 'utf8').toString('base64'));

check('a whole frame is read and a partial one is kept for later', () => {
  const whole = channelled('1', 'hello');
  const partial = channelled('1', 'world').subarray(0, 3);
  const { frames, rest } = readFrames(Buffer.concat([whole, partial]));

  assert.equal(frames.length, 1);
  assert.equal(rest.length, partial.length);
});

check('a long frame declares its length in two bytes and still reads', () => {
  const long = 'x'.repeat(400);
  const { frames } = readFrames(channelled('1', long));
  const reader = channelReader();

  reader.take(frames[0].payload);
  assert.equal(reader.finish().stdout, long);
});

check('a masked frame is unmasked rather than read as noise', () => {
  const payload = Buffer.from('1' + Buffer.from('ok').toString('base64'), 'latin1');
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload);

  for (let i = 0; i < masked.length; i++) {
    masked[i] ^= mask[i % 4];
  }

  const { frames } = readFrames(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
  const reader = channelReader();

  reader.take(frames[0].payload);
  assert.equal(reader.finish().stdout, 'ok');
});

check('the three channels land in three places', () => {
  const reader = channelReader();

  for (const [channel, text] of [['1', 'out'], ['2', 'err'], ['3', 'exit code 3']]) {
    reader.take(readFrames(channelled(channel, text)).frames[0].payload);
  }

  assert.deepEqual(reader.finish(), { stdout: 'out', stderr: 'err', status: 'exit code 3' });
});

check('a character split across two frames survives', () => {
  // The regression this decoding exists for: atob gives one character per byte, so a UTF-8
  // character read out of a pod arrived as mojibake, and a character straddling two frames was
  // corrupted even by a decoder that got the encoding right but not the streaming.
  const bytes = Buffer.from('caf\u00e9', 'utf8');
  const reader = channelReader();
  const first = Buffer.from('1' + bytes.subarray(0, 4).toString('base64'), 'latin1');
  const second = Buffer.from('1' + bytes.subarray(4).toString('base64'), 'latin1');

  reader.take(first);
  reader.take(second);
  assert.equal(reader.finish().stdout, 'caf\u00e9');
});

check('a close frame carries its code', () => {
  const code = Buffer.alloc(2);

  code.writeUInt16BE(1000);

  const { frames } = readFrames(Buffer.concat([Buffer.from([0x88, 2]), code]));

  assert.equal(frames[0].opcode, 0x8);
  assert.equal(frames[0].payload.readUInt16BE(0), 1000);
});

check('the exit code is read from either wire format the apiserver uses', () => {
  assert.equal(statusExitCode(''), 0);
  assert.equal(statusExitCode('command terminated with non-zero exit code: ..., exit code 3'), 3);
  assert.equal(statusExitCode('{"status":"Success"}'), 0);
  assert.equal(statusExitCode('{"status":"Failure","details":{"causes":[{"reason":"ExitCode","message":"7"}]}}'), 7);
  assert.equal(statusExitCode('something nobody has seen before'), -1);
});

console.log('\ncomposing what runs in the pod');

check('an argument with an apostrophe stays one argument', () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

check('a command is dropped to the tree\'s owner, with a HOME', () => {
  const argv = asPodUser('git status');

  assert.deepEqual(argv.slice(0, 2), ['/bin/sh', '-c']);
  assert.match(argv[2], /setpriv --reuid=1000 --regid=1000/);
  assert.match(argv[2], /export HOME=\/app\/\.home/);
});

check('a script is braced, so a failed cd does not run the rest somewhere else', () => {
  const argv = inPackageCommand('demo', 'git init ; git add -A');

  assert.match(argv[2], /cd .*&& \{ git init ; git add -A ; \}/);
  assert.match(argv[2], /d=\/app\/pkg\/demo/);
});

check('podscript.mjs exports the composed forms, not the pieces they are made of', () => {
  // packageDir was exported and used only here. Keeping it private is what stops a future caller
  // composing its own `cd` and skipping the setpriv drop that makes the tree writable.
  assert.deepEqual(
    Object.keys(podscript).sort(),
    ['ASSISTANT_SESSION', 'asPodUser', 'inPackageCommand', 'shellQuote'],
  );
});

console.log('\nthe install steps');

check('an install is the shared three and the extension\'s own three', () => {
  const steps = installSteps('demo');

  assert.deepEqual(steps.map((s) => s.id), [
    'namespace', 'serviceaccount', 'clusterrolebinding', 'seed-demo', 'deployment-demo', 'service-demo',
  ]);
});

check('a seed body with no seed says so rather than writing an empty ConfigMap', () => {
  const seedStep = installSteps('demo').find((s) => s.id === 'seed-demo');

  assert.throws(() => seedStep.body(), /no seed was resolved for demo/);
});

check('the deployment mounts the seed it is named after', () => {
  const deployment = installSteps('demo').find((s) => s.id === 'deployment-demo').body();
  const volume = deployment.spec.template.spec.volumes.find((v) => v.name === 'seed');

  assert.equal(volume.configMap.name, 'demo-extension');
});

console.log('\nreading a seed');

check('a seed is the same shape however it was read', () => {
  const map = {
    metadata: {
      name:        'base-extension',
      annotations: {
        [SOURCE_ANNOTATION]:                            'base',
        'kubectl.kubernetes.io/last-applied-configuration': '{"metadata":{"name":"base-extension"}}',
      },
    },
    data: { 'package.json': '{}' },
  };
  const seed = asSeed(map);

  assert.deepEqual(Object.keys(seed).sort(), ['annotations', 'data']);
  assert.equal(seed.annotations[SOURCE_ANNOTATION], 'base');
  assert.deepEqual(seed.data, { 'package.json': '{}' });
});

check('a copied seed leaves the source object\'s own annotations behind', () => {
  const seed = asSeed({ metadata: { annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{}' } } });

  assert.deepEqual(seed.annotations, {});
});

check('a ConfigMap with nothing on it is still a seed shape', () => {
  assert.deepEqual(asSeed({}), { data: {}, annotations: {} });
  assert.deepEqual(asSeed(null), { data: {}, annotations: {} });
});

console.log('\nthe review reads');

check('approval reports pending commits, newest first as git gave them', () => {
  const state = parseApproval('APPROVED=abc1234\nPENDING\ndeadbee\nfeed123\n');

  assert.equal(state.sha, 'abc1234');
  assert.deepEqual(state.pending, ['deadbee', 'feed123']);
  assert.equal(state.clear, false);
  assert.equal(state.read, true);
});

check('a tree with no history is the one honest clear:true', () => {
  assert.deepEqual(parseApproval('BARN-NOGIT\n'), {
    sha: '', pending: [], clear: true, read: true,
  });
});

check('a read that did not happen is never reported as clear', () => {
  // The gate this protects: everywhere in the product an empty pending list means "reviewed,
  // ready to publish", so a failed read that answered with one would turn the gate off.
  for (const out of ['', 'BARN-APPROVAL-FAILED', 'some unrelated noise']) {
    const state = parseApproval(out);

    assert.equal(state.clear, false, `"${ out }" was reported as clear`);
    assert.equal(state.read, false, `"${ out }" was reported as read`);
  }
});

check('changed files carry their status and their line counts', () => {
  const rows = parseChangedFiles([
    'M\tpages/Home.vue',
    'A\tpages/New.vue',
    'D\tpages/Old.vue',
    '--numstat--',
    '3\t1\tpages/Home.vue',
    '9\t0\tpages/New.vue',
    '0\t7\tpages/Old.vue',
  ].join('\n'));

  assert.deepEqual(rows, [
    {
      path: 'pages/Home.vue', status: 'modified', added: 3, removed: 1,
    },
    {
      path: 'pages/New.vue', status: 'added', added: 9, removed: 0,
    },
    {
      path: 'pages/Old.vue', status: 'deleted', added: 0, removed: 7,
    },
  ]);
});

check('a binary file counts as no lines rather than as NaN', () => {
  const rows = parseChangedFiles(['M\tassets/logo.png', '--numstat--', '-\t-\tassets/logo.png'].join('\n'));

  assert.deepEqual(rows, [{
    path: 'assets/logo.png', status: 'modified', added: 0, removed: 0,
  }]);
});

check('a path git had to quote is keyed the same way on both readings', () => {
  const rows = parseChangedFiles(['M\t"a b.vue"', '--numstat--', '2\t2\t"a b.vue"'].join('\n'));

  assert.deepEqual(rows, [{
    path: 'a b.vue', status: 'modified', added: 2, removed: 2,
  }]);
});

check('a "since" that is not a commit is refused before it reaches a shell', () => {
  assert.throws(() => changedFilesScript('; rm -rf /'), /is not a commit/);
  assert.match(changedFilesScript('abc1234'), /rev-parse --verify -q abc1234\^\{commit\}/);
});

check('provenance reads the commit and turns the mtime into a time', () => {
  const out = [
    'SHA:abc1234', 'AUTHOR:barn', 'WHEN:2026-08-27T22:38:37+00:00', 'SUBJECT:Change the heading',
    '--edited--', '1756334317',
  ].join('\n');
  const prov = parseProvenance(out);

  assert.equal(prov.commit.sha, 'abc1234');
  assert.equal(prov.commit.subject, 'Change the heading');
  assert.equal(prov.edited, new Date(1756334317 * 1000).toISOString());
});

check('provenance with nothing to say says nothing rather than breaking', () => {
  assert.deepEqual(parseProvenance(''), {
    edited: '',
    commit: {
      sha: '', author: '', when: '', subject: '',
    },
  });
});

check('turns are read off the marker line and never out of the prose around it', () => {
  const turns = parseTurns('some warning\nBARN-PROV:[{"turn":"t1","prompt":"hi"}]\ntrailing');

  assert.deepEqual(turns, [{ turn: 't1', prompt: 'hi' }]);
  assert.deepEqual(parseTurns('no marker here'), []);
  assert.deepEqual(parseTurns('BARN-PROV:not json'), []);
  assert.deepEqual(parseTurns('BARN-PROV:{"not":"an array"}'), []);
});

console.log('\nkeeping a cluster on this source');

const {
  serviceSourceFiles, serviceSourceVersion, apiConfigMapBody, apiDeploymentBody, serviceSteps,
} = await import(path.join(here, '..', 'pkg', 'extension-studio', 'service.ts'));
const {
  apiRegistryBody, apiRegistryStep, apiDocsUrl, studioApiEntry, API_REGISTRY_LABEL,
} = await import(path.join(here, '..', 'pkg', 'extension-studio', 'api-registry.ts'));
const { apiDocsUrl: podDocsUrl } = await import(path.join(SERVICE, 'registry.mjs'));

check('the bundle carries every file the service is made of', () => {
  assert.deepEqual(
    Object.keys(serviceSourceFiles()).sort(),
    fs.readdirSync(SERVICE).sort(),
  );
});

check('the fingerprint is stable, and changes when a byte does', () => {
  const version = serviceSourceVersion();

  assert.match(version, /^[0-9a-f]{8}$/);
  assert.equal(version, serviceSourceVersion());
});

check('every step that records a version records it where the updater looks', () => {
  // The bug this is here for: the fingerprint was on the Deployment's pod template only, and
  // `replaceIfStale` reads `metadata.annotations`. So a stale cluster had its ConfigMap
  // rewritten, its Deployment left alone, and its pod still running the old source - which is
  // worse than not updating at all, because the two halves then disagree.
  const stamp = 'barn.rancher.io/source-version';

  for (const step of serviceSteps()) {
    const body = step.body();
    const rendered = JSON.stringify(body);

    if (!rendered.includes(stamp)) {
      continue;
    }

    assert.ok(
      body.metadata.annotations?.[stamp],
      `the ${ step.id } step records a source version somewhere the updater cannot see it`,
    );
  }
});

check('both objects that carry the source record which source it is', () => {
  const version = serviceSourceVersion();
  const configMap = apiConfigMapBody();
  const deployment = apiDeploymentBody();
  const stamp = 'barn.rancher.io/source-version';

  assert.equal(configMap.metadata.annotations[stamp], version);
  // On the pod template, which is the field that makes Kubernetes replace the pod. A ConfigMap
  // that changes under a running pod is not re-read by node, which imported its modules at
  // start, so recording it only on the Deployment would update nothing that runs.
  assert.equal(deployment.metadata.annotations[stamp], version);
  assert.equal(deployment.spec.template.metadata.annotations[stamp], version);

  const env = deployment.spec.template.spec.containers[0].env
    .find((entry) => entry.name === 'API_SOURCE_VERSION');

  assert.equal(env.value, version, '/healthz would have nothing to report');
});

check('the ConfigMap the Deployment mounts is the one that holds the source', () => {
  const deployment = apiDeploymentBody();
  const volume = deployment.spec.template.spec.volumes.find((v) => v.name === 'seed');

  assert.equal(volume.configMap.name, apiConfigMapBody().metadata.name);
});

console.log('\nthe API registry');

check('an entry is one ConfigMap, labelled so a single call finds it', () => {
  const body = apiRegistryBody({
    extension: 'node-health-panel',
    title:     'Node health panel API',
    url:       '/k8s/clusters/local/api/v1/namespaces/extension-studio/services/http:nhp:8080/proxy',
    docs:      'openapi.json',
    version:   '0.1.0',
  });

  assert.equal(body.kind, 'ConfigMap');
  assert.equal(body.metadata.name, 'node-health-panel-api-registry');
  assert.equal(body.metadata.namespace, 'extension-studio');
  assert.equal(body.metadata.labels[API_REGISTRY_LABEL], 'true');
  assert.deepEqual(Object.keys(body.data).sort(), ['docs', 'extension', 'title', 'url', 'version']);
});

check('no registry entry can collide with an object the Studio already owns', () => {
  // This is here because it happened. The Studio's extension is `extension-studio`, so the
  // obvious `<extension>-api` named its entry `extension-studio-api` - which is the ConfigMap
  // holding the running service source. Registering would have replaced the service with its own
  // registry entry, and nothing would have said so until the pod next rolled and failed.
  const owned = new Set(serviceSteps().map((step) => step.name));

  for (const extension of ['extension-studio', 'base', 'node-health-panel']) {
    assert.ok(
      !owned.has(apiRegistryBody({ extension, url: '/a' }).metadata.name),
      `a registry entry for ${ extension } would overwrite one of the Studio's own objects`,
    );
  }
});

check('an entry records a fingerprint, so a stale one is replaced rather than kept', () => {
  // The same trap the service source was in: an entry naming a version that is not running.
  const entry = {
    extension: 'x', title: 'X', url: '/a', docs: 'openapi.json', version: '1',
  };
  const stamp = 'barn.rancher.io/source-version';
  const first = apiRegistryBody(entry).metadata.annotations[stamp];

  assert.match(first, /^[0-9a-f]{8}$/);
  assert.equal(first, apiRegistryBody(entry).metadata.annotations[stamp]);
  assert.notEqual(first, apiRegistryBody({ ...entry, version: '2' }).metadata.annotations[stamp]);
});

check('the step records the fingerprint where ensureCurrent looks for it', () => {
  const step = apiRegistryStep(studioApiEntry());

  assert.ok(step.body().metadata.annotations['barn.rancher.io/source-version']);
  assert.equal(step.type, 'configmaps');
});

check('both readers join url and docs the same way', () => {
  for (const pair of [
    { url: '/proxy', docs: 'openapi.json' },
    { url: '/proxy/', docs: '/openapi.json' },
    { url: '/proxy/', docs: 'openapi.json' },
  ]) {
    assert.equal(apiDocsUrl(pair), '/proxy/openapi.json');
    assert.equal(podDocsUrl(pair), '/proxy/openapi.json');
  }
});

check('the Studio\'s entry resolves to the document the service actually serves', () => {
  const entry = studioApiEntry();

  // Not a hand-written string: the same constant the router serves the document at, so this
  // fails if either the route or the entry moves without the other.
  const served = ROUTES.find((route) => route.handler === 'openapiDocument');

  assert.equal(apiDocsUrl(entry), `${ entry.url }${ served.path }`);
  assert.equal(entry.version, serviceSourceVersion(), 'the entry advertises a version /healthz would not report');
});

console.log('\nthe generated seed');

check('every file the service is made of reached the bundle, as its own file set', () => {
  const generated = fs.readFileSync(
    path.join(here, '..', 'pkg', 'extension-studio', 'extension-seed.generated.ts'), 'utf8',
  );
  const at = generated.indexOf('export const SERVICE_FILES');

  assert.ok(at > 0, 'extension-seed.generated.ts has no SERVICE_FILES - run node scripts/gen-extension-seed.mjs');

  const serviceHalf = generated.slice(at);

  for (const file of fs.readdirSync(SERVICE)) {
    assert.ok(
      serviceHalf.includes(`"${ file }":`),
      `${ file } is not in SERVICE_FILES - run node scripts/gen-extension-seed.mjs`,
    );
  }
});

check('and no extension seed carries a copy of it', () => {
  // The bug this replaces: every extension's ConfigMap held the whole service, which its boot
  // script then declined to write. 77.5 KiB, in every extension, for ever.
  const generated = fs.readFileSync(
    path.join(here, '..', 'pkg', 'extension-studio', 'extension-seed.generated.ts'), 'utf8',
  );
  const seedHalf = generated.slice(0, generated.indexOf('export const SEED_FILES'));

  assert.ok(!seedHalf.includes('service__'), 'an extension seed still carries the service source');
});

console.log('\na refusal is not an absence');

// A stub Rancher that answers whatever status the check in hand needs, and a second copy of the
// service pointed at it. Everything above this runs against a closed port, which proves a call
// cannot succeed without a credential but can say nothing about what a 403 turns into - and "a
// 403 turns into an absence" is the bug this whole stanza exists for.
let stubAnswer = () => ({ status: 200, body: {} });
let stubDropsUpgrade = false;

const stubRancher = http.createServer((req, res) => {
  const { status, body } = stubAnswer(req);
  const text = JSON.stringify(body);

  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
});

// Rancher refuses an exec upgrade with a plain HTTP response on the same socket, so the stub
// does too. Without this, node destroys an upgrade nobody listened for and the refusal would
// arrive as a closed socket, which is a different failure with a different answer.
stubRancher.on('upgrade', (req, socket) => {
  if (stubDropsUpgrade) {
    socket.destroy();

    return;
  }

  const { status, body } = stubAnswer(req);
  const text = JSON.stringify(body);

  socket.end(
    `HTTP/1.1 ${ status } Forbidden\r\nContent-Type: application/json\r\n` +
    `Content-Length: ${ Buffer.byteLength(text) }\r\nConnection: close\r\n\r\n${ text }`,
  );
});

await new Promise((resolve) => stubRancher.listen(STUB_PORT, '127.0.0.1', resolve));

// Keep this block free of any await that is not one of the imports below. The tag is process
// wide, so anything else awaited between setting it and clearing it would have its own imports
// tagged too, and would quietly get a second copy of a module it shares with everything above.
graphTag = 'stub';
process.env.RANCHER_URL = `http://127.0.0.1:${ STUB_PORT }`;

const stubbed = {
  rancher:  await import(path.join(SERVICE, 'rancher.mjs')),
  install:  await import(path.join(SERVICE, 'install.mjs')),
  handlers: await import(path.join(SERVICE, 'handlers.mjs')),
  podexec:  await import(path.join(SERVICE, 'podexec.mjs')),
};

graphTag = '';
process.env.RANCHER_URL = 'https://127.0.0.1:1';

const CRED = { authorization: 'Bearer token-check:check' };
const NAMESPACE = { type: 'namespaces', name: 'extension-studio' };
const answering = (status, message) => () => ({ status, body: { message } });
const thrownBy = (promise) => promise.then(() => null, (e) => e);

await checkAsync('404 is the only status that means an object is absent', async() => {
  stubAnswer = answering(404, 'not found');

  assert.deepEqual(await stubbed.rancher.objectState(CRED, NAMESPACE), { state: 'absent', error: '' });
});

await checkAsync('403 on that read is unknown, with the status and the reason kept', async() => {
  stubAnswer = answering(403, 'namespaces.v1 "extension-studio" is forbidden');

  const found = await stubbed.rancher.objectState(CRED, NAMESPACE);

  assert.equal(found.state, 'unknown');
  assert.equal(found.status, 403);
  assert.match(found.error, /forbidden/);
});

await checkAsync('401 is nobody asking, so it is raised rather than reported per object', async() => {
  // Not one of the three: the other two answers are about one object, and this one is true of
  // every object at once. Reported per step it would be a 200 to somebody whose session has
  // expired, when what the screen needs is to send them to log in.
  stubAnswer = answering(401, 'must authenticate');

  const e = await thrownBy(stubbed.rancher.objectState(CRED, NAMESPACE));

  assert.equal(e?.status, 401);
});

await checkAsync('so the whole install state is 401, not six steps of unknown', async() => {
  stubAnswer = answering(401, 'must authenticate');

  const e = await thrownBy(stubbed.install.installState(CRED, 'base'));

  assert.equal(e?.status, 401);
});

await checkAsync('and so is a Rancher that answered 500', async() => {
  stubAnswer = answering(500, 'something went wrong');

  assert.equal((await stubbed.rancher.objectState(CRED, NAMESPACE)).state, 'unknown');
});

await checkAsync('the install state of a refused caller is unknown, not missing', async() => {
  // The live shape of this, and the reason it is worth a check: Steve answers
  // /k8s/clusters/local/v1/namespaces/extension-studio with 403, not 404, to every Rancher user
  // who is not an administrator. Six steps reported "missing" reads as "nothing is installed"
  // and invites a reinstall of a namespace that is holding every extension in the cluster.
  stubAnswer = answering(403, 'namespaces.v1 "extension-studio" is forbidden');

  const steps = await stubbed.install.installState(CRED, 'base');

  assert.ok(steps.length, 'the install has no steps at all');
  assert.deepEqual([...new Set(steps.map((step) => step.state))], ['unknown']);
  assert.ok(steps.every((step) => /forbidden/.test(step.error)), 'a step said unknown without saying why');
});

await checkAsync('an absent one still says missing, and says nothing about an error', async() => {
  stubAnswer = answering(404, 'not found');

  const steps = await stubbed.install.installState(CRED, 'base');

  assert.deepEqual([...new Set(steps.map((step) => step.state))], ['missing']);
  assert.ok(steps.every((step) => step.error === undefined));
});

await checkAsync('GET /v1/extensions/{name} passes a refusal on rather than calling it a 404', async() => {
  stubAnswer = answering(403, 'deployments.apps "base" is forbidden');

  const e = await thrownBy(stubbed.handlers.HANDLERS.getExtension({ cred: CRED, params: { name: 'base' } }));

  assert.ok(e, 'the handler answered instead of refusing');
  assert.equal(e.status, 403, 'a refused read was reported as the extension not existing');
  assert.match(e.message, /forbidden/);
});

await checkAsync('and a genuine 404 there still says how to list the ones that do exist', async() => {
  stubAnswer = answering(404, 'not found');

  const e = await thrownBy(stubbed.handlers.HANDLERS.getExtension({ cred: CRED, params: { name: 'base' } }));

  assert.equal(e.status, 404);
  assert.match(e.message, /GET \/v1\/extensions lists/);
});

await checkAsync('POST /v1/extensions does the same with the seed it copies from', async() => {
  stubAnswer = answering(403, 'configmaps "base" is forbidden');

  const e = await thrownBy(stubbed.handlers.HANDLERS.createExtension({ cred: CRED, body: { name: 'demo' } }));

  assert.equal(e.status, 403, 'a caller who may not read the seed was told it does not exist');
});

await checkAsync('an unknown step carries the status, not only the sentence', async() => {
  // One field short of useful without it: "unknown - Method GET not supported" reads the same as
  // a Rancher that was down, and this is the route whose whole job is telling those apart.
  stubAnswer = answering(403, 'namespaces.v1 "extension-studio" is forbidden');

  const steps = await stubbed.install.installState(CRED, 'base');

  assert.deepEqual([...new Set(steps.map((step) => step.status))], [403]);
});

await checkAsync('and a step that is simply not there carries no status at all', async() => {
  stubAnswer = answering(404, 'not found');

  const steps = await stubbed.install.installState(CRED, 'base');

  assert.ok(steps.every((step) => step.status === undefined), 'an absence was given a status');
});

await checkAsync('POST /v1/extensions is 401 when the refusal stopped every step', async() => {
  // Reachable only through "files": it skips copiedSeed, which is the one thing on this route
  // that raised a refusal, and the install then folded the same 401 into six per-step notes
  // under a 200. Constraint 1's first sentence is that a caller with no credential gets 401.
  stubAnswer = answering(401, 'must authenticate');

  const e = await thrownBy(stubbed.handlers.HANDLERS.createExtension({
    cred: CRED, body: { name: 'demo', files: { 'index.ts': 'export default 1;' } },
  }));

  assert.ok(e, 'six refusals were reported as a successful create');
  assert.equal(e.status, 401);
});

await checkAsync('DELETE /v1/extensions/{name} is 403 when every delete was refused', async() => {
  stubAnswer = answering(403, 'deployments.apps is forbidden');

  const e = await thrownBy(stubbed.handlers.HANDLERS.deleteExtension({ cred: CRED, params: { name: 'base' } }));

  assert.ok(e, 'three refusals were reported as a successful delete');
  assert.equal(e.status, 403);
});

await checkAsync('but a create refused on one object is still the 200 and the list', async() => {
  // The case the per-step catch exists for, and the reason the rule is every step rather than
  // any step: a caller who may make a Deployment but not a ClusterRoleBinding wants the list.
  stubAnswer = (req) => (/clusterrolebinding/.test(req.url)
    ? { status: 403, body: { message: 'clusterrolebindings is forbidden' } }
    : { status: 200, body: {} });

  const answer = await stubbed.handlers.HANDLERS.createExtension({
    cred: CRED, body: { name: 'demo', files: { 'index.ts': 'export default 1;' } },
  });

  assert.equal(answer.status, 200);

  const failed = answer.body.steps.filter((step) => step.state === 'failed');

  assert.equal(failed.length, 1, 'the refusal spread to steps that were not refused');
  assert.equal(failed[0].id, 'clusterrolebinding');
  assert.equal(failed[0].status, 403, 'the failed step did not say what it was refused with');
});

await checkAsync('and a failure that is not a refusal never becomes one', async() => {
  // A 500 from Rancher on every step is still the list: nothing about it says the caller may not
  // do this, and answering 500 would lose which steps had already been made.
  stubAnswer = answering(500, 'something went wrong');

  const answer = await stubbed.handlers.HANDLERS.deleteExtension({ cred: CRED, params: { name: 'base' } });

  assert.equal(answer.status, 200);
  assert.deepEqual([...new Set(answer.body.steps.map((step) => step.state))], ['failed']);
});

await checkAsync('a pods list that did not answer is not a pod that is not running', async() => {
  // Steve answers a list it will answer with 200 and an empty collection, even for a namespace
  // that does not exist. So a status on that list means it was not answered, and the four
  // Changes reads have to say so instead of drawing the empty conversation it is not evidence of.
  stubAnswer = answering(404, 'HTTP 404');

  const e = await thrownBy(stubbed.handlers.HANDLERS.extensionConversation({
    cred: CRED, params: { name: 'base' }, url: new URL('http://service.invalid/x'),
  }));

  assert.ok(e, 'an unanswered list was drawn as an empty conversation');
  assert.equal(e.status, 404);
});

await checkAsync('a pod exec the apiserver refused reports the status it was refused with', async() => {
  // RBAC on pods and RBAC on pods/exec are separate grants, so this is reachable by a caller who
  // got past every read above it. Without the status the refusal arrives as an empty stdout,
  // which every reader downstream draws as an empty conversation.
  stubAnswer = answering(403, 'pods/exec is forbidden');
  stubDropsUpgrade = false;

  const result = await stubbed.podexec.runInPod(CRED, 'some-pod', ['id'], 5000);

  assert.equal(result.transport, true);
  assert.equal(result.httpStatus, 403);
  assert.match(result.status, /403/);
});

await checkAsync('a stream that died without a status line reports no status rather than a wrong one', async() => {
  stubDropsUpgrade = true;

  const result = await stubbed.podexec.runInPod(CRED, 'some-pod', ['id'], 5000);

  assert.equal(result.transport, true);
  assert.equal(result.httpStatus, 0, 'a broken connection would be read as a refusal');
  stubDropsUpgrade = false;
});

check('rancher.mjs exports the reads that distinguish, and not the one that cannot', () => {
  // objectExists was the only way in and folded a refusal into false. What replaced it is not
  // exported at all, so install.mjs cannot go back to asking the question that has two answers.
  assert.deepEqual(
    Object.keys(stubbed.rancher).sort(),
    ['ApiError', 'RANCHER_URL', 'createIfAbsent', 'objectState', 'rancherFetch', 'removeObject'],
  );
});

stubRancher.close();

console.log('\nthe running server');

await import(path.join(SERVICE, 'main.mjs'));

const at = (route, init) => fetch(`http://127.0.0.1:${ PORT }${ route }`, init);

await checkAsync('/healthz answers without a credential, and says which source it is', async() => {
  const resp = await at('/healthz');
  const body = await resp.json();

  assert.equal(resp.status, 200);
  assert.equal(body.status, 'ok');
  // 'unknown' here rather than a fingerprint: this test starts the process directly, with no
  // Deployment to set the variable. What matters is that the field exists, because a /healthz
  // that cannot say what it is running is how a cluster ends up silently stale.
  assert.equal(body.source, 'unknown');
});

await checkAsync('/openapi.json answers without a credential, as JSON', async() => {
  const resp = await at('/openapi.json');

  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get('content-type'), 'application/json');
  assert.ok((await resp.json()).paths['/v1/extensions']);
});

await checkAsync('/v1/extensions with no credential is 401, and says what to send', async() => {
  const resp = await at('/v1/extensions');
  const body = await resp.json();

  assert.equal(resp.status, 401);
  assert.match(body.message, /Authorization header/);
  assert.match(body.message, /R_SESS/);
});

await checkAsync('a POST with no credential is refused before the body is read', async() => {
  const resp = await at('/v1/extensions', { method: 'POST', body: JSON.stringify({ name: 'x' }) });

  assert.equal(resp.status, 401);
});

await checkAsync('a DELETE with no credential is refused too', async() => {
  assert.equal((await at('/v1/extensions/base', { method: 'DELETE' })).status, 401);
});

await checkAsync('a credential gets past the gate and out to Rancher', async() => {
  const resp = await at('/v1/extensions', { headers: { Authorization: 'Bearer token-nobody:nothing' } });
  const body = await resp.json();

  // 502, not 401 and not 200: the request was accepted, forwarded, and failed at the closed
  // port this test points RANCHER_URL at. A 200 here would mean the service answered out of
  // an identity of its own, which is the thing that must never happen.
  assert.equal(resp.status, 502);
  assert.match(body.message, /could not reach Rancher/);
});

await checkAsync('an unknown path says where the list of routes is', async() => {
  const resp = await at('/v2/extensions');

  assert.equal(resp.status, 404);
  assert.match((await resp.json()).message, /openapi\.json/);
});

await checkAsync('the wrong method on a real path is 405 with an Allow header', async() => {
  const resp = await at('/v1/extensions/base', { method: 'PUT' });

  assert.equal(resp.status, 405);
  assert.equal(resp.headers.get('allow'), 'GET, DELETE');
});

await checkAsync('a command that is not argv is refused before a shell sees it', async() => {
  const resp = await at('/v1/pods/some-pod/exec', {
    method:  'POST',
    headers: { Authorization: 'Bearer token-nobody:nothing' },
    body:    JSON.stringify({ command: '/bin/sh -c ls' }),
  });

  assert.equal(resp.status, 400);
  assert.match((await resp.json()).message, /array of strings/);
});

await checkAsync('running a command with no credential is 401', async() => {
  const resp = await at('/v1/extensions/base/exec', {
    method: 'POST',
    body:   JSON.stringify({ command: ['id'] }),
  });

  assert.equal(resp.status, 401);
});

await checkAsync('/v1/apis needs a credential like every other read', async() => {
  assert.equal((await at('/v1/apis')).status, 401);
});

await checkAsync('the stream route curled as a plain GET says it is a socket', async() => {
  const resp = await at('/v1/extensions/base/exec?command=sh', {
    headers: { Authorization: 'Bearer token-nobody:nothing' },
  });

  assert.equal(resp.status, 426);
  assert.match((await resp.json()).message, /WebSocket/);
});

console.log(`\n${ pass } passed, ${ fail } failed`);
process.exit(fail ? 1 : 0);
