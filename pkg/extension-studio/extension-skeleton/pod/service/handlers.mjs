// What each route actually does.
//
// Every one of these is handed the caller's credential and passes it to every call it makes.
// None of them reads a token, a kubeconfig or a ServiceAccount file, and that is the property
// to preserve when adding one: the moment a handler can act without a credential, this service
// has an identity, and everything above it becomes a decision about permissions that Rancher
// was already making correctly.
import {
  EXT_BASE, EXT_NS, extensionObject, extensionName, extensionUrl, normalizeExtensionName,
} from './names.mjs';
import { rancherFetch, ApiError } from './rancher.mjs';
import { seedData } from './bodies.mjs';
import { runInstall, installState, runUninstall } from './install.mjs';
import { openapiDocument } from './openapi.mjs';
import { execPath, commandFrom, refuse, proxyExec } from './exec.mjs';
import { runInPod, EXEC_TIMEOUT_MS } from './podexec.mjs';
import { inPackageCommand, shellQuote, ASSISTANT_SESSION } from './podscript.mjs';
import {
  approvalScript, parseApproval, changedFilesScript, parseChangedFiles,
  provenanceScript, parseProvenance, turnsScript, parseTurns,
} from './changes.mjs';
import { listApis as readApis } from './registry.mjs';

/** What an extension was seeded from, recorded on its own ConfigMap by extensions.ts. */
const ANNOTATION_PREFIX = 'barn.rancher.io/';
export const SOURCE_ANNOTATION = `${ ANNOTATION_PREFIX }source`;

/** The extension a create copies its seed from when the caller did not say. */
const DEFAULT_FROM = 'base';

function ok(body) {
  return { status: 200, body };
}

/**
 * Liveness, and which source this pod is running.
 *
 * The version is here because "ok" on its own was a trap. This service is mounted from a
 * ConfigMap, so a cluster can be running source that no longer matches the bundle every screen
 * was built against, and a health check that cannot say which is a health check that hides it.
 * `ensureService` keeps the two in step; this is how anybody checks that it did, without a
 * credential and without reading a ConfigMap.
 */
async function health() {
  return ok({ status: 'ok', source: process.env.API_SOURCE_VERSION || 'unknown' });
}

async function openapi() {
  return ok(openapiDocument());
}

/**
 * Every extension in the cluster, read off the Deployments.
 *
 * The Deployments are the list. One made by hand, or from the dashboard, or by another caller
 * of this service, is one that should appear here, and a register of our own would be a second
 * answer that could disagree with the cluster.
 */
async function listApis({ cred }) {
  return ok(await readApis(cred));
}

async function listExtensions({ cred }) {
  const deployments = await rancherFetch(cred, `${ EXT_BASE }/v1/apps.deployments/${ EXT_NS }`);
  const items = (deployments.data || [])
    .map((deployment) => summarise(deployment))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  return ok({ items });
}

function summarise(deployment) {
  const name = extensionName(deployment?.metadata?.name || '');

  return name === null ? null : {
    name,
    ready: (deployment.status?.readyReplicas || 0) > 0,
    url:   extensionUrl(name),
  };
}

async function getExtension({ cred, params }) {
  const name = params.name;
  const object = extensionObject(name);
  const deployment = await rancherFetch(cred, `${ EXT_BASE }/v1/apps.deployments/${ EXT_NS }/${ object }`)
    .catch(notFound(`there is no extension called ${ name } in this cluster. GET /v1/extensions lists the ones there are.`));
  const [pod, seed] = await Promise.all([runningPod(cred, object), seedOf(cred, object)]);

  return ok({
    ...summarise(deployment),
    pod,
    // Null rather than absent when the ConfigMap is unreadable: "we did not find out" and "it
    // was seeded from nothing" are different facts and a caller can act on the difference.
    source: seed ? seed.annotations[SOURCE_ANNOTATION] || null : null,
  });
}

/**
 * Create an extension, one idempotent step at a time.
 *
 * The seed is copied from an extension already in the cluster rather than carried in this pod.
 * That is a real limitation and worth naming: the bundled seed is 140KB of TypeScript held by
 * the browser bundle, and a service whose own ConfigMap contained it would be a second copy
 * that goes stale the first time the skeleton changes. So a caller either names an extension to
 * copy, or sends the tree.
 */
async function createExtension({ cred, body }) {
  const name = normalizeExtensionName(body?.name);

  if (!name) {
    throw new ApiError(
      `"${ body?.name ?? '' }" is not a name anything can be called. Send {"name": "..."} with at least one letter or digit in it.`,
      400,
    );
  }

  const seed = body?.files
    ? { data: seedData(body.files), annotations: {} }
    : await copiedSeed(cred, body?.from || DEFAULT_FROM);
  const steps = await runInstall(cred, name, seed);

  raiseIfWhollyRefused(steps);

  return ok({ name, steps });
}

/**
 * A refusal that stopped every step is the answer, not a list of six failures.
 *
 * runInstall and runUninstall report a failed step and carry on, which is right when one object
 * could not be made: the others are still worth attempting and the caller wants to know which
 * one it was. It is not right when every step failed with the same refusal, because then nothing
 * was attempted at all, and a 200 whose body is six identical "Unauthorized" lines says the
 * opposite of what happened.
 *
 * These were the last two routes where constraint 1's first sentence - a caller with no
 * credential gets 401 - was not true. `files` in the body is what made it reachable: it skips
 * copiedSeed, which is the only thing on that route that raised a refusal, and the install then
 * folded the same refusal into six per-step notes.
 *
 * Every step rather than any step, because a mixed answer is a real report: a caller who may
 * create a Deployment but not a ClusterRoleBinding gets the 200 and the list, which is exactly
 * the case the per-step catch exists for.
 */
function raiseIfWhollyRefused(steps) {
  const refused = steps.filter((step) => isRefusal(step.status));

  if (steps.length && refused.length === steps.length) {
    throw new ApiError(refused[0].error, refused[0].status);
  }
}

/** The seed of an extension that is already here, annotations and all. */
async function copiedSeed(cred, from) {
  const object = extensionObject(from);
  const map = await rancherFetch(cred, `${ EXT_BASE }/v1/configmaps/${ EXT_NS }/${ object }`)
    .catch(notFound(
      `there is no seed to copy: ${ from } has no ConfigMap in ${ EXT_NS }. Name an extension that does with "from", or send the tree yourself as "files".`,
    ));

  return asSeed(map);
}

/**
 * A ConfigMap as the two things a seed is: its files, and this product's own annotations.
 *
 * One shape for both readers, which is the whole reason it is a function. It was two: the copy
 * path returned `{ data, annotations }` and the read path returned the raw ConfigMap, and the
 * reader that wanted the source annotation off the second one asked the first one's shape for
 * it and got a 500 on a route that otherwise worked.
 */
export function asSeed(configMap) {
  return { data: configMap?.data || {}, annotations: ours(configMap?.metadata?.annotations) };
}

/**
 * Only this product's own annotations travel with a copied seed.
 *
 * The rest of what Kubernetes puts on a ConfigMap belongs to the object it was on:
 * `kubectl.kubernetes.io/last-applied-configuration` in particular is a full copy of the
 * source object under the source object's name, which on the new one would describe something
 * that does not exist.
 */
function ours(annotations) {
  return Object.fromEntries(
    Object.entries(annotations || {}).filter(([key]) => key.startsWith(ANNOTATION_PREFIX)),
  );
}

async function deleteExtension({ cred, params }) {
  const steps = await runUninstall(cred, params.name);

  raiseIfWhollyRefused(steps);

  return ok({ name: params.name, steps });
}

async function extensionInstallState({ cred, params }) {
  return ok({ name: params.name, steps: await installState(cred, params.name) });
}

/**
 * A read of one object that failed: null when it is not there, and a throw when we were refused.
 *
 * The distinction is the whole of this function, and losing it was a real fault rather than a
 * tidiness one. Every read below used to end in `.catch(() => null)`, so an expired session came
 * back from Rancher as 401 and left here as "no pod" - and the review screens then rendered
 * "no changes waiting" to somebody who had simply been logged out. Seven routes answered 200
 * with empty data while /v1/extensions, which does not go through here, correctly answered 401.
 *
 * Collapsing a refusal into an absence is also this service deciding a permission question, and
 * constraint 1 says it does not get to: what the apiserver said is what the caller is told.
 *
 * For one object only. A 404 on a single object is Steve saying it is not there, which is an
 * answer; a 404 on a list is Steve declining to answer at all, and runningPod above says what
 * that has to do instead.
 */
function refusalsPropagate(e) {
  if (isRefusal(e?.status)) {
    throw e;
  }

  return null;
}

/**
 * The two statuses that mean "you were not allowed to ask", as against "there is nothing there".
 *
 * Named and used three times rather than spelled out three times, because the rule drifting is
 * how the last two survivors of this class happened: notFound and the pod exec each had their
 * own idea of which failures were absences, and neither idea included a refusal.
 */
function isRefusal(status) {
  return status === 401 || status === 403;
}

/**
 * The running pod for an extension, or null while there is not one.
 *
 * Steve ignores labelSelector, so the filtering happens here. `Running` is the bar rather than
 * `Ready`: the pod is ready only once the dev server serves, which is minutes on a first boot,
 * and a shell is useful well before then.
 *
 * Nothing is caught, which is a stronger rule than refusalsPropagate applies to the reads below
 * it, and the difference is that this one is a list. Steve answers a list it will answer with
 * 200 and an empty collection - even for a namespace that does not exist, which was checked
 * rather than assumed - so any status at all here means the list was not answered, and the
 * emptiness that comes out of it would be invented rather than read. The one status that is not
 * about this caller is a 404 for a type Steve has never heard of, and reporting that as a fault
 * is right too: it is a typo in the line above, not a namespace with no pods in it.
 *
 * That is not hypothetical either: Steve answers this list with 404, not 403, to a Rancher user
 * who may not see the namespace, so folding 404 in with the rest left the four Changes reads
 * answering 200 with an empty conversation, no changed files and no turns to every ordinary
 * user in the cluster.
 */
async function runningPod(cred, object) {
  const pods = await rancherFetch(cred, `${ EXT_BASE }/v1/pods/${ EXT_NS }`).catch((e) => {
    // Rancher's own status, kept, with a sentence in front of it: Steve sends no body with this
    // one, so what reached the caller was the bare "HTTP 404" that tells nobody what to do.
    throw new ApiError(
      `could not read the pods in ${ EXT_NS } as you, so there is nothing to say about ${ object }: ${ e?.message || e }. Rancher answers this list with 404 to somebody who may not see that namespace and 401 to somebody whose session has expired, so check which of those you are.`,
      e?.status || 502,
    );
  });
  const running = (pods?.data || []).find((pod) => (
    pod.metadata?.labels?.app === object &&
    pod.status?.phase === 'Running' &&
    !pod.metadata?.deletionTimestamp
  ));

  return running?.metadata?.name || null;
}

/** An extension's seed, or null when it has none this caller can read. */
async function seedOf(cred, object) {
  const map = await rancherFetch(cred, `${ EXT_BASE }/v1/configmaps/${ EXT_NS }/${ object }`)
    .catch(refusalsPropagate);

  return map ? asSeed(map) : null;
}

/**
 * Turn a read that found nothing into one 404 that says what to do about it.
 *
 * A read that was refused is not turned into anything: refusalsPropagate rethrows it first, so
 * this is the same rule as every other read here rather than a second one. Discarding the error
 * made GET /v1/extensions/{name} answer an invalid token with "there is no extension called base
 * in this cluster", which sends somebody whose session expired looking for a Deployment that is
 * running in front of them. POST /v1/extensions had it too, on the seed it copies from.
 */
function notFound(message) {
  return (e) => {
    refusalsPropagate(e);

    throw new ApiError(message, 404);
  };
}

/** The pod an extension is running in, or a 404 saying how to find out why there is not one. */
async function podFor(cred, name) {
  const pod = await runningPod(cred, extensionObject(name));

  if (!pod) {
    throw new ApiError(
      `${ name } has no running pod, so there is nothing to run a command in. GET /v1/extensions/${ name }/install reports whether it was ever created.`,
      404,
    );
  }

  return pod;
}

/** argv out of a request body, refused early so a shell never sees a string that is not one. */
function commandIn(body) {
  const command = body?.command;

  if (!Array.isArray(command) || !command.length || command.some((a) => typeof a !== 'string')) {
    throw new ApiError(
      'Send {"command": ["/bin/sh", "-c", "..."]}: an array of strings, one per argument. A single string would be one argument with spaces in it.',
      400,
    );
  }

  return command;
}

/**
 * What to run, in either of the two forms a caller has.
 *
 * `command` is argv and goes to the container as it is. `script` is shell run in the
 * extension's package directory as the tree's owner, which is what almost every caller
 * actually wants and what all of them used to compose for themselves: the setpriv drop, the
 * HOME, the package directory lookup and the braces around the list. Composing it here is the
 * point of this route, and it is why `script` is only available where an extension is named.
 */
function workIn(body, name) {
  if (typeof body?.script === 'string' && body.script.trim()) {
    return inPackageCommand(name, body.script);
  }

  return commandIn(body);
}

function timeoutIn(body) {
  const given = Number(body?.timeoutMs);

  return Number.isFinite(given) && given > 0 ? given : EXEC_TIMEOUT_MS;
}

async function runInExtension({ cred, params, body }) {
  const work = workIn(body, params.name);
  const pod = await podFor(cred, params.name);

  return ok({ pod, ...await runInPod(cred, pod, work, timeoutIn(body)) });
}

/**
 * The by-pod form, which is also the only one that can name a container.
 *
 * By-extension cannot: an extension is one Deployment whose one container is its dev server, so
 * there is nothing to choose. The agent pod is addressed here, by name, and its container is
 * not called what an extension's is.
 */
async function runInNamedPod({ cred, params, body }) {
  const container = typeof body?.container === 'string' && body.container ? body.container : undefined;

  return ok({
    pod: params.pod,
    ...await runInPod(cred, params.pod, commandIn(body), timeoutIn(body), container),
  });
}

/**
 * One line of JSON printed by a program in the pod, found by its marker.
 *
 * The pod's programs print prose as well - a warning, a node deprecation notice - so the
 * payload is announced rather than assumed to be the whole of stdout. Anything that is not
 * there, or not JSON, is reported as "the pod said nothing usable" rather than as a crash: the
 * commonest reason is a pod that is still booting, and a screen polling it should show an empty
 * conversation rather than an error.
 */
function markedJson(stdout, marker) {
  const at = (stdout || '').indexOf(marker);

  if (at < 0) {
    return null;
  }

  try {
    return JSON.parse(stdout.slice(at + marker.length).split('\n')[0]);
  } catch {
    return null;
  }
}

const CONVERSATION_MARKER = 'BARN-CONVERSATION:';

/** What a caller gets when the pod has not answered yet, which is a state and not a failure. */
const NO_CONVERSATION = {
  read: false, dir: '', session: '', version: '', mode: '', model: '', total: 0, messages: [],
};

async function extensionConversation({ cred, params, url }) {
  const since = url.searchParams.get('since');
  const limit = Math.max(1, Math.min(200, Math.floor(Number(url.searchParams.get('limit')) || 60)));
  const args = [since ? `--since ${ shellQuote(since) }` : '', `--limit ${ limit }`].filter(Boolean).join(' ');
  const stdout = await inExtension(cred, params.name, `node /seed/conversation.mjs ${ args }`);

  return ok({ ...NO_CONVERSATION, ...markedJson(stdout, CONVERSATION_MARKER) || {} });
}

/**
 * The visible pane, not the scrollback, and only the foot of it.
 *
 * This once reached 120 lines back, which on a session that had not run for long meant the card
 * showed claude's start-up banner under a heading that says "Working". That is not what it is
 * doing, it is what it said when it booted. What it is doing is at the bottom of the screen it
 * is drawing.
 */
async function extensionPane({ cred, params, url }) {
  const lines = Math.max(4, Math.min(60, Math.floor(Number(url.searchParams.get('lines')) || 20)));
  const text = await inExtension(cred, params.name, [
    `if tmux has-session -t ${ ASSISTANT_SESSION } 2>/dev/null ; then`,
    `tmux capture-pane -p -t ${ ASSISTANT_SESSION } | tr -cd '\\11\\12\\15\\40-\\176'`,
    `| sed -e 's/[[:space:]]*$//' | grep -v '^$' | tail -n ${ lines } ;`,
    'fi',
  ].join(' '));

  return ok({ text });
}

/**
 * Run a script in the extension's package directory and give back only what it printed.
 *
 * The reading form: whatever stdout it managed to produce, whatever happened. Every caller of
 * this reads something that may legitimately not be there, and for them an empty string is the
 * right answer where a throw would be a screen that fails instead of a rail that is empty.
 */
async function inExtension(cred, name, script, onFailure = '') {
  // No catch: whatever runningPod could not find out is the caller's answer, not an empty
  // reading. Only a list that answered, with no running pod in it, produces the empty one below.
  const pod = await runningPod(cred, extensionObject(name));

  if (!pod) {
    return onFailure;
  }

  const result = await runInPod(cred, pod, inPackageCommand(name, script));

  // The same rule as refusalsPropagate, asked of the exec handshake instead of a REST read. RBAC
  // on pods and RBAC on the pod's exec subresource are separate grants, so a caller who is
  // allowed to list the pod above can still be refused the exec below - and the refusal arrives
  // here as an empty stdout, which every reader downstream renders as an empty conversation, no
  // changed files and no turns. That is this whole class of bug one layer lower down.
  if (isRefusal(result.httpStatus)) {
    throw new ApiError(result.status, result.httpStatus);
  }

  // `onFailure` exists for the one caller whose empty answer is dangerous rather than merely
  // empty. Everything else reads something that may legitimately not be there, and for those an
  // empty string is right where a throw would be a screen that fails instead of a rail that is
  // empty.
  return result.transport && onFailure ? onFailure : result.stdout;
}

/**
 * How far review has got, and what is waiting.
 *
 * The one read whose failure mode matters more than its answer: a screen that cannot find out
 * must not be told "nothing is pending", because that is what opens the publish gate. So the
 * exec's own failure is turned into the marker the parser reads as unknown, rather than into an
 * empty string that looks like a clean tree.
 */
async function extensionApproval({ cred, params }) {
  const out = await inExtension(cred, params.name, approvalScript(), 'BARN-APPROVAL-FAILED');

  return ok(parseApproval(out));
}

async function extensionChanges({ cred, params, url }) {
  const since = url.searchParams.get('since');
  let script;

  try {
    script = changedFilesScript(since || undefined);
  } catch (e) {
    throw new ApiError(`${ e?.message || e }. Leave "since" off to measure from the baseline.`, 400);
  }

  const out = await inExtension(cred, params.name, script);

  // A commit the reviewer's record names can have been taken out of the branch by a reset, and
  // answering that with the whole change would be answering a different question. The screen
  // has to be able to say so, which it can only do if this says so.
  if (out.includes('BARN-NO-COMMIT')) {
    throw new ApiError(`${ since } is not a commit in ${ params.name }'s branch any more, so there is nothing to measure from. Ask without "since" for the whole change.`, 404);
  }

  return ok({ files: parseChangedFiles(out) });
}

async function extensionProvenance({ cred, params }) {
  return ok(parseProvenance(await inExtension(cred, params.name, provenanceScript())));
}

async function extensionTurns({ cred, params, url }) {
  const limit = Number(url.searchParams.get('limit')) || 25;

  return ok({ turns: parseTurns(await inExtension(cred, params.name, turnsScript(limit))) });
}

/**
 * The stream route, which is the one handler that never produces a body.
 *
 * By the time this runs the client's socket has been taken over for an upgrade, so a refusal is
 * written onto it by hand and a success is a splice - see exec.mjs.
 */
async function execStream({ cred, params, url, req, socket, head }) {
  const command = commandFrom(url.searchParams);

  if (!command.length) {
    refuse(socket, 400, 'Bad Request', 'Nothing to run. Add one "command" parameter per argument: ?command=/bin/sh&command=-c&command=ls');

    return;
  }

  let pod;

  try {
    pod = await runningPod(cred, extensionObject(params.name));
  } catch (e) {
    // The socket has already been taken over for an upgrade, so the apiserver's status has to be
    // written onto it by hand rather than returned. A refused stream must say it was refused.
    refuse(socket, e?.status || 500, 'Error', e?.message || String(e));

    return;
  }

  if (!pod) {
    refuse(socket, 404, 'Not Found', `${ params.name } has no running pod yet. GET /v1/extensions/${ params.name } reports its readiness, and GET /v1/extensions/${ params.name }/install reports whether it was ever created.`);

    return;
  }

  proxyExec(req, socket, head, cred, execPath(pod, command, url.searchParams.get('tty') === '1'));
}

/**
 * The functions routes.mjs names.
 *
 * A map rather than an import per route in main.mjs, so that a route added to the table with no
 * handler is one assertion in scripts/check-service.mjs rather than a 500 nobody hits until the
 * route is called.
 */
export const HANDLERS = {
  health,
  openapiDocument: openapi,
  listApis,
  listExtensions,
  createExtension,
  getExtension,
  deleteExtension,
  extensionInstallState,
  runInExtension,
  runInNamedPod,
  extensionConversation,
  extensionPane,
  extensionApproval,
  extensionChanges,
  extensionProvenance,
  extensionTurns,
  execStream,
};
