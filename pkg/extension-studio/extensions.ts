// ---------------------------------------------------------------------------
// Extensions: Rancher extensions whose dev servers run as pods in the cluster,
// and are edited inside those pods.
//
// A pod runs `vue-cli-service serve` over a whole dashboard with an extension
// package compiled into it. The browser reaches it through the Kubernetes
// apiserver's service proxy, on Rancher's own origin, so it is a second,
// live-reloading dashboard at a URL of its own, and Rancher's own UI and its
// `ui-dashboard-index` setting are left completely alone.
//
// There can be several. Each is a name, and that name is the whole of its
// identity: it decides the objects in the cluster, the directory on the node
// its tree lives in, and the URL it is served at. What one starts as is a
// choice: the stock package baked into this bundle, a repository to clone, or
// the live tree of an extension already running here.
//
// Everything an extension needs travels with this bundle: the source is written
// into a ConfigMap, the pod installs from it on first boot, and creating one is
// four objects. There is no install step and nothing to run outside the cluster.
//
// Editing is done in the pod. That tree is the live source once it has booted:
//   kubectl -n extension-studio exec -it deploy/barn-<name>-extension \
//     -- bash -c 'cd "$(ls -d /app/pkg/*/ | head -1)" && exec bash'
// ---------------------------------------------------------------------------
import { rancherFetch } from './api';
import { SEEDS } from './extension-seed.generated';

// The `local` cluster, like the editor's content pod: the extension loads in
// contexts that have no cluster of their own, and a dev server should be at one
// URL regardless of where you were when you opened it.
const EXT_CLUSTER = 'local';
export const EXT_NS = 'extension-studio';
const EXT_PORT = 8005;

// The one container in a pod. Named here because two things address it: the
// Deployment below creates it, and a terminal tab execs into it.
const EXT_CONTAINER = 'devserver';

// Plain node, not a built image: the pod installs from the seeded package.json,
// so there is nothing to publish and nothing that can be older than the source.
const EXT_IMAGE = 'node:24';

/**
 * The extension every Rancher gets, and the one the Editor opens.
 *
 * It is a name like any other. The only thing special about it is that it is
 * created without being asked for, so that a Rancher with this bundle loaded has
 * somewhere to edit before anybody has typed anything.
 *
 * The stock extension rather than this product's own, which is what it used to be. That one
 * now lives in codyrancher/dev-extension and is imported like any other repository, and making
 * it the default again would mean cloning from GitHub in front of the editor on every fresh
 * cluster - a network round trip, and something else to fail, before anything can be looked at.
 */
export const DEFAULT_EXTENSION = 'base';

const EXT_BASE = `/k8s/clusters/${ EXT_CLUSTER }`;

/**
 * The ServiceAccount every extension pod runs as, and what it can do.
 *
 * cluster-admin, deliberately. The point of a terminal in one of these pods is
 * that claude can build a Rancher extension in it, and a Rancher extension is
 * mostly a UI over Rancher's own resources: it cannot be written, and certainly
 * cannot be tried, by somebody who cannot create a Project, look at a Setting or
 * make a workspace to test against. The alternative we had was a token with no
 * rights at all, which made every question about the cluster unanswerable from
 * the pane that was supposed to be answering it.
 *
 * This is a real grant and worth saying plainly: anyone who can open a terminal
 * in one of these pods can do anything in this cluster. That is the same set of
 * people who can already developer-load an extension into Rancher, which runs
 * with the session of whoever is looking at it, so it widens what is reachable
 * without widening who can reach it.
 */
export const EXT_ACCOUNT = 'barn-extension';
export const EXT_ROLE_BINDING = 'barn-extension-cluster-admin';

/**
 * What an extension was seeded from, remembered on its own ConfigMap.
 *
 * Because "make sure this exists" and "make this" are the same call, and only one of them
 * knows the answer. The editor, the terminal and the starting page all call ensureExtension
 * with a name and no source, meaning "it should be running" - and a default source turns that
 * into "and it is a dev extension", which for anything made from another seed replaces its
 * tree's seed with a different extension's.
 *
 * The symptom is indirect enough to be worth writing down: the pod ends up with two packages,
 * the CLAUDE.md of the one it did not come from telling claude that is its source, and a
 * publish that builds the other one. Edits land where nothing reads them.
 *
 * An annotation rather than a label because a source can be `github:owner/repo#branch`, which
 * is not a legal label value.
 */
const SOURCE_ANNOTATION = 'barn.rancher.io/source';

/**
 * The data keys in a seed ConfigMap that were authored rather than seeded.
 *
 * Screen 02 writes the placement decision and the first draft of the brief into the seed at
 * creation time, because at that moment there is no pod to write them into. Every later
 * `ensureExtension(name)` re-seeds the ConfigMap from the bundle - that upsert is how a file
 * added to the seed reaches an extension that already exists - and without this it would
 * quietly put the stock product.ts back over the generated one, in the exact window before
 * the pod has booted and taken its copy.
 *
 * So the keys are listed here, and a re-seed that was handed nothing new carries them across.
 * A caller that does hand extras in is stating the current answer and replaces the list.
 */
const AUTHORED_ANNOTATION = 'barn.rancher.io/authored';

/** ConfigMap keys cannot contain '/', so paths are flattened and boot.sh rebuilds them. */
export const PATH_SEPARATOR = '__';

function encodeSeedKey(filePath: string): string {
  return filePath.split('/').join(PATH_SEPARATOR);
}

/**
 * What an extension's objects are called.
 *
 * `barn-<name>-extension` rather than anything shorter, because the namespace
 * holds the editor's content pod too and a bare name would eventually collide
 * with it. It is also the label every one of its objects carries, so the
 * Deployment, the Service, the ConfigMap and the pod all answer to one string.
 */
export function extensionObject(name: string): string {
  return `barn-${ name }-extension`;
}

/** The reverse, for listing: null for anything in the namespace that is not an extension. */
function extensionName(object: string): string | null {
  const match = object.match(/^barn-(.+)-extension$/);

  return match ? match[1] : null;
}

/**
 * Where the node keeps an extension's working tree and node_modules between pod
 * restarts. The install is minutes and the tree is what you edit, so neither can
 * live in the pod's own filesystem.
 *
 * Still `barn` after the rename, and staying that way: this is a path on the node,
 * not a Kubernetes name, so nothing reconciles it. Changing it would not move the
 * trees, it would abandon them - every existing extension would come back to an
 * empty directory and reinstall from scratch, losing whatever was not committed.
 */
function hostCachePath(name: string): string {
  return `/var/lib/rancher/barn/${ name }-extension`;
}

/**
 * A name Kubernetes will accept, and that a person will recognise afterwards.
 *
 * Applied rather than rejected: this is fed by a free-text box in the header, and
 * somebody typing "My Thing" means a new extension, not a validation error.
 */
export function normalizeExtensionName(input: string): string {
  return (input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * The apiserver's service-proxy path in front of an extension's dev server.
 *
 * Root-relative on purpose: the browser resolves it against Rancher's own
 * origin, so neither this extension nor the pod ever learns what hostname
 * Rancher is served on. It is also the only thing the pod's vue.config.js is
 * given: asset URLs, the router base and the hot-reload socket are all derived
 * from it, out of the same constants that name the Service just below.
 */
export function extensionProxyPath(name: string): string {
  const object = extensionObject(name);

  return `${ EXT_BASE }/api/v1/namespaces/${ EXT_NS }/services/http:${ object }:${ EXT_PORT }/proxy`;
}

/** Where to point a browser at one. */
export function extensionUrl(name: string): string {
  return `${ extensionProxyPath(name) }/`;
}

/**
 * Whether an extension's dev server is serving yet.
 *
 * First boot installs and compiles for a few minutes, and until it does the
 * service proxy answers with an error of its own ("no endpoints available")
 * rather than the dashboard. Anything that frames or redirects to one waits on
 * this, so what it shows in the meantime is its own, not the proxy's error page.
 */
export async function extensionReady(name: string): Promise<boolean> {
  try {
    // Not rancherFetch: that one expects JSON, and this is the dashboard's HTML.
    const resp = await fetch(`${ extensionProxyPath(name) }/index.html`, { cache: 'no-store' });

    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * The running pod for an extension, or null while there isn't one.
 *
 * A terminal tab needs the pod by name, because exec is a subresource of the pod
 * rather than of the Deployment or the Service. Steve ignores labelSelector, so
 * the filtering is done here.
 *
 * `Running` is the bar, not `Ready`: the pod is ready only once the dev server
 * serves, which is minutes on a first boot, and a shell is useful (arguably most
 * useful) before then.
 */
export async function extensionPod(name: string): Promise<string | null> {
  const object = extensionObject(name);
  const pods = await rancherFetch(`${ EXT_BASE }/v1/pods/${ EXT_NS }`).catch(() => null);

  const running = (pods?.data || []).find((pod: any) => (
    pod.metadata?.labels?.app === object &&
    pod.status?.phase === 'Running' &&
    !pod.metadata?.deletionTimestamp
  ));

  return running?.metadata?.name || null;
}

export interface ExtensionSummary {
  name: string;
  /** Ready replicas, so the caller can say "starting" without a second request. */
  ready: boolean;
  url: string;
}

/**
 * Every extension in the cluster.
 *
 * Read from the Deployments rather than from a list this extension keeps,
 * because the cluster is the list: one made in another browser, or by hand, is
 * one this should offer. The name is recovered from the object's own name for
 * the same reason a label would be worse - an object relabelled by hand would
 * vanish from the picker while continuing to serve.
 */
export async function listExtensions(): Promise<ExtensionSummary[]> {
  const deployments = await rancherFetch(`${ EXT_BASE }/v1/apps.deployments/${ EXT_NS }`).catch(() => null);

  return (deployments?.data || [])
    .map((deployment: any) => {
      const name = extensionName(deployment.metadata?.name || '');

      return name === null ? null : {
        name,
        ready: (deployment.status?.readyReplicas || 0) > 0,
        url:   extensionUrl(name),
      };
    })
    .filter(Boolean)
    .sort((a: ExtensionSummary, b: ExtensionSummary) => a.name.localeCompare(b.name));
}

// GET a Steve resource; resolve null if it isn't there yet.
function extGet(type: string, object: string): Promise<any> {
  return rancherFetch(`${ EXT_BASE }/v1/${ type }/${ EXT_NS }/${ object }`).catch(() => null);
}

/**
 * Where a new extension's files come from.
 *
 * The baked-in seed (`base`, the stock extension), a repository to clone, or the live tree of
 * an extension already running here. The last is the interesting case: it is a copy of what
 * somebody has been editing, including whatever they changed an hour ago, which is not
 * something a baked-in seed can be.
 *
 * There used to be a second baked-in one, this product's own extension. It is a repository now
 * (codyrancher/dev-extension) and arrives through the same import as anybody else's, which is
 * the point of having built the import at all: a package that can only be had by being vendored
 * into another extension's bundle is a package nobody outside this repo can contribute to.
 */
export const BUILT_IN_SEEDS = Object.keys(SEEDS);

/** The one there is. Kept as a name rather than inlined, because it is a decision and not a fact. */
export const DEFAULT_SEED = 'base';

function seedFiles(source: string): Record<string, string> {
  return SEEDS[source] || SEEDS[DEFAULT_SEED];
}

/**
 * Give a built-in seed the name the person asked for.
 *
 * The seeds ship as `pkg/base/...` with `"name": "base"` in their package.json, and nothing
 * renamed them - so every extension made from the base seed was a package called `base` in a
 * directory called `base`, whatever the user typed. It mostly did not show, because
 * PACKAGE_DIR is a glob and the pod only ever holds one package. It showed at publish:
 * packageIdentity reads that package.json, so publishing an extension called `demo` installed
 * a UIPlugin called `base`, and a second extension from the same seed would have overwritten
 * the first.
 *
 * Only for the built-in seeds. An imported repository and a copy of another extension both
 * arrive with a package name of their own, and renaming those would be taking a decision that
 * is not ours to take.
 */
function renameSeedPackage(files: Record<string, string>, seed: string, name: string): Record<string, string> {
  if (seed === name) {
    return files;
  }

  const from = `pkg/${ seed }/`;
  const to = `pkg/${ name }/`;
  const out: Record<string, string> = {};

  for (const [filePath, contents] of Object.entries(files)) {
    const moved = filePath.startsWith(from) ? to + filePath.slice(from.length) : filePath;

    if (moved === `${ to }package.json`) {
      try {
        const parsed = JSON.parse(contents);

        parsed.name = name;
        out[moved] = `${ JSON.stringify(parsed, null, 2) }\n`;
        continue;
      } catch {
        // A seed whose package.json does not parse is a broken seed, and silently shipping
        // it under the wrong name is worse than shipping it unchanged.
      }
    }

    out[moved] = contents;
  }

  return out;
}

function seedData(files: Record<string, string>): Record<string, string> {
  // boot.sh is the container's command and is read straight out of /seed, so it
  // keeps its own name; everything else is a path in the tree.
  const data: Record<string, string> = {};

  for (const [filePath, contents] of Object.entries(files)) {
    data[encodeSeedKey(filePath)] = contents;
  }

  return data;
}

/**
 * The files of a running extension, read out of its pod.
 *
 * One exec, not one per file. The obvious version - list, then read each - is forty-odd
 * websockets and the better part of a minute, and it gets slower as somebody's extension grows.
 * So a small node script is written into the pod and run there, and what comes back is a single
 * JSON object.
 *
 * The script arrives base64-encoded rather than as a quoted argument. It is JavaScript inside a
 * `sh -c` inside a URL query parameter, and every layer of that has its own opinion about
 * quotes; encoding it means none of them gets a say.
 */
const CLONE_SCRIPT = `
const fs = require('fs');
const path = require('path');
const root = fs.readdirSync('/app/pkg').map((d) => path.join('/app/pkg', d)).filter((d) => fs.statSync(d).isDirectory())[0];
const out = {};
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else out['pkg/' + path.relative('/app/pkg', full)] = fs.readFileSync(full, 'utf8');
  }
})(root);
process.stdout.write(JSON.stringify(out));
`;

async function cloneFiles(source: string): Promise<Record<string, string>> {
  const pod = await extensionPod(source);

  if (!pod) {
    throw new Error(`${ source } has no running pod to copy from`);
  }

  const encoded = btoa(CLONE_SCRIPT);
  const script = '/tmp/barn-clone.js';

  await podExecOnce(pod, asPodUser(`echo ${ encoded } | base64 -d > ${ script }`));

  const out = await podExecOnce(pod, asPodUser(`node ${ script }`));

  let tree: Record<string, string>;

  try {
    tree = JSON.parse(out);
  } catch {
    throw new Error(`could not read ${ source }'s tree: ${ out.slice(0, 200) || 'no output' }`);
  }

  return withSkeleton(tree);
}

/**
 * A cloned or imported package, plus the parts every extension has and nobody edits.
 *
 * The skeleton and the pod scripts come from the default seed because they are the same in
 * every extension and are not part of what was copied; `pkg/` is stripped out of it so the
 * copy's own package is the only one in the result.
 */
function withSkeleton(tree: Record<string, string>): Record<string, string> {
  const skeleton = { ...seedFiles(DEFAULT_SEED) };

  for (const key of Object.keys(skeleton)) {
    if (key.startsWith('pkg/')) {
      delete skeleton[key];
    }
  }

  return { ...skeleton, ...tree };
}

/** `github:owner/repo`, or `github:owner/repo#branch`. Null for anything that is not one. */
export function parseGithubSource(source: string): { repo: string; ref: string } | null {
  const match = /^github:([\w.-]+\/[\w.-]+)(?:#(.+))?$/.exec(source);

  return match ? { repo: match[1], ref: match[2] || '' } : null;
}

/**
 * What somebody typed or pasted into a repository field, read as `owner/name` and a branch.
 *
 * The bare `owner/name` is the form the clone wants, but it is not the form anybody has to
 * hand: what they have is the URL out of the browser bar, or the one GitHub's clone button
 * gave them. Rejecting those and asking for `owner/name` instead makes the user do a
 * transformation this can do, so it does it, and a `/tree/<branch>` URL brings its branch with
 * it rather than being silently flattened to the default.
 *
 * Null for anything that cannot be read as a github.com repository, which is what puts the
 * field into its error state. Owner has no dot in it on purpose - that is what stops
 * `gitlab.com/someone` being read as the repository `someone` belonging to `gitlab.com`.
 */
export function parseGithubRepoInput(input: string): { repo: string; branch: string } | null {
  // A query or a fragment first: the browser bar hands back `...?tab=readme` and `...#readme`.
  let text = (input || '').trim().split(/[?#]/)[0].trim();

  if (!text) {
    return null;
  }

  const isUrl = /:\/\//.test(text) || /^git[+@]/i.test(text) || /^(?:www\.)?github\.com[:/]/i.test(text);

  if (isUrl) {
    const host = text
      .replace(/^git\+/i, '')
      .replace(/^[a-z][\w+.-]*:\/\//i, '')
      .replace(/^[^/@]*@/, '');
    const onGithub = /^(?:www\.)?github\.com[:/](.+)$/i.exec(host);

    if (!onGithub) {
      return null;
    }

    text = onGithub[1];
  }

  const parts = text.replace(/^\/+/, '').replace(/\/+$/, '').split('/');

  if (parts.length < 2) {
    return null;
  }

  const owner = parts[0];
  const name = parts[1].replace(/\.git$/i, '');
  let branch = '';

  if (parts.length > 2) {
    // `/tree/<ref>[/dir]` and `/blob/<ref>/<path>` are the two shapes a browser URL takes, and
    // the ref is one segment in both: a directory below it is part of the path, not the ref.
    // Anything else deeper than owner/name is a page we cannot read a repository out of.
    if ((parts[2] === 'tree' || parts[2] === 'blob') && parts.length > 3) {
      branch = parts[3];
    } else {
      return null;
    }
  }

  if (!/^[\w-]+$/.test(owner) || !/^[\w.-]+$/.test(name) || name === '.' || name === '..') {
    return null;
  }

  return { repo: `${ owner }/${ name }`, branch };
}

/**
 * Walks the clone rather than the pod's own tree, and names the package after its package.json.
 *
 * The directory a package lives in and the name inside its package.json have to agree - the
 * build reads one and the dev server serves the other - so the repository's own name wins over
 * anything typed into a modal. BARN_IMPORT_NAME is the fallback for a repository that has no
 * package.json to ask.
 */
const IMPORT_SCRIPT = `
const fs = require('fs');
const path = require('path');
const root = '/tmp/barn-import';

// Two shapes of repository, and both are ones this product produces.
//
// A repository laid out as a Rancher extension keeps its package under pkg/<name>/ with the
// dashboard skeleton around it at the root - package.json, the vue config, a lockfile - which
// is what rancher/dashboard's build expects and what a repository has to look like to publish
// itself. The pod already has a skeleton of its own, so only the package is taken and the root
// is left where it is.
//
// A repository that is only the package has it at the root, which is what Publish to GitHub
// writes. Both arrive here as one directory under /app/pkg, named after the package.
let src = root;
let dir = '';
const nested = path.join(root, 'pkg');

try {
  const found = fs.readdirSync(nested, { withFileTypes: true }).filter((entry) => entry.isDirectory());

  if (found.length) {
    src = path.join(nested, found[0].name);
    dir = found[0].name;
  }
} catch (e) {}

if (!dir) {
  try { dir = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')).name || ''; } catch (e) {}
}

dir = dir || process.env.BARN_IMPORT_NAME;
const out = {};
(function walk(d) {
  for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(d, entry.name);
    if (entry.isDirectory()) walk(full);
    else out['pkg/' + dir + '/' + path.relative(src, full)] = fs.readFileSync(full, 'utf8');
  }
})(src);
process.stdout.write(JSON.stringify(out));
`;

/**
 * A pod - any pod - to run a clone in.
 *
 * Importing needs git, a network and a filesystem, and the extension being imported has none of
 * them yet: it does not exist. So it borrows a pod that does. Any running extension will do,
 * because nothing of that extension is touched: the clone lands in /tmp and is read straight
 * back out.
 */
async function anyRunningPod(): Promise<string | null> {
  for (const extension of await listExtensions().catch(() => [])) {
    if (!extension.ready) {
      continue;
    }

    const pod = await extensionPod(extension.name);

    if (pod) {
      return pod;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// The GitHub credential, read where it is used.
//
// The token is write-only: it goes into the `barn-settings` Secret and never comes back into
// the browser. See SETTINGS_SECRET for what that costs and why. What makes it possible is that
// the thing which needs the token is a pod, and the pod has a service account of its own -
// `EXT_ACCOUNT`, bound to cluster-admin - so it can read the Secret itself. Everything below is
// how it does that, and it is the only reader of `gh_token` anywhere in this product.
//
// Two forms, because there are two kinds of caller:
//
//   podTokenReader()  prints the token on stdout, for the two callers that hand it to git.
//   githubScript()    reads it and makes the API call in one process, so it is never even a
//                     shell variable.
//
// Neither ever puts the token in a command's arguments. `podTokenReader` is captured into a
// shell variable and passed on through the environment (`git --config-env`), and the scripts
// are single-quoted source that contains the *name* of a secret, not its value. A `ps` inside
// the pod finds nothing, which the previous shape - the token interpolated into the command
// string from the browser - could not say.
// ---------------------------------------------------------------------------

/**
 * Node, in the pod, printing the configured GitHub token and nothing else.
 *
 * Double quotes throughout: this is single-quoted by the time it reaches `sh -c`, and one
 * single quote inside it would end the word. `https.request` rather than `fetch`, because the
 * apiserver is behind the cluster CA and handing a CA to `fetch` means constructing an undici
 * agent to do what one option does here.
 *
 * The exit codes are the answer when there is no token: 3 the pod may not read the Secret, 4
 * there is no token in it, 5 the apiserver did not answer. The caller turns them into a
 * sentence rather than into an empty string, which is the distinction this whole change is
 * about.
 */
function podTokenReader(): string {
  return [
    'const fs=require("fs"),https=require("https");',
    'const D="/var/run/secrets/kubernetes.io/serviceaccount";',
    'https.request({host:process.env.KUBERNETES_SERVICE_HOST,port:process.env.KUBERNETES_SERVICE_PORT,',
    `path:"/api/v1/namespaces/${ EXT_NS }/secrets/${ SETTINGS_SECRET }",ca:fs.readFileSync(D+"/ca.crt"),`,
    'headers:{Authorization:"Bearer "+fs.readFileSync(D+"/token","utf8").trim()}},(r)=>{let t="";',
    'r.on("data",(c)=>{t+=c;});r.on("end",()=>{if(r.statusCode!==200){process.exit(3);}',
    `const d=(JSON.parse(t).data||{})["${ TOKEN_KEY }"];if(!d){process.exit(4);}`,
    'process.stdout.write(Buffer.from(d,"base64").toString("utf8").trim());});})',
    '.on("error",()=>process.exit(5)).end();',
  ].join('');
}

/**
 * Shell that leaves the token in `$BARN_GH_TOKEN`, or says why it could not.
 *
 * `|| { echo ... ; exit 0 ; }` rather than a bare failure, so the caller reads a marker it can
 * turn into "no GitHub token is configured" instead of a non-zero exit that says only that
 * something in a long script went wrong.
 */
function readTokenSh(): string {
  return `BARN_GH_TOKEN=$(node -e ${ shellQuote(podTokenReader()) }) || { echo "BARN-NO-TOKEN:$?" ; exit 0 ; }`;
}

/** What `BARN-NO-TOKEN:<code>` means, as a sentence somebody can act on. */
function noTokenReason(code: string): string {
  if (code === '4') {
    return 'no GitHub token is configured';
  }

  if (code === '3') {
    return `the extension pod may not read the ${ SETTINGS_SECRET } Secret, so it cannot get at the GitHub token`;
  }

  return 'the extension pod could not reach the Kubernetes API to read the GitHub token';
}

/**
 * A token-shaped string, blanked.
 *
 * The logs these functions return are shown in the UI, and until this they were scrubbed by
 * splitting on the token's own text - which only worked because the browser had a copy of it.
 * It does not any more, so the scrub is by shape instead: GitHub's own prefixes, and the
 * 40-hex classic form. It is belt and braces rather than the guard - nothing puts the token in
 * a command's text now, and git does not echo the header it was given - but a log that is shown
 * to a person is the wrong place to find out that assumption was wrong.
 */
function scrubTokens(text: string): string {
  return text
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '***')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/\b[0-9a-f]{40}\b(?=[^0-9a-f]|$)/g, (m) => (/^[0-9a-f]{40}$/.test(m) ? '***' : m));
}

/**
 * One GitHub API call, made from inside a pod, with the token the pod reads for itself.
 *
 * argv is `method path body`. The answer is one marker line carrying the body and the two
 * response headers that are not in it - the scopes a token carries and when it expires, both
 * of which the settings card states and neither of which is anywhere in a response body.
 *
 * The escapes in the final regex are doubled on purpose. This string is the *source* of a
 * script that runs in the pod, so a single-escaped \r\n here becomes a real carriage return
 * and newline inside the emitted regex literal, and node dies with "Invalid regular
 * expression: missing /" before it ever reaches the request. That is what it did: githubIdentity
 * and listGithubRepos have never once succeeded, and because a SyntaxError is not a 401 the
 * settings card could not even report the token as rejected.
 */
function githubScript(): string {
  return [
    'const fs=require("fs"),https=require("https");',
    'const D="/var/run/secrets/kubernetes.io/serviceaccount";',
    'const req=(o,b)=>new Promise((res,rej)=>{const r=https.request(o,(x)=>{let t="";',
    'x.on("data",(c)=>{t+=c;});x.on("end",()=>res({status:x.statusCode,text:t,headers:x.headers}));});',
    'r.on("error",rej);if(b){r.write(b);}r.end();});',
    'const main=async()=>{',
    'const s=await req({host:process.env.KUBERNETES_SERVICE_HOST,port:process.env.KUBERNETES_SERVICE_PORT,',
    `path:"/api/v1/namespaces/${ EXT_NS }/secrets/${ SETTINGS_SECRET }",ca:fs.readFileSync(D+"/ca.crt"),`,
    'headers:{Authorization:"Bearer "+fs.readFileSync(D+"/token","utf8").trim()}});',
    `if(s.status!==200){throw new Error("this pod may not read the ${ SETTINGS_SECRET } secret: "+s.status);}`,
    `const raw=(JSON.parse(s.text).data||{})["${ TOKEN_KEY }"];`,
    'if(!raw){throw new Error("no GitHub token is configured");}',
    'const token=Buffer.from(raw,"base64").toString("utf8").trim();',
    'const [method,path,body]=process.argv.slice(1);',
    'const g=await req({host:"api.github.com",path,method,headers:{Authorization:"Bearer "+token,',
    'Accept:"application/vnd.github+json","Content-Type":"application/json",',
    '"User-Agent":"rancher-extension-studio","Content-Length":Buffer.byteLength(body||"")}},body||undefined);',
    'if(g.status<200||g.status>=300){throw new Error(g.status+" "+g.text.slice(0,200));}',
    'console.log("BARN-GH:"+JSON.stringify({body:JSON.parse(g.text||"null"),',
    'scopes:g.headers["x-oauth-scopes"]||"",expires:g.headers["github-authentication-token-expiration"]||""}));};',
    'main().catch((e)=>console.log("BARN-GH-ERR:"+String(e.message).replace(/[\\r\\n]+/g," ")));',
  ].join('');
}

/** What the pod said, as the answer or as a thrown error. Shared by the two callers below. */
function readGithubAnswer(out: string, where: string): any {
  const noToken = /BARN-NO-TOKEN:(\d+)/.exec(out);

  if (noToken) {
    throw new Error(noTokenReason(noToken[1]));
  }

  const failed = /BARN-GH-ERR:(.*)/.exec(out);

  if (failed) {
    throw new Error(failed[1].trim() || 'GitHub did not answer');
  }

  const found = /BARN-GH:(.*)/.exec(out);

  if (!found) {
    throw new Error(`could not reach GitHub from ${ where }: ${ scrubTokens(out.trim()).slice(0, 200) || 'no output' }`);
  }

  try {
    return JSON.parse(found[1].trim());
  } catch {
    throw new Error('GitHub answered with something unreadable');
  }
}

/**
 * The files of a repository, cloned in a pod and read back.
 *
 * In a pod rather than in the browser because the alternative is the GitHub API, which hands
 * back a tree and then one request per blob - forty-odd of them for an extension - and cannot
 * do it at all for a repository whose files somebody has to be logged in to read. `git clone`
 * is one command that already handles both, and there is a container here that has git in it.
 */
async function githubFiles(repo: string, ref: string, fallbackName: string): Promise<Record<string, string>> {
  const pod = await anyRunningPod();

  if (!pod) {
    throw new Error('importing needs one extension already running, because the clone happens in its pod');
  }

  const branchArg = ref ? `--branch ${ shellQuote(ref) }` : '';

  // Public repositories need no token, and a token that cannot be had must not stop one being
  // imported: `BARN_GH_TOKEN=` empty simply means no authorization header. A private repository
  // without one fails in `git clone` with GitHub's own message, which says more than a check
  // here would.
  //
  // The header reaches git through `--config-env`, so the credential is in the environment and
  // not in any command's arguments - neither in the browser's, which no longer has it, nor in
  // the pod's process list.
  const clone = await podExecOnce(pod, asPodUser([
    `BARN_GH_TOKEN=$(node -e ${ shellQuote(podTokenReader()) } || true)`,
    'BARN_GH_HEADER=""',
    '[ -n "$BARN_GH_TOKEN" ] && BARN_GH_HEADER="AUTHORIZATION: basic $(printf %s "x-access-token:$BARN_GH_TOKEN" | base64 -w0)"',
    'export BARN_GH_HEADER',
    'rm -rf /tmp/barn-import',
    `git $([ -n "$BARN_GH_HEADER" ] && echo --config-env=http.extraheader=BARN_GH_HEADER) clone --depth 1 ${ branchArg } ${ shellQuote(`https://github.com/${ repo }.git`) } /tmp/barn-import 2>&1 || exit 1`,
    'echo BARN-CLONE-OK',
  ].join(' ; ')));

  if (!clone.includes('BARN-CLONE-OK')) {
    throw new Error(scrubTokens(`could not clone ${ repo }: ${ clone.slice(0, 400) || 'no output' }`));
  }

  const encoded = btoa(IMPORT_SCRIPT);
  const script = '/tmp/barn-import.js';

  await podExecOnce(pod, asPodUser(`echo ${ encoded } | base64 -d > ${ script }`));

  const out = await podExecOnce(pod, asPodUser(
    `BARN_IMPORT_NAME=${ shellQuote(fallbackName) } node ${ script }`
  ));

  let tree: Record<string, string>;

  try {
    tree = JSON.parse(out);
  } catch {
    throw new Error(`could not read ${ repo }'s tree: ${ out.slice(0, 200) || 'no output' }`);
  }

  if (!Object.keys(tree).length) {
    throw new Error(`${ repo } has no files to import`);
  }

  // Tidy up after ourselves: this pod belongs to an extension somebody is working in, and a
  // clone left in its /tmp is the next person's confusion.
  await podExecOnce(pod, asPodUser('rm -rf /tmp/barn-import /tmp/barn-import.js')).catch(() => null);

  return withSkeleton(tree);
}

export function deploymentBody(name: string): Record<string, unknown> {
  const object = extensionObject(name);

  return {
    apiVersion: 'apps/v1',
    kind:       'Deployment',
    metadata:   { namespace: EXT_NS, name: object, labels: { app: object } },
    spec:       {
      replicas: 1,
      selector: { matchLabels: { app: object } },
      // Recreate, not RollingUpdate: /app is a hostPath, so two dev servers
      // would be watching and rebuilding the same tree at the same time.
      strategy: { type: 'Recreate' },
      template: {
        metadata: { labels: { app: object } },
        spec:     {
          serviceAccountName: EXT_ACCOUNT,
          containers:         [{
            name:    EXT_CONTAINER,
            image:   EXT_IMAGE,
            command: ['/bin/sh', '/seed/boot.sh'],
            ports:   [{ name: 'http', containerPort: EXT_PORT }],
            env:     [
              { name: 'DEV_PROXY_PATH', value: extensionProxyPath(name) },
              // The pod's own name for itself. Its terminal prompt, its CLAUDE.md and the
              // sync script all want it, and working it out from the proxy path in three
              // places is three chances to work it out differently.
              { name: 'EXTENSION_NAME', value: name },
              { name: 'NODE_ENV', value: 'dev' },
              // Which Service the browser is, so a terminal in here does not have to be
              // told. One browser serves every extension - see ensureBrowser. The name
              // rather than a URL on purpose: Chromium rejects a CDP request whose Host
              // header is not an IP, so this has to be resolved before it is used, and a
              // variable that looked like a working endpoint would be worse than none.
              { name: 'BARN_BROWSER_SERVICE', value: BROWSER_OBJECT },
              { name: 'BARN_BROWSER_CDP_PORT', value: `${ BROWSER_CDP_PORT }` },
              // Rancher's address from inside the cluster, which is the node's:
              // this cluster is k3s inside the Rancher container. With
              // DEV_PROXY_PATH above it is the whole absolute URL of this
              // extension's own dashboard, which is what the browser has to be
              // pointed at - a root-relative path means nothing to a driver.
              { name: 'NODE_IP', valueFrom: { fieldRef: { fieldPath: 'status.hostIP' } } },
              // A dashboard build is big enough to OOM node's default heap.
              { name: 'NODE_OPTIONS', value: '--max_old_space_size=4096' },
            ],
            volumeMounts: [
              { name: 'seed', mountPath: '/seed' },
              { name: 'app', mountPath: '/app' },
            ],
            // Installing and the first compile take minutes. A startup probe
            // with a long budget is what keeps the kubelet from restarting a
            // pod that is working fine, and restarting it is not harmless,
            // since it would throw away a part-finished install.
            startupProbe: {
              httpGet:          { path: '/index.html', port: EXT_PORT },
              periodSeconds:    10,
              failureThreshold: 90,
            },
            readinessProbe: {
              httpGet:       { path: '/index.html', port: EXT_PORT },
              periodSeconds: 10,
            },
          }],
          volumes: [
            { name: 'seed', configMap: { name: object } },
            { name: 'app', hostPath: { path: hostCachePath(name), type: 'DirectoryOrCreate' } },
          ],
        },
      },
    },
  };
}

/**
 * The namespace and the ServiceAccount, which every extension shares.
 *
 * Separate from ensureExtension because it is per cluster rather than per
 * extension, and because a second extension should not re-POST a ClusterRoleBinding
 * that is already there.
 */
/**
 * Create one object if it is not already there, and treat losing the race as success.
 *
 * Every install goes through this, and the reason it is one function is the refresh case. The
 * state that matters lives in the cluster rather than in the page: a reload re-reads what
 * exists and makes only what does not, so an install interrupted half way finishes rather
 * than starting over.
 *
 * Which leaves the gap between the read and the write, and that is what the 409 is for. Two
 * tabs opened at once both see nothing and both POST; one wins and the other is told the
 * object already exists. That is the outcome both of them wanted, so it is success and not an
 * error - without which a refresh at exactly the wrong moment is the one thing that reports a
 * failure.
 */
export interface ObjectSpec {
  type: string;
  namespace?: string;
  name: string;
  body: () => Record<string, unknown>;
}

export function objectPath(spec: { type: string; namespace?: string; name: string }): string {
  return spec.namespace
    ? `${ EXT_BASE }/v1/${ spec.type }/${ spec.namespace }/${ spec.name }`
    : `${ EXT_BASE }/v1/${ spec.type }/${ spec.name }`;
}

export async function objectExists(spec: { type: string; namespace?: string; name: string }): Promise<boolean> {
  return !!await rancherFetch(objectPath(spec)).catch(() => null);
}

export async function createIfAbsent(spec: ObjectSpec): Promise<'present' | 'created'> {
  if (await objectExists(spec)) {
    return 'present';
  }

  try {
    await rancherFetch(`${ EXT_BASE }/v1/${ spec.type }`, { method: 'POST', body: JSON.stringify(spec.body()) });

    return 'created';
  } catch (e: any) {
    if (/409|already exists|alreadyexists/i.test(e?.message || '')) {
      return 'present';
    }

    throw e;
  }
}

/** The namespace everything here lives in. */
export function namespaceBody(): Record<string, unknown> {
  return { apiVersion: 'v1', kind: 'Namespace', metadata: { name: EXT_NS } };
}

/** The account the pods run as. See EXT_ACCOUNT for what it is allowed to do. */
export function serviceAccountBody(): Record<string, unknown> {
  return { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { namespace: EXT_NS, name: EXT_ACCOUNT } };
}

/** The grant. See EXT_ACCOUNT above for why this is cluster-admin. */
export function clusterRoleBindingBody(): Record<string, unknown> {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind:       'ClusterRoleBinding',
    metadata:   { name: EXT_ROLE_BINDING },
    roleRef:    { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' },
    subjects:   [{ kind: 'ServiceAccount', name: EXT_ACCOUNT, namespace: EXT_NS }],
  };
}

/** The ClusterIP the service proxy resolves to, for an extension or for the browser. */
export function serviceBody(object: string, ports: Record<string, unknown>[]): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind:       'Service',
    metadata:   { namespace: EXT_NS, name: object, labels: { app: object } },
    spec:       { selector: { app: object }, ports },
  };
}

export const EXT_PORTS = [{ name: 'http', port: EXT_PORT, targetPort: 'http' }];

/**
 * The seed ConfigMap for an extension made from a built-in seed.
 *
 * Only the built-in ones, and that is not a limitation so much as a division: a clone reads
 * another pod and an import clones a repository, both of which are work rather than a value,
 * and both are asked for on demand rather than during the install a fresh cluster runs by
 * itself. Those go through ensureExtension, which can wait for them.
 */
export function seedConfigMapBody(name: string, source: string = DEFAULT_SEED): Record<string, unknown> {
  const object = extensionObject(name);
  const from = BUILT_IN_SEEDS.includes(source) ? source : DEFAULT_SEED;

  return {
    apiVersion: 'v1',
    kind:       'ConfigMap',
    metadata:   {
      namespace:   EXT_NS,
      name:        object,
      labels:      { app: object },
      annotations: { [SOURCE_ANNOTATION]: from },
    },
    data: seedData(renameSeedPackage(seedFiles(from), from, name)),
  };
}

/**
 * The grant a reviewer needs, which is not the grant the pods have.
 *
 * Signing off writes the `barn-review-<extension>` ConfigMap in this namespace, and today
 * everything in here is admin territory in practice. This creates the Role; binding it to
 * somebody is an admin decision and not one an extension gets to make for them.
 *
 * Until a reviewer is bound, reading the record still works (a missing ConfigMap and a
 * forbidden one both read as "nothing recorded"), and the sign-off controls have to be
 * disabled with the real reason shown. An enabled button that turns into a 403 is the failure
 * this exists to make visible.
 */
export const REVIEWER_ROLE = 'barn-reviewer';

export function reviewerRoleBody(): Record<string, unknown> {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind:       'Role',
    metadata:   { namespace: EXT_NS, name: REVIEWER_ROLE },
    rules:      [{
      apiGroups: [''],
      resources: ['configmaps'],
      verbs:     ['get', 'list', 'create', 'update', 'patch'],
    }],
  };
}

async function ensureShared(): Promise<void> {
  await createIfAbsent({ type: 'namespaces', name: EXT_NS, body: namespaceBody });
  await createIfAbsent({ type: 'serviceaccounts', namespace: EXT_NS, name: EXT_ACCOUNT, body: serviceAccountBody });
  await createIfAbsent({
    type: 'rbac.authorization.k8s.io.clusterrolebindings', name: EXT_ROLE_BINDING, body: clusterRoleBindingBody,
  });
  await createIfAbsent({
    type: 'rbac.authorization.k8s.io.roles', namespace: EXT_NS, name: REVIEWER_ROLE, body: reviewerRoleBody,
  });
}

/**
 * The pod and the Service, without touching the seed.
 *
 * Split out because "make sure this is running" and "seed this" stopped being the same thing:
 * a call that does not know what an extension was made from must still be able to start it.
 */
async function ensureRunning(name: string, object: string): Promise<void> {
  // Deployment (node running the dev server over the seeded tree)
  const existing = await extGet('apps.deployments', object);

  if (!existing) {
    await rancherFetch(`${ EXT_BASE }/v1/apps.deployments`, {
      method: 'POST',
      body:   JSON.stringify(deploymentBody(name)),
    }).catch(() => null);
  } else if (existing.spec?.template?.spec?.serviceAccountName !== EXT_ACCOUNT) {
    // The one thing an existing Deployment is brought up to date on.
    //
    // Everything else here is deliberately create-if-missing, because replacing a Deployment
    // restarts a dev server somebody is editing in. This is the exception because a pod
    // running as `default` has no rights at all, which is the difference between a terminal
    // that can answer questions about the cluster and one that gets 403 to all of them - and
    // no amount of granting fixes it, because the grant is to an account the pod is not using.
    //
    // It costs one restart, once. The tree and node_modules are on a hostPath, so the pod is
    // back in seconds rather than reinstalling; what it does end is any tmux session in it.
    existing.spec.template.spec.serviceAccountName = EXT_ACCOUNT;

    await rancherFetch(`${ EXT_BASE }/v1/apps.deployments/${ EXT_NS }/${ object }`, {
      method: 'PUT',
      body:   JSON.stringify(existing),
    }).catch(() => null);
  }

  // Service (ClusterIP :8005, what the service proxy above resolves to)
  await createIfAbsent({ type: 'services', namespace: EXT_NS, name: object, body: () => serviceBody(object, EXT_PORTS) });
}

// `| undefined` on purpose: an index signature without it types every lookup as a live promise,
// so the guard below reads as always-true and `yarn build-pkg` refuses it (TS2801).
const ensureInFlight: Record<string, Promise<void> | undefined> = {};

/**
 * Create an extension's seed ConfigMap, Deployment and Service if they aren't
 * there yet.
 *
 * Idempotent and safe to call repeatedly (dedup'd in-flight per name); swallows
 * errors (e.g. the user lacks create rights) so it can never break a page. The
 * ConfigMap is upserted so a newer seed reaches an existing cluster; the
 * Deployment and Service are create-if-missing, because replacing them would
 * restart a dev server somebody is editing in.
 *
 * `extras` is files to lay over the seed, keyed by their path inside the extension's own
 * package (`product.ts`, `BRIEF.md`, `routing/index.ts`). It is how a decision taken before
 * the pod exists reaches the tree: at creation time there is nowhere else to put one, since
 * the pod that would take a `writeExtensionFile` is minutes from existing and the seed
 * ConfigMap is the only thing it reads on the way up. Optional, and an omitted `extras`
 * leaves every caller behaving exactly as it did.
 */
export function ensureExtension(name: string, source?: string, extras?: Record<string, string>): Promise<void> {
  const inFlight = ensureInFlight[name];

  if (inFlight) {
    return inFlight;
  }

  const object = extensionObject(name);

  const started = (async() => {
    await ensureShared();

    // Seed ConfigMap (upsert). The pod only writes seeded files it doesn't
    // already have, so this adds new files to a running tree without touching
    // what has been edited in there.
    const cm = await extGet('configmaps', object);
    const recorded = cm?.metadata?.annotations?.[SOURCE_ANNOTATION];
    // What this extension is made of, in order of who actually knows: the caller if it was
    // told, then what this extension was made from before, then the default - which is only
    // ever right for something being created now.
    const from = source || recorded || DEFAULT_SEED;

    // A call with no source, against an extension that predates the annotation, is the one
    // case with no answer. Leaving the seed alone is the safe half of the guess: a tree that
    // is missing a file the bundle has since added is a smaller problem than a tree seeded
    // from a different extension.
    if (cm && !source && !recorded) {
      await ensureRunning(name, object);

      return;
    }

    // A clone reads the source pod; a built-in seed is already here. Either way the result is
    // one ConfigMap, and from the pod's point of view there is no difference between them.
    // Three kinds of source: a built-in seed that is already in this bundle, a repository
    // to clone, and the name of an extension running here to copy out of its pod.
    const github = parseGithubSource(from);
    let files: Record<string, string>;

    if (BUILT_IN_SEEDS.includes(from)) {
      files = renameSeedPackage(seedFiles(from), from, name);
    } else if (github) {
      files = await githubFiles(github.repo, github.ref, name);
    } else {
      files = await cloneFiles(from);
    }

    // Laid over the assembled tree, not merged into the seed: a file named here is meant to
    // win over the seed's copy of it, which is the whole point of handing one in. The package
    // directory is read off the tree rather than assumed to be the extension's name - an
    // imported repository keeps its own package name, and PACKAGE_DIR in the pod resolves the
    // same way, by looking.
    const authored: string[] = [];

    if (extras && Object.keys(extras).length) {
      const prefix = Object.keys(files).map((k) => /^(pkg\/[^/]+\/)/.exec(k)?.[1]).find(Boolean);

      if (prefix) {
        for (const [relative, contents] of Object.entries(extras)) {
          files[prefix + relative] = contents;
          authored.push(encodeSeedKey(prefix + relative));
        }
      }
    }

    const data = seedData(files);
    const annotations: Record<string, string> = { [SOURCE_ANNOTATION]: from };

    if (authored.length) {
      annotations[AUTHORED_ANNOTATION] = authored.join(',');
    } else if (cm) {
      // Nothing new was handed in, so whatever was authored before is still the answer. Carry
      // the keys over from the ConfigMap as it stands, and the list with them.
      const previous = (cm.metadata?.annotations?.[AUTHORED_ANNOTATION] || '').split(',').filter(Boolean);

      previous.forEach((key: string) => {
        if (cm.data?.[key] !== undefined) {
          data[key] = cm.data[key];
        }
      });

      if (previous.length) {
        annotations[AUTHORED_ANNOTATION] = previous.join(',');
      }
    }

    if (cm) {
      await rancherFetch(`${ EXT_BASE }/v1/configmaps/${ EXT_NS }/${ object }`, {
        method: 'PUT',
        body:   JSON.stringify({
          ...cm,
          metadata: { ...cm.metadata, annotations: { ...(cm.metadata?.annotations || {}), ...annotations } },
          data,
        }),
      }).catch(() => null);
    } else {
      await rancherFetch(`${ EXT_BASE }/v1/configmaps`, {
        method: 'POST',
        body:   JSON.stringify({
          apiVersion: 'v1',
          kind:       'ConfigMap',
          metadata:   {
            namespace: EXT_NS, name: object, labels: { app: object }, annotations,
          },
          data,
        }),
      }).catch(() => null);
    }

    await ensureRunning(name, object);
  })().finally(() => {
    delete ensureInFlight[name];
  });

  ensureInFlight[name] = started;

  return started;
}

/** The one every Rancher gets, created when this bundle loads. */
export function ensureDefaultExtension(): Promise<void> {
  return ensureExtension(DEFAULT_EXTENSION);
}

// ---------------------------------------------------------------------------
// The browser the editor looks at its own changes in.
// ---------------------------------------------------------------------------

/**
 * One browser for the namespace, not one per extension.
 *
 * What it is for is claude in an extension pod being able to look at the page it
 * just changed, and that wants a browser that is already logged in and already
 * pointed somewhere rather than a fresh one per tree. It is also the most
 * expensive thing in here - Chromium with a desktop around it - so a second one
 * would be paid for again on every extension anybody creates.
 */
export const BROWSER_OBJECT = 'barn-browser';

/**
 * The image the closet's own browser sidecar runs, and the harness's Browser tab
 * with it: Chromium plus a web UI in front of it, so the thing a person frames is
 * a page rather than a screen protocol that would need a plugin.
 */
const BROWSER_IMAGE = 'lscr.io/linuxserver/chromium:latest';

/**
 * Its web UI, on the port CUSTOM_PORT tells it to serve. Plain http inside the
 * cluster, because Rancher's proxy terminates the TLS a person's browser sees and
 * would not talk to this image's self-signed certificate on the way through.
 */
const BROWSER_UI_PORT = 3000;

/**
 * Chromium's DevTools protocol, which is the half of this the workspace browser
 * does not have.
 *
 * That one drops its CDP flags on purpose, because it is there for a person to
 * look at. This one is driven: something opens a page, waits for the dev server
 * to finish compiling, reads the console and takes a screenshot, and none of that
 * is reachable through a web UI built for a mouse.
 *
 * It is bound to 0.0.0.0 and unauthenticated, which is worth saying plainly:
 * anything that can reach this Service can drive this browser, and this browser
 * holds a Rancher session. That is the same set of people who can already open a
 * terminal in an extension pod - see EXT_ACCOUNT - so it widens what is reachable
 * without widening who can reach it.
 */
const BROWSER_CDP_PORT = 9222;

/**
 * The ConfigMap holding the two s6 services the image runs alongside Chromium.
 *
 * Both are copies of the closet's own browser sidecar (`workspace/sidecars/dev/
 * rancher-browser/`), which runs this same image outside Kubernetes and needed
 * both for the same reasons. Copied rather than shared because an extension
 * bundle cannot read the repo it was built from, and kept as whole files rather
 * than command lines because each has an ordering in it.
 */
export const BROWSER_SERVICES = 'barn-browser-services';

/**
 * Republishes CDP on the pod's own address.
 *
 * Headful Chromium binds its DevTools port to 127.0.0.1 and cannot be told not
 * to, so without this the Service's port 9222 answers connection refused from
 * everywhere except inside this container.
 *
 * The consequence for whoever drives it is the one thing to know about this
 * browser: Chromium validates the Host header on that port and rejects anything
 * that is not an IP or localhost, so `barn-browser:9222` gets a 403 while the
 * Service's ClusterIP works. See the seeded CLAUDE.md, which says so where it
 * will be read.
 */
const CDP_PROXY = String.raw`#!/usr/bin/with-contenv bash
# s6 service (mounted into /custom-services.d/): exposes Chromium's CDP to the
# compose network. Headful Chromium only binds 127.0.0.1:9222, so we forward
# <container-ip>:9222 -> 127.0.0.1:9222. Connect using the IP, not the
# service name - Chrome rejects non-localhost/non-IP Host headers.
exec python3 - <<'PYEOF'
import asyncio, socket

def container_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.connect(('10.255.255.255', 1))  # no traffic sent; selects default-route iface
    ip = s.getsockname()[0]
    s.close()
    return ip

async def pipe(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass

async def handle(client_r, client_w):
    try:
        upstream_r, upstream_w = await asyncio.open_connection('127.0.0.1', 9222)
    except Exception:
        client_w.close()
        return
    await asyncio.gather(pipe(client_r, upstream_w), pipe(upstream_r, client_w))

async def main():
    ip = container_ip()
    server = await asyncio.start_server(handle, ip, 9222)
    print(f'cdp-proxy: {ip}:9222 -> 127.0.0.1:9222', flush=True)
    async with server:
        await server.serve_forever()

asyncio.run(main())
PYEOF
`;

/**
 * Holds one display client connected so screenshots keep working.
 *
 * Selkies resizes the virtual display to 1x1 when the last viewer disconnects,
 * and Page.captureScreenshot then hangs rather than failing. A browser that is
 * driven rather than watched is in that state almost always, which is why this
 * is here and not in the workspace browser: that one has a person in front of it.
 */
const STREAM_KEEPALIVE = String.raw`#!/usr/bin/with-contenv bash
# s6 service: hold ONE Selkies display client connected at all times so the
# virtual display never tears down to 1x1. Selkies resizes the display to 1x1
# when the LAST viewer disconnects; once it's 1x1, Chromium's CDP
# Page.captureScreenshot hangs forever (verified: it returns in ~50ms while a
# client is held, and HANGs ~10s after the last client leaves).
#
# We deliberately do NOT send START_VIDEO: a connected client alone keeps the
# display alive (verified across the teardown window), and streaming would just
# encode+transmit frames nothing reads. We also don't pin manual-resolution mode,
# so a real human viewer on :8303 connecting at their own size takes over cleanly.
# (Holding a client does cost ~8% of one core in the Selkies capture loop - that's
# inherent to this image whenever the display is held full-size for headless
# screenshots, not the video stream.)
exec python3 - <<'PYEOF'
import asyncio, json
import websockets

URI = "ws://127.0.0.1:3000/websocket"
# Minimal: assert a usable display size (so headless screenshots aren't 1x1),
# but not manual-resolution mode - a human viewer's own size then wins.
SETTINGS = "SETTINGS," + json.dumps({
    "initialClientWidth": 1280, "initialClientHeight": 800, "displayId": "primary",
})

async def run():
    delay = 1
    while True:
        try:
            async with websockets.connect(URI, max_size=None, ping_interval=20, open_timeout=10) as ws:
                await ws.send(SETTINGS)
                await ws.send("r,1280x800,primary")
                print("stream-keepalive: holding display (no video)", flush=True)
                delay = 1  # reset backoff once a session is established
                async for _ in ws:  # stay connected; drain any server messages
                    pass
        except Exception as e:
            # Selkies not up yet (boot) or the connection dropped - back off so we
            # don't churn/log-spam every 3s indefinitely if it never comes up.
            print(f"stream-keepalive: reconnect in {delay}s ({e})", flush=True)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)

asyncio.run(run())
PYEOF
`;

/** Where a person watches it: the same service proxy every other page here is on. */
export function browserUrl(): string {
  return `${ EXT_BASE }/api/v1/namespaces/${ EXT_NS }/services/http:${ BROWSER_OBJECT }:${ BROWSER_UI_PORT }/proxy/`;
}

export function browserDeployment(): Record<string, unknown> {
  return {
    apiVersion: 'apps/v1',
    kind:       'Deployment',
    metadata:   { namespace: EXT_NS, name: BROWSER_OBJECT, labels: { app: BROWSER_OBJECT } },
    spec:       {
      replicas: 1,
      selector: { matchLabels: { app: BROWSER_OBJECT } },
      // Recreate rather than RollingUpdate: two Chromiums sharing one profile
      // directory is a browser that will not start, and the second one wins the
      // race often enough to look intermittent.
      strategy: { type: 'Recreate' },
      template: {
        metadata: { labels: { app: BROWSER_OBJECT } },
        spec:     {
          containers: [{
            name:  'browser',
            image: BROWSER_IMAGE,
            ports: [
              { name: 'http', containerPort: BROWSER_UI_PORT },
              { name: 'cdp', containerPort: BROWSER_CDP_PORT },
            ],
            env: [
              // The image runs as this user and writes its profile as it. A
              // root-owned profile in a container that then drops privileges is a
              // browser that cannot start twice.
              { name: 'PUID', value: '1000' },
              { name: 'PGID', value: '1000' },
              { name: 'CUSTOM_PORT', value: `${ BROWSER_UI_PORT }` },
              { name: 'TITLE', value: 'Barn' },
              // The node's address, which is the one thing in here nothing else
              // knows: the kubelet telling the pod where it is running. This
              // cluster is k3s inside the Rancher container, so the node and
              // Rancher are the same address, and it is how a pod reaches Rancher
              // without being told a hostname. Declared before CHROME_CLI because
              // Kubernetes expands $(VAR) only against variables already listed.
              { name: 'NODE_IP', valueFrom: { fieldRef: { fieldPath: 'status.hostIP' } } },
              {
                name: 'CHROME_CLI',
                // What it opens on: the default extension's dev server, through
                // the same service proxy a person would reach it at, on Rancher's
                // own origin. It opens on Rancher's login page the first time,
                // because a fresh profile has no session - see the CLAUDE.md in
                // the seed for the log-in-then-navigate the driver does about it.
                //
                // --ignore-certificate-errors is the flag that is not cosmetic:
                // Rancher serves its own certificate here and without this the
                // browser opens on an interstitial instead of the page.
                // --remote-allow-origins is the one that is easy to miss: recent
                // Chromium refuses a CDP websocket whose Origin it does not know,
                // which reads as a driver that connects and then hangs.
                // The backgrounding flags are not cosmetic either: Chromium throttles a
                // renderer nothing is looking at, and a driven browser is exactly that, so
                // without them Page.captureScreenshot answers slowly or not at all.
                //
                // --remote-debugging-address is deliberately absent. Headful Chromium binds
                // CDP to 127.0.0.1 whatever it is told, so that flag is a no-op that would
                // only fight the forwarder below for the port if a future Chromium honoured
                // it. The closet's own browser sidecar says the same thing at more length.
                value: `https://$(NODE_IP)${ extensionUrl(DEFAULT_EXTENSION) } --no-first-run --start-maximized --disable-infobars --disable-session-crashed-bubble --hide-crash-restore-bubble --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling --allow-insecure-localhost --ignore-certificate-errors --remote-debugging-port=${ BROWSER_CDP_PORT } --allow-running-insecure-content`,
              },
            ],
            // A memory-backed /dev/shm rather than the 64MB a container gets by
            // default. It is the pod's own memory, and Chromium is the one thing
            // here that has ever needed it: below about this, a page with a
            // dashboard in it crashes the tab rather than rendering slowly.
            volumeMounts: [
              { name: 'dshm', mountPath: '/dev/shm' },
              // One mount per file with subPath, because each of these is a file the image
              // runs, not a directory: /custom-services.d holds one executable per service.
              { name: 'services', mountPath: '/custom-services.d/cdp-proxy', subPath: 'cdp-proxy', readOnly: true },
              { name: 'services', mountPath: '/custom-services.d/stream-keepalive', subPath: 'stream-keepalive', readOnly: true },
            ],
            // Ready when CDP answers, not when the container starts. The web UI
            // comes up before Chromium does, so probing the UI port would say
            // ready to a driver that then gets connection refused.
            readinessProbe: {
              httpGet:       { path: '/json/version', port: BROWSER_CDP_PORT },
              periodSeconds: 10,
            },
          }],
          volumes: [
            // A container gets 64MB of shared memory by default and Chromium's renderers pass
            // their surfaces through it: the documented symptom of leaving it there is tabs
            // dying as "Aw, Snap". Memory-backed, so it is the pod's own memory.
            { name: 'dshm', emptyDir: { medium: 'Memory', sizeLimit: '1Gi' } },
            // 0o555: the image execs these, so they have to arrive executable.
            { name: 'services', configMap: { name: BROWSER_SERVICES, defaultMode: 0o555 } },
          ],
        },
      },
    },
  };
}

let ensureBrowserInFlight: Promise<void> | null = null;

/**
 * Create the browser's Deployment and Service if they aren't there yet.
 *
 * Idempotent, deduped in flight and error-swallowing, for the same reasons
 * ensureExtension is: it runs when the bundle loads, in front of a page, on
 * behalf of somebody who may not be allowed to create any of it.
 *
 * Create-if-missing rather than upsert, because replacing the Deployment
 * restarts the browser - which throws away the Rancher session in its profile
 * and whatever page somebody was looking at.
 */
/** The two s6 services the browser image runs beside Chromium. */
export function browserServicesBody(): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind:       'ConfigMap',
    metadata:   { namespace: EXT_NS, name: BROWSER_SERVICES, labels: { app: BROWSER_OBJECT } },
    data:       { 'cdp-proxy': CDP_PROXY, 'stream-keepalive': STREAM_KEEPALIVE },
  };
}

export const BROWSER_PORTS = [
  { name: 'http', port: BROWSER_UI_PORT, targetPort: 'http' },
  { name: 'cdp', port: BROWSER_CDP_PORT, targetPort: 'cdp' },
];

/**
 * Bring the s6 services up to date on a browser that already exists.
 *
 * The one upsert in the install, and it is deliberate: these are read off the mount at boot, so
 * a corrected script reaches a running pod on its next restart rather than needing a new one.
 * Everything else is create-if-absent, because replacing it restarts something in use.
 */
export async function refreshBrowserServices(): Promise<void> {
  const cm = await extGet('configmaps', BROWSER_SERVICES);

  if (!cm) {
    return;
  }

  await rancherFetch(`${ EXT_BASE }/v1/configmaps/${ EXT_NS }/${ BROWSER_SERVICES }`, {
    method: 'PUT',
    body:   JSON.stringify({ ...cm, data: (browserServicesBody() as any).data }),
  }).catch(() => null);
}

export function ensureBrowser(): Promise<void> {
  if (ensureBrowserInFlight) {
    return ensureBrowserInFlight;
  }

  ensureBrowserInFlight = (async() => {
    await ensureShared();
    await createIfAbsent({ type: 'configmaps', namespace: EXT_NS, name: BROWSER_SERVICES, body: browserServicesBody });
    await refreshBrowserServices();
    await createIfAbsent({ type: 'apps.deployments', namespace: EXT_NS, name: BROWSER_OBJECT, body: browserDeployment });
    await createIfAbsent({
      type: 'services', namespace: EXT_NS, name: BROWSER_OBJECT, body: () => serviceBody(BROWSER_OBJECT, BROWSER_PORTS),
    });
  })().finally(() => {
    ensureBrowserInFlight = null;
  });

  return ensureBrowserInFlight;
}

/**
 * WebSocket URL for a shell in an extension's pod.
 *
 * This is the Kubernetes exec subresource, the same one the dashboard's own
 * container shell uses, so it carries the browser's Rancher session and needs
 * nothing else to authenticate. The protocol is `base64.channel.k8s.io`: every
 * frame is a channel digit (0 stdin, 1 stdout, 2 stderr, 3 error, 4 resize)
 * followed by base64.
 *
 * The command is `/seed/shell.sh`, which is in the pod's ConfigMap rather than
 * its filesystem, so what a tab starts is whatever this extension last wrote.
 */
export function extensionShellUrl(pod: string, session: string, mode: PaneMode = 'claude'): string {
  // The empty strings are shell.sh's optional working directory and home
  // directory: it reads the pane's mode from $4, so the two it defaults for
  // itself still have to be occupied.
  return execUrl(pod, ['/bin/sh', '/seed/shell.sh', session, '', '', mode], true);
}

/**
 * What a pane runs. `claude` is the assistant's session; `shell` is a plain
 * login shell, which is what the Terminal tab wants.
 */
export type PaneMode = 'claude' | 'shell';

/** The exec subresource, for a shell (tty, stdin) or for one command (neither). */
function execUrl(pod: string, command: string[], interactive: boolean): string {
  const origin = window.location.origin.replace(/^http/, 'ws');
  const params = new URLSearchParams({
    container: EXT_CONTAINER,
    stdin:     interactive ? '1' : '0',
    stdout:    '1',
    stderr:    '1',
    tty:       interactive ? '1' : '0',
  });

  // Repeated, not comma-joined: this is argv.
  for (const arg of command) {
    params.append('command', arg);
  }

  return `${ origin }${ EXT_BASE }/api/v1/namespaces/${ EXT_NS }/pods/${ pod }/exec?${ params }`;
}

/**
 * How long an exec may go without finishing before it is treated as broken.
 *
 * Generous, because the slowest thing anybody runs through here is a package build in the pod
 * and that legitimately takes minutes. It is not a performance budget - it is the difference
 * between a caller that fails and a caller that waits forever. Reads that should be quick pass
 * their own, shorter, value.
 */
const EXEC_TIMEOUT_MS = 240000;

/**
 * Everything one exec produced: its output, its error output, and whether it worked.
 *
 * This exists because for most of this product's life it did not, and the cost was two silent
 * data losses. `podExecOnce` read channel 1 and dropped channels 2 and 3 on the floor, so a
 * command that failed came back as the empty string and was indistinguishable from one that
 * succeeded and printed nothing. A `package.json` owned by root in a pod whose execs run as
 * uid 1000 made the publish dialog's version write do nothing, say nothing, and ship the old
 * version; a root-owned `.git/objects` made every `createSnapshot` fail the same way, which
 * quietly removed the safety snapshot taken before a rollback and before apply-fix overwrites
 * a file. Both failures were reported by the apiserver on channel 3 and nothing was listening.
 */
export interface PodExecResult {
  /** Channel 1. */
  stdout: string;
  /** Channel 2. Empty for a command that redirected it, which several here still do. */
  stderr: string;
  /**
   * The command's exit status: 0 when it succeeded, its own code when it failed, and -1 when
   * it never ran at all (the socket was refused, the container does not exist, the connection
   * dropped before the apiserver could say how it went).
   */
  code:   number;
  /** The apiserver's own status line, verbatim. '' when the command succeeded. */
  status: string;
  /** True when the failure is the connection rather than the command. */
  transport: boolean;
}

/**
 * What the apiserver said on channel 3, as an exit code.
 *
 * Two wire formats, and which one arrives depends on the subprotocol that was negotiated.
 * Rancher's proxy accepts `base64.channel.k8s.io` and refuses `base64.v4.channel.k8s.io`
 * outright - the socket does not open - so what actually arrives here today is v1's prose:
 *
 *   command terminated with non-zero exit code: error executing command [...], exit code 3
 *
 * The v4 form is a `metav1.Status` as JSON, and is read too, so this keeps working if the
 * proxy ever negotiates it. Nothing at all on channel 3 means the command succeeded: v1 sends
 * the frame only when something went wrong.
 */
function statusExitCode(status: string): number {
  const text = status.trim();

  if (!text) {
    return 0;
  }

  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);

      if (parsed?.status === 'Success') {
        return 0;
      }

      const cause = (parsed?.details?.causes || []).find((c: any) => c?.reason === 'ExitCode');
      const code = parseInt(cause?.message, 10);

      return Number.isFinite(code) ? code : -1;
    } catch { /* not the JSON form after all, so read it as prose below */ }
  }

  const m = /exit code (\d+)/.exec(text);

  return m ? parseInt(m[1], 10) : -1;
}

/**
 * Run one command in an extension's pod and report everything about how it went.
 *
 * Resolves rather than rejects for a non-zero exit, because a non-zero exit is a fact rather
 * than an error here: several callers run commands that are *expected* to fail (`git rev-parse
 * --verify -q` on a ref that does not exist, a grep that matches nothing). The caller decides
 * whether the code matters. `podExecStrict` is the form that decides it is fatal.
 */
export function podExecResult(pod: string, command: string[], timeoutMs = EXEC_TIMEOUT_MS): Promise<PodExecResult> {
  return new Promise((resolve) => {
    // Decoded incrementally, not per frame. `atob` gives a binary string - one character per
    // byte - so a UTF-8 character read out of a pod arrived as mojibake: claude's own
    // "Not logged in · Please run /login" came back as "Â· ". Every exec reader was affected, so
    // a source file or a diff containing an accented name or a dash rendered wrong on the Files
    // and Changes screens. Nothing had noticed because nothing had sent non-ASCII through it.
    //
    // `stream: true` matters as much as the decoder does: a multi-byte character can straddle two
    // frames, and decoding each frame on its own would corrupt exactly the characters this is
    // meant to fix. One decoder per channel, fed in order, flushed at the end.
    const outDecoder = new TextDecoder('utf-8');
    const errDecoder = new TextDecoder('utf-8');
    const bytes = (b64: string): Uint8Array => {
      const raw = atob(b64);
      const out = new Uint8Array(raw.length);

      for (let i = 0; i < raw.length; i++) {
        out[i] = raw.charCodeAt(i);
      }

      return out;
    };

    let stdout = '';
    let stderr = '';
    let status = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // The socket can report twice - an error is usually followed by a close - and the first
    // report is the one that knows what happened.
    const settle = (closeCode: number) => {
      if (settled) {
        return;
      }

      settled = true;

      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      // A clean 1000 with no status frame is the only shape that means success. Anything else
      // with nothing on channel 3 is the connection failing rather than the command, which is
      // a different sentence for a screen to say and must not be reported as exit 0.
      const broke = !status && closeCode !== 1000;

      resolve({
        // Flush: a decoder holding a partial sequence emits it (as U+FFFD) rather than losing it.
        stdout: stdout + outDecoder.decode(),
        stderr: stderr + errDecoder.decode(),
        status: status || (broke ? `the exec connection closed without running the command (${ closeCode })` : ''),
        code:   broke ? -1 : statusExitCode(status),
        transport: broke,
      });
    };

    try {
      const socket = new WebSocket(execUrl(pod, command, false), 'base64.channel.k8s.io');

      // Every frame is a channel digit then base64. 1 is stdout, 2 is stderr, 3 is the
      // apiserver's own status - which is where the exit code lives and is the whole reason
      // this function replaced the one that read only channel 1.
      socket.onmessage = (event) => {
        const frame = String(event.data || '');
        let raw: Uint8Array;

        try {
          raw = bytes(frame.slice(1));
        } catch {
          return; // a frame that is not base64 is not output
        }

        if (frame.startsWith('1')) {
          stdout += outDecoder.decode(raw, { stream: true });
        } else if (frame.startsWith('2')) {
          stderr += errDecoder.decode(raw, { stream: true });
        } else if (frame.startsWith('3')) {
          // The status frame is the apiserver's own prose or JSON, always ASCII, so it needs no
          // streaming decoder - but it does need decoding from the same bytes as the rest.
          status += new TextDecoder('utf-8').decode(raw);
        }
      };

      socket.onclose = (event) => settle(event.code);
      // No close event to read a code off: a pod or container that does not exist fails the
      // upgrade and only ever fires this.
      socket.onerror = () => settle(0);

      // And a socket that does neither.
      //
      // This promise used to have no way to end except a close or an error frame, so an exec
      // whose socket opened and then went quiet - the apiserver holding it, a proxy dropping
      // the upgrade halfway - never settled at all. Every caller awaiting it waited for the
      // rest of the session: the Changes tab sat on "Taking this change set's picture in the
      // pod" with no error anywhere, because from its point of view the request was still in
      // flight and always would be. A caller can decide something did not work; it cannot
      // decide anything about a promise that never resolves.
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          try {
            socket.close();
          } catch { /* already gone */ }

          if (!settled) {
            settled = true;
            resolve({
              stdout:    stdout + outDecoder.decode(),
              stderr:    stderr + errDecoder.decode(),
              status:    `the exec did not finish within ${ Math.round(timeoutMs / 1000) }s`,
              code:      -1,
              transport: true,
            });
          }
        }, timeoutMs);
      }
    } catch {
      settle(0);
    }
  });
}

/**
 * Run one command in an extension's pod and return what it wrote to stdout.
 *
 * UNCHANGED BEHAVIOUR, DELIBERATELY. Dozens of callers here read a file that may simply not
 * exist, or grep for something that may not be there, and for them an empty string is the
 * right answer and a throw would be a page that fails instead of a rail that is empty. This
 * still resolves with whatever stdout it managed to read, whatever happened.
 *
 * Anything that WRITES must not use this. Use `podExecStrict` / `inPackageStrict`, which turn
 * the exit code this now reads into a refusal, so a write that did not happen says so.
 */
export async function podExecOnce(pod: string, command: string[]): Promise<string> {
  return (await podExecResult(pod, command)).stdout;
}

/**
 * A command in a pod that did not do what it was asked.
 *
 * Carries the exit code and both streams, because the message a screen shows has to name what
 * git or the shell actually said - "could not write package.json" with nothing after it is the
 * silence this whole change is about, one level up.
 */
export class PodExecError extends Error {
  /** The exit status, or -1 when the command never ran. */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly status: string;

  constructor(what: string, result: PodExecResult) {
    // stderr first: it is where a shell and git say why. Then stdout, which is where a script
    // that redirected `2>&1` says it. Then the apiserver's line, which at least names the code.
    const said = result.stderr.trim() || result.stdout.trim().split('\n').slice(-3).join(' ').trim() || result.status.trim();
    const how = result.transport ? 'could not be run in the pod' : `failed in the pod (exit ${ result.code })`;

    super(`${ what } ${ how }: ${ said.slice(0, 400) || 'it said nothing at all' }`);

    this.name = 'PodExecError';
    this.code = result.code;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.status = result.status;
  }
}

/**
 * The same exec, for something that has to have happened.
 *
 * Resolves with stdout when the command exited 0 and throws a `PodExecError` otherwise. This
 * is the form every write uses.
 */
export async function podExecStrict(pod: string, command: string[], what = 'the command'): Promise<string> {
  const result = await podExecResult(pod, command);

  if (result.code !== 0) {
    throw new PodExecError(what, result);
  }

  return result.stdout;
}

/**
 * A command run in the pod as the user that owns the tree.
 *
 * The exec subresource runs as the container's user, which is root, and everything under /app
 * belongs to uid 1000 (boot.sh hands it over so that claude, which refuses to run as root, can
 * edit what the dev server is watching). Two things go wrong without this drop: git refuses a
 * tree it calls "dubious ownership", and a file written here comes out root-owned, which claude
 * then cannot edit - a failure that shows up minutes later in a pane nobody was watching.
 */
function asPodUser(script: string): string[] {
  // HOME with it. setpriv changes the uid and not the environment, so HOME stays /root, and
  // git then warns twice on every call that it cannot read /root/.config/git. Harmless - it is
  // on stderr and nothing here reads stderr - but it is the sort of noise that costs somebody
  // ten minutes the first time they run one of these by hand.
  const withHome = `export HOME=/app/.home; ${ script }`;

  return ['/bin/sh', '-c', `setpriv --reuid=1000 --regid=1000 --init-groups /bin/sh -c ${ shellQuote(withHome) }`];
}

/**
 * Where the extension's own source is inside the pod.
 *
 * Resolved by looking rather than by name. Every pod is seeded, cloned or imported from one
 * tree, so the package directory is called whatever that tree calls its package - `pkg/base`
 * for the stock one, whatever a repository's package.json says for an imported one - no matter
 * what the extension is named. There is exactly one directory under `/app/pkg`, which is what
 * makes this safe.
 */
/**
 * The package directory this extension owns, resolved by its own name first.
 *
 * This used to be `ls -d /app/pkg/*\/ | head -1`, on the reasoning that a pod holds exactly one
 * package. That is true of a pod created after extensions started being renamed off their seed,
 * and false of every pod created before it: `demo`'s pod holds both `/app/pkg/base` and
 * `/app/pkg/demo`, and `head -1` takes them alphabetically, so every read, write, commit, diff
 * and publish for `demo` was operating on `base`'s tree inside `demo`'s pod.
 *
 * Named lookup first, so an extension always gets its own directory. The glob stays as the
 * fallback for an imported repository, whose package keeps the name it had upstream and need not
 * match the extension's - but it now takes the single directory only when there is exactly one,
 * because picking alphabetically among several is the bug this replaces.
 */
const packageDir = (name: string) => `"$(d=/app/pkg/${ shellQuote(name).replace(/^'|'$/g, '') } ; ` +
  '[ -d "$d" ] && printf %s "$d" || ls -d /app/pkg/*/ | head -1)"';

/** Run something in the pod, in the extension's package directory, as the tree's owner. */
async function inPackage(name: string, script: string): Promise<string> {
  const pod = await extensionPod(name);

  if (!pod) {
    return '';
  }

  // Braces, not a bare `&&`. Several of these scripts are `;`-separated lists, and `cd X &&
  // a ; b` only guards `a`: a failed cd would run the rest of the list wherever the shell
  // happened to be, which for `git init` means initialising a repository in /.
  return podExecOnce(pod, asPodUser(`cd ${ packageDir(name) } && { ${ script } ; }`));
}

/**
 * The same, for something that has to have happened.
 *
 * `inPackage` resolves with whatever stdout it got, which is right for reading and wrong for
 * writing: a `git tag` refused by a root-owned `.git/refs`, or a `>` refused by a root-owned
 * file, comes back as the empty string and reads exactly like a command that succeeded and
 * printed nothing. Every write below goes through this instead, so the exit code and git's own
 * stderr reach the screen that asked.
 *
 * `what` is a phrase, not a sentence: it becomes "<what> failed in the pod (exit 1): ...".
 */
async function inPackageStrict(name: string, script: string, what: string): Promise<string> {
  const pod = await extensionPod(name);

  if (!pod) {
    throw new Error(`${ what } could not be done: ${ name } has no running pod`);
  }

  return podExecStrict(pod, asPodUser(`cd ${ packageDir(name) } && { ${ script } ; }`), what);
}

/**
 * Make the package a git repository if it is not one yet.
 *
 * The pod's tree is seeded from a ConfigMap rather than cloned, so it starts with no history at
 * all: nothing to diff an edit against, nothing to undo it with, and no answer to "what did
 * claude change in the last hour". One `git init` and one commit of the seeded state is the
 * whole fix, and it is cheap enough (42 files) to do the first time anybody looks.
 *
 * `main` explicitly, because git's default branch name depends on the version and on a config
 * nobody set in here, and a branch dropdown that says `master` on one pod and `main` on the next
 * is a needless surprise.
 */
/**
 * Memoised, because every screen that reads git wants this and none of them should pay for it
 * twice. The shell command is already idempotent; this saves the round trip.
 */
const repoEnsured = new Map<string, Promise<void>>();

export function ensureRepo(name: string): Promise<void> {
  if (!repoEnsured.has(name)) {
    // A failure is not cached: a pod that was still booting on the first try should get
    // another chance rather than being written off for the rest of the session.
    const started = ensureExtensionRepo(name).catch((e) => {
      repoEnsured.delete(name);
      throw e;
    });

    repoEnsured.set(name, started);
  }

  return repoEnsured.get(name) as Promise<void>;
}

export async function ensureExtensionRepo(name: string): Promise<void> {
  await inPackage(name, [
    'test -d .git && exit 0',
    'printf "node_modules/\\n" > .gitignore',
    'git init -q -b main',
    'git add -A',
    'git -c user.email=barn@rancher.local -c user.name=barn commit -q -m "The seeded extension"',
  ].join(' ; '));
}

/**
 * `inPackage` for the review system, which lives in its own file.
 *
 * review.ts owns the packet, the sign-offs and the gate, and all three are git work in the
 * pod. Exporting the runner rather than moving the git into this file keeps the dependency in
 * one direction - review.ts reads extensions.ts and never the other way - which is what stops
 * the two forming a cycle in the bundle.
 *
 * It is the same trust boundary everything else here already crosses: the page execs into the
 * pod with the user's own session. It is not a general escape hatch, and a screen that wants
 * to run something in the pod should get a named function for it instead.
 */
export function runInPackage(name: string, script: string): Promise<string> {
  return inPackage(name, script);
}

/**
 * The same, refusing rather than resolving when the script did not work.
 *
 * For a screen whose script writes something. `runInPackage` cannot tell "it printed nothing"
 * from "it never ran", and a screen that writes needs to know which.
 */
export function runInPackageStrict(name: string, script: string, what = 'the command'): Promise<string> {
  return inPackageStrict(name, script, what);
}

/** Every file in the package, as paths relative to it. Excludes node_modules by construction. */
export async function listExtensionFiles(name: string): Promise<string[]> {
  // `find` rather than `git ls-files`, so a file created a moment ago and not yet added is
  // listed. An untracked file is still a file somebody wants to open.
  const out = await inPackage(name, "find . -name node_modules -prune -o -name .git -prune -o -type f -print | sed 's|^\\./||'");

  return out.split('\n').map((line) => line.trim()).filter(Boolean).sort();
}

/**
 * Where else in the package a name appears.
 *
 * The Studio's file screen has a "where used" rail beside the file it is showing, and this is
 * the honest version of it: a fixed-string grep for the file's own basename across the package,
 * minus node_modules and .git. It is not a symbol index and does not pretend to be - it finds
 * the imports and the string references, which is most of what somebody looking at that rail
 * wants, and it finds them from the actual tree rather than from a model's recollection of it.
 */
export interface Usage {
  path: string;
  line: number;
  text: string;
}

export async function findUsages(name: string, term: string, limit = 40): Promise<Usage[]> {
  if (!term.trim()) {
    return [];
  }

  const out = await inPackage(
    name,
    `grep -rnF --exclude-dir=node_modules --exclude-dir=.git -- ${ shellQuote(term) } . 2>/dev/null | head -n ${ limit }`
  ).catch(() => '');

  return out.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      // ./path/to/file.ts:12:the matching text
      const m = /^\.?\/?(.+?):(\d+):(.*)$/.exec(line);

      return m ? { path: m[1], line: parseInt(m[2], 10), text: m[3].trim() } : null;
    })
    .filter(Boolean) as Usage[];
}

export async function readExtensionFile(name: string, path: string): Promise<string> {
  return inPackage(name, `cat ${ shellQuote(path) } 2>/dev/null`);
}

/**
 * One image out of the pod, as a data: URL.
 *
 * `readExtensionFile` cannot do this: it `cat`s, and the exec channel carries text, so a png
 * comes back through it with every byte that is not valid UTF-8 replaced. base64 on the pod
 * side is what makes the bytes survive the trip, which is the same thing `changeSetShot` does
 * for the before and after pictures.
 *
 * The marker is there for the same reason it is there: the exec's stdout also carries whatever
 * the shell wrote on the way past, so the reader looks for its own line rather than trusting
 * that the stream holds nothing else.
 */
/**
 * A picture of one page with one element outlined on it.
 *
 * The element picker's other half. What it is for is the case the picker cannot name: an
 * element the framed page draws from no component of this extension's, where a file path would
 * be a lie and the only honest thing to put in the conversation is what it looks like.
 *
 * The same skill and the same session token the change-set pictures use. Not cached on a
 * commit, because this is a picture of the page as it is now rather than of a change: the
 * caller picked an element a second ago and the answer has to be about that.
 */
export interface PickedShot {
  /** The picture, for cropping and for showing here. Empty when the capture did not come back. */
  src:    string;
  /** Where it is in the pod. */
  path:   string;
  /**
   * Where the picked element landed in that picture, in its own pixels.
   *
   * This is what makes the picker's attachment the same kind of thing the Changes tab's is: a
   * crop of the element rather than a whole page with a ring on it. It comes from the capture's
   * own sidecar - the skill records where it drew each outline - so the rectangle and the
   * picture are measured by the same pass and cannot disagree.
   */
  region: { x: number; y: number; width: number; height: number } | null;
}

export async function elementShot(name: string, route: string, selector: string): Promise<PickedShot> {
  const session = await captureToken().catch(() => '');
  // Into .attachments rather than .shots, and kept. A picture the assistant is told about has
  // to still be there when it goes looking: .shots is the change sets' own store, and a
  // temporary file deleted at the end of this command would leave the message naming nothing.
  const out = `/app/.attachments/pick-${ Date.now().toString(36) }.png`;

  const answer = await inPackage(name, [
    'mkdir -p /app/.attachments ;',
    `node "$HOME/.claude/skills/barn-screenshot/screenshot.mjs"`,
    `--path ${ shellQuote(route || '/') }`,
    `--note ${ shellQuote(`${ selector }=picked`) }`,
    session ? `--token ${ shellQuote(session) }` : '',
    `--output ${ out } >/dev/null 2>&1 || true ;`,
    `[ -f ${ out } ] && printf %s BARN-PICK: && base64 -w0 ${ out } && echo ;`,
    `[ -f ${ out }.json ] && printf %s BARN-PICK-REGIONS: && base64 -w0 ${ out }.json && echo ;`,
    `rm -f ${ out }.json ;`,
    'true',
  ].filter(Boolean).join(' ')).catch(() => '');

  const read = (marker: string): string => {
    const at = answer.indexOf(marker);

    return at === -1 ? '' : answer.slice(at + marker.length).split('\n')[0].trim();
  };

  const data = read('BARN-PICK:');

  if (!data) {
    return { src: '', path: '', region: null };
  }

  let region: PickedShot['region'] = null;

  try {
    const raw = read('BARN-PICK-REGIONS:');
    const parsed = raw ? JSON.parse(atob(raw)) : null;
    const first = Array.isArray(parsed?.regions) ? parsed.regions[0] : null;

    if (first && Number(first.width) > 0 && Number(first.height) > 0) {
      region = {
        x: Number(first.x) || 0, y: Number(first.y) || 0, width: Number(first.width), height: Number(first.height),
      };
    }
  } catch {
    // No region is a whole-page attachment rather than a failed one.
    region = null;
  }

  return { src: `data:image/png;base64,${ data }`, path: out, region };
}

export async function readPodImage(name: string, path: string): Promise<string> {
  const quoted = shellQuote(path);
  const out = await inPackage(
    name,
    `[ -f ${ quoted } ] && printf %s BARN-IMAGE: && base64 -w0 ${ quoted } && echo ; true`,
  ).catch(() => '');

  const at = out.indexOf('BARN-IMAGE:');

  if (at === -1) {
    return '';
  }

  const data = out.slice(at + 'BARN-IMAGE:'.length).split('\n')[0].trim();

  if (!data) {
    return '';
  }

  // The extension is what names the type. Everything the composer writes into .attachments is
  // one of these, and a wrong type here renders as a broken image rather than as nothing.
  const ext = (path.split('.').pop() || '').toLowerCase();
  const type = ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext === 'gif' ? 'gif' : ext === 'webp' ? 'webp' : 'png';

  return `data:image/${ type };base64,${ data }`;
}

/**
 * What git knows about one path: who last committed it, when, and whether it is committed now.
 *
 * The Files screen's editor header states the open file's provenance, and until this existed
 * the only true thing on that line was the line count. Everything here is read rather than
 * guessed: `git log -1` for the last author and age, `git status` for whether the copy on disk
 * differs from that commit. A file git has never seen comes back with no author and no age,
 * which is the honest answer for something created a minute ago and not committed.
 */
export interface FileProvenance {
  /** The author of the commit that last touched this path. '' when there is no such commit. */
  who:   string;
  /** How long ago that commit was, in git's own relative wording. '' with no commit. */
  when:  string;
  /** 'committed' | 'modified' | 'new' | 'deleted' | 'unknown' */
  state: string;
}

export async function fileProvenance(name: string, path: string): Promise<FileProvenance> {
  if (!path) {
    return { who: '', when: '', state: 'unknown' };
  }

  const quoted = shellQuote(path);
  // One exec for both halves, for the reason changedFiles gives: a second shell into the pod
  // per opened file is a second the reader waits, every time they click a row in the tree.
  const out = await inPackage(name, [
    `git log -1 --format='%an%x1f%cr' -- ${ quoted } 2>/dev/null`,
    'echo "--status--"',
    `git status --porcelain --no-renames -- ${ quoted } 2>/dev/null`,
  ].join(' ; ')).catch(() => '');

  const [logOut = '', statusOut = ''] = out.split('--status--');
  const [who = '', when = ''] = logOut.trim().split('\x1f');
  const code = statusOut.split('\n').map((l) => l.trimEnd()).filter(Boolean)[0]?.slice(0, 2) || '';

  let state = 'committed';

  if (code.includes('?') || (code.includes('A') && !who)) {
    state = 'new';
  } else if (code.includes('D')) {
    state = 'deleted';
  } else if (code.trim()) {
    state = 'modified';
  } else if (!who) {
    // No commit and no status either: git is not answering, so say nothing rather than
    // reporting the file as committed on the strength of an empty string.
    state = 'unknown';
  }

  return { who: who.trim(), when: when.trim(), state };
}

export interface ExtensionBranches {
  current: string;
  branches: string[];
}

export async function listBranches(name: string): Promise<ExtensionBranches> {
  const out = await inPackage(name, 'git branch --format="%(refname:short)" 2>/dev/null; echo ---; git rev-parse --abbrev-ref HEAD 2>/dev/null');
  const [listed = '', current = ''] = out.split('---');

  return {
    current:  current.trim(),
    branches: listed.split('\n').map((line) => line.trim()).filter(Boolean),
  };
}

/** Switch to a branch, creating it from where HEAD is if it does not exist. */
export async function checkoutBranch(name: string, branch: string): Promise<string> {
  // `git checkout -B` would reset an existing branch to HEAD, which is a data-losing way to
  // spell "switch to". So: try to switch, and only create when there is nothing to switch to.
  return inPackage(name, `git checkout ${ shellQuote(branch) } 2>&1 || git checkout -b ${ shellQuote(branch) } 2>&1`);
}

export interface ExtensionCommit {
  sha: string;
  subject: string;
  when: string;
  who: string;
}

/**
 * The branch's commits, newest first.
 *
 * A unit separator between the fields rather than a comma or a tab, because a commit subject can
 * contain either and this is parsed by splitting.
 */
export async function listCommits(name: string, limit = 50): Promise<ExtensionCommit[]> {
  const out = await inPackage(name, `git log -n ${ limit } --format='%h%x1f%s%x1f%cr%x1f%an' 2>/dev/null`);

  return out.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [sha, subject, when, who] = line.split('\x1f');

    return {
      sha, subject, when, who
    };
  });
}

/**
 * One commit's diff, as the text `git show` produces.
 *
 * Parsed by DiffView into files, hunks and numbered lines, which is what makes it look like the
 * diff on a pull request rather than like terminal output pasted into a dialog.
 *
 * No `--stat`, because DiffView counts its own totals from the patch, and no colour, because
 * this goes into HTML rather than a terminal.
 */
export async function showCommit(name: string, sha: string): Promise<string> {
  return inPackage(name, `git show --patch --no-color ${ shellQuote(sha) } 2>&1`);
}

/**
 * Write a text file into an extension's package directory.
 *
 * Base64 through the exec, for the same reason writePodImage is: what is between here and the
 * file is a shell, and a brief full of quotes and newlines put through it directly would come
 * out mangled. `base64 -d` is in the image; `printf` of an escaped string is not worth the
 * escaping rules.
 */
export async function writeExtensionFile(name: string, path: string, contents: string): Promise<void> {
  // btoa cannot take anything above U+00FF, and a brief can easily contain an em dash or a
  // quotation mark. Encode to UTF-8 bytes first, then base64 those.
  const bytes = new TextEncoder().encode(contents);
  let binary = '';

  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });

  const encoded = btoa(binary);
  const quoted = shellQuote(path);

  // Strict, and then the size is read back, because this is where the silence cost the most.
  // The publish dialog's version bump writes package.json through here, the file was owned by
  // root in a pod whose execs run as uid 1000, the redirection was refused, and the publish
  // shipped the old version having said nothing. Two independent checks now: the shell's exit
  // code, which catches the refusal, and the byte count, which catches a write that was
  // truncated after it started.
  const out = await inPackageStrict(
    name,
    [
      `mkdir -p "$(dirname ${ quoted })"`,
      `printf %s ${ shellQuote(encoded) } | base64 -d > ${ quoted }`,
      `echo "BARN-WROTE:$(wc -c < ${ quoted })"`,
    ].join(' && '),
    `writing ${ path }`
  );
  const wrote = parseInt(/BARN-WROTE:\s*(\d+)/.exec(out)?.[1] || '', 10);

  if (!Number.isFinite(wrote)) {
    throw new Error(`${ path } was written but the pod would not say how much of it landed: ${ out.trim().slice(0, 200) || 'no output' }`);
  }

  if (wrote !== bytes.length) {
    throw new Error(`${ path } came out ${ wrote } bytes instead of ${ bytes.length }, so only part of it was written`);
  }
}

/**
 * Commit whatever is currently different.
 *
 * Returns the new commit's short sha and nothing else. It used to return the whole of git's
 * output and the empty string on every kind of failure, which put both callers in the business
 * of guessing from prose whether a commit had happened - screen 12's approve() reads the sha
 * off the last line and refuses to sign without one, precisely because it was once handed ''
 * and signed against it. There is nothing left to guess: this throws when no commit was made,
 * and the two ways that can happen say which one it was.
 */
export async function commitExtension(name: string, message: string): Promise<string> {
  const out = await inPackageStrict(name, [
    'git add -A || exit 1',
    'if git diff --cached --quiet ; then echo BARN-COMMIT-NOTHING ; exit 0 ; fi',
    `git -c user.email=barn@rancher.local -c user.name=barn commit -q -m ${ shellQuote(message) } || exit 1`,
    'echo "BARN-COMMIT:$(git log -1 --format=%h)"',
  ].join(' ; '), 'the commit');

  // No `2>&1` anywhere above, on purpose: now that channel 2 is read, git's own reason for
  // refusing arrives in the error rather than being folded into the output somebody parses.
  if (out.includes('BARN-COMMIT-NOTHING')) {
    throw new Error(`nothing in ${ name } is uncommitted, so there was nothing to commit`);
  }

  const sha = /BARN-COMMIT:([0-9a-f]{7,40})/.exec(out)?.[1] || '';

  if (!sha) {
    throw new Error(`the commit did not happen in ${ name }: ${ out.trim().slice(0, 200) || 'git said nothing at all' }`);
  }

  return sha;
}

// ---------------------------------------------------------------------------
// The baseline: the point a change is measured from.
//
// Step 2 of scripts/feature-audit/REVIEW-SYSTEM.md. Every diff in this product used to be
// against HEAD, and HEAD is the wrong point twice over:
//
//   - A local publish never commits, so HEAD does not move when something is published and a
//     reviewer of a published extension is shown changes measured from a commit that has
//     nothing to do with what was published (cross-screen rule 7).
//   - With the provenance hooks committing once per assistant turn, HEAD moves constantly, so
//     "changed since HEAD" is "changed since the assistant last stopped typing", which is
//     nothing at all.
//
// So the diff screens measure from the last version other people could get, in the order of
// how far the extension travelled: the last distribution, then the last local publish, then
// HEAD when neither has happened. HEAD is the honest fallback rather than a guess, and the
// screens are told which one it was so they can say so instead of implying the last publish.
// ---------------------------------------------------------------------------

/** The last version other people could install. Written by `distributeExtension`. */
export const BASELINE_OCI_REF = 'refs/barn/published/oci';

/** The last version this Rancher loads. Written by `publishExtension`. */
export const BASELINE_LOCAL_REF = 'refs/barn/published/local';

/**
 * The last tree that built and installed without failing. Written by `publishExtension`.
 *
 * Cross-screen rule 4, "a guaranteed way back from any build failure". The guarantee needs a
 * point that is a *working* build, and the product had one only in `sessionStorage`
 * (`recordWorkingBuild` in publish-failure.ts), so a fresh browser, a second person, or a
 * different tab had no way back at all and the failure screen fell through to whichever
 * hand-made snapshot happened to be nearest. A ref in the pod is the same fact where the tree
 * it describes lives: it survives the tab, the browser and the person.
 *
 * Separate from `BASELINE_LOCAL_REF` even though the two move together today, because they
 * answer different questions and will not always agree. The baseline is "the last version other
 * people could get", which a distribution moves without anything having been built here; this
 * is "the last state of this tree that compiled", which is what a rollback wants.
 *
 * A build does not change the source, so the point worth going back to is never the tree that
 * failed - it is the last one that did not. That is why this is written after a success rather
 * than before an attempt.
 */
export const WORKING_BUILD_REF = 'refs/barn/working-build';

/**
 * How far a person has reviewed.
 *
 * A pointer rather than a flag per change set, because the history is linear: approving the
 * third turn but not the second would mean cherry-picking, and cherry-picking a range that
 * touched the same file twice conflicts. "Reviewed up to here" is the shape git can honour
 * cheaply, and it is honest about the fact that a change set is only meaningful on top of the
 * ones before it.
 *
 * Unset on an extension nobody has reviewed yet, which reads as "everything is pending" rather
 * than as "everything is approved" - the safe direction for a ref that gates publishing.
 */
export const APPROVED_REF = 'refs/barn/approved';

export interface ApprovalState {
  /** The commit review has reached. '' when nothing has been approved yet. */
  sha:     string;
  /** Commits newer than that, newest first. Empty when there is nothing to review. */
  pending: string[];
  /** True when there is nothing waiting, which is the only state publishing is allowed in. */
  clear:   boolean;
  /**
   * Whether this is a reading at all.
   *
   * False when the pod could not be asked. "Nothing is waiting" and "this could not find out"
   * are different answers and only one of them may open the gate, so they are different fields
   * rather than one optimistic boolean.
   */
  read:    boolean;
}

/**
 * What has been reviewed and what has not.
 *
 * `rev-list APPROVED..HEAD` is the whole question: the commits on the branch that the approval
 * pointer has not reached. With no pointer it is every commit, which is why a fresh extension
 * reports all of its turns as pending.
 */
export async function approvalState(name: string): Promise<ApprovalState> {
  const out = await inPackage(name, [
    'test -d .git || { echo BARN-NOGIT ; exit 0 ; }',
    `approved=$(git rev-parse --verify -q ${ APPROVED_REF } 2>/dev/null || true)`,
    'echo "APPROVED=$approved"',
    // The floor when nothing has been approved yet.
    //
    // It was `git rev-list HEAD` - every commit in the repository, the seed included. A brand
    // new extension has exactly one commit, "The seeded extension", so the Changes tab's badge
    // read 1 while the tab underneath it said nothing had been asked for yet. It was counting
    // the tree the extension started as as though somebody had to review it.
    //
    // The same chain every other screen measures from: what has been published, and failing
    // that the root commit, which is the tree this extension started as and is therefore never
    // itself something to approve.
    'base="$approved"',
    // One line, and each fallback on its own statement.
    //
    // This was a single `base=$(a || b || c)` split across three array entries, which joins to
    // a command substitution broken over three lines - and the pod's shell is dash, which reads
    // a line starting with `||` inside `$( )` as a syntax error rather than a continuation.
    // Every read therefore died with `Syntax error: "||" unexpected`, and because the failure
    // was in the script rather than in the exec, it came back as output with no PENDING marker:
    // the review state was unreadable for every change set, which the rail then drew as
    // "reviewed".
    `[ -n "$base" ] || base=$(git rev-parse --verify -q ${ BASELINE_OCI_REF } 2>/dev/null || true)`,
    `[ -n "$base" ] || base=$(git rev-parse --verify -q ${ BASELINE_LOCAL_REF } 2>/dev/null || true)`,
    '[ -n "$base" ] || base=$(git rev-list --max-parents=0 HEAD 2>/dev/null | tail -1)',
    'echo PENDING',
    'if [ -n "$base" ] ; then git rev-list "$base"..HEAD 2>/dev/null ; else git rev-list HEAD 2>/dev/null ; fi',
  ].join('\n')).catch(() => 'BARN-APPROVAL-FAILED');

  // A tree with no history has nothing to review, which is the one honest `clear: true`.
  if (out.includes('BARN-NOGIT')) {
    return {
      sha: '', pending: [], clear: true, read: true,
    };
  }

  // Anything else that did not answer is unknown, and unknown is not clear.
  //
  // This used to fall back to `{ pending: [], clear: true }`, which reads everywhere as "all
  // reviewed, ready to publish" - so an exec that failed for any reason turned the review gate
  // off and marked every change set as looked at. The gate exists to stop exactly that, and a
  // fallback that opens it is worse than no gate at all.
  if (out.includes('BARN-APPROVAL-FAILED') || !out.includes('PENDING')) {
    return {
      sha: '', pending: [], clear: false, read: false,
    };
  }

  const sha = (/APPROVED=(\S*)/.exec(out)?.[1] || '').trim();
  const at = out.indexOf('PENDING');
  const pending = at === -1
    ? []
    : out.slice(at + 'PENDING'.length).split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f]{7,40}$/i.test(l));

  return {
    sha, pending, clear: !pending.length, read: true,
  };
}

/**
 * Accept every change set up to and including this one.
 *
 * A ref move and nothing else: no rebase, no rewriting, no touching the working tree. The
 * commits were already made and already photographed; approving them says a person has looked,
 * which is a fact about the reviewer rather than about the code.
 */
export async function approveUpTo(name: string, commit: string): Promise<void> {
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
    throw new Error(`${ commit || 'that change set' } is not a commit that can be approved`);
  }

  await inPackageStrict(
    name,
    `git update-ref ${ APPROVED_REF } ${ shellQuote(commit) }`,
    `approving ${ commit.slice(0, 7) }`,
  );
}

/**
 * Undo every change set newer than this one.
 *
 * `revert --no-commit` over the range and one commit at the end, so rejecting three turns is
 * one entry in the history rather than three. Reverted rather than rewritten on purpose: the
 * turns that made these changes are still in the log with their prompts and their pictures,
 * and a review that erased them would erase the record of what was reviewed.
 *
 * The approval pointer moves to the revert, because a person who rejected has, by rejecting,
 * reviewed everything up to it.
 */
export async function rejectAfter(name: string, commit: string): Promise<void> {
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
    throw new Error(`${ commit || 'that change set' } is not a commit that can be rejected from`);
  }

  await inPackageStrict(name, [
    `git revert --no-commit ${ shellQuote(commit) }..HEAD || { git revert --abort 2>/dev/null ; exit 1 ; }`,
    `git -c user.email=barn@rancher.local -c user.name=barn commit -q -m ${ shellQuote(`Reject the change sets after ${ commit.slice(0, 7) }`) } || exit 1`,
    `git update-ref ${ APPROVED_REF } HEAD`,
  ].join('\n'), 'rejecting the change sets after this one');
}

/**
 * Shell that leaves the baseline revision in `$BARN_BASE`.
 *
 * Inline rather than a round trip of its own: every caller below is already one exec into the
 * pod, and resolving the baseline separately would double that for every diff on every screen.
 */
const BASELINE_SH = [
  `BARN_BASE=$(git rev-parse --verify -q ${ BASELINE_OCI_REF }`,
  `|| git rev-parse --verify -q ${ BASELINE_LOCAL_REF }`,
  // Before HEAD, and this is the line that makes the "what has changed" screens say anything
  // at all on an unpublished extension.
  //
  // Falling straight to HEAD meant measuring the working tree against the last commit - and
  // every turn ends in a commit, so HEAD *is* the working tree the moment the assistant stops.
  // The diff was empty by construction: the masthead said "No changes" seconds after a change,
  // and the preview's banner had nothing to outline. Now that review is a thing a person does,
  // the honest baseline for an unpublished extension is the last change set they accepted.
  `|| git rev-parse --verify -q ${ APPROVED_REF }`,
  // Nothing published and nothing approved yet: measure from the seed.
  //
  // HEAD is the wrong last resort for the same reason it was the wrong one above - it is the
  // commit the last turn just made, so the diff against it is empty whenever anything has
  // happened. The root commit is the tree this extension started as, so on a pod where the
  // assistant has done nothing it is HEAD (an empty diff, correctly) and on one where it has
  // worked it is everything that work produced, which is exactly what has not been approved.
  '|| git rev-list --max-parents=0 HEAD 2>/dev/null | tail -1',
  '|| git rev-parse --verify -q HEAD)',
].join(' ');

/**
 * `git add -A -N`, which every baseline diff needs and not only for new files.
 *
 * A file that is untracked is absent from the index, so `git diff <a commit that has it>`
 * reports it as *deleted*. Once a baseline exists that is every untracked file in the tree, so
 * without this the review screens would show the assistant's new files as deletions. Intent-to-add
 * records the path without staging the content, which puts the file in the diff as what it is.
 */
const INTENT_SH = 'git add -A -N >/dev/null 2>&1';

/**
 * The same question as a count, without writing the index.
 *
 * Counting is on the hottest path in the product - one call per row on the extensions list and
 * one per row on the review queue, several of them in flight at once - and `git add -A -N` takes
 * `index.lock`, so two of those racing on one pod leaves one of them silently doing nothing.
 * The union of "tracked paths that differ from the baseline" and "files git has never seen" is
 * the same answer and touches nothing.
 */
const COUNT_SH = [
  '{ git diff --name-only --no-renames "$BARN_BASE" 2>/dev/null',
  '; git ls-files -o --exclude-standard 2>/dev/null ; } | sort -u | grep -c .',
].join(' ');

export interface Baseline {
  /** oci | local | head | none */
  kind:  string;
  ref:   string;
  sha:   string;
  /** A sentence a screen can render: which point the diff beside it was measured from. */
  label: string;
}

/**
 * Which point this extension's changes are being measured from, for a screen to say out loud.
 *
 * A separate call from the diffs themselves, because the diffs resolve it inline and a screen
 * only needs the sentence once. `none` is a pod with no repository yet, not an error.
 */
export async function baselineRef(name: string): Promise<Baseline> {
  // Joined with a newline, not with ' ; '. The loop spans two array elements, so a semicolon join
  // put one straight after `do`, and the pod's dash answered `Syntax error: ";" unexpected` and
  // exited 2. The `.catch` below then turned that into an empty string, so the function reported
  // "this extension has no history yet" for every extension, always. Every screen measuring from
  // a baseline quietly fell back to HEAD, and screen 04 went on offering to discard commits it
  // could not reach. A newline is a statement separator that `do` accepts.
  //
  // The catch stays, because a pod with no repository yet is a real answer and not an error, but
  // it is the reason this hid for as long as it did.
  const out = await inPackage(name, [
    BASELINE_SH,
    `for r in ${ BASELINE_OCI_REF } ${ BASELINE_LOCAL_REF } ; do`,
    'git rev-parse --verify -q "$r" >/dev/null && { echo "KIND=$r"; break; } ; done',
    'echo "SHA=$BARN_BASE"',
  ].join('\n')).catch(() => '');

  const sha = (/SHA=(\S+)/.exec(out)?.[1] || '').trim();
  const ref = (/KIND=(\S+)/.exec(out)?.[1] || '').trim();

  if (!sha) {
    return {
      kind: 'none', ref: '', sha: '', label: 'this extension has no history yet, so there is nothing to measure from',
    };
  }

  if (ref === BASELINE_OCI_REF) {
    return {
      kind: 'oci', ref, sha, label: 'measured against the last version that was handed over',
    };
  }

  if (ref === BASELINE_LOCAL_REF) {
    return {
      kind: 'local', ref, sha, label: 'measured against the last version published into this Rancher',
    };
  }

  return {
    kind:  'head',
    ref:   'HEAD',
    sha,
    label: 'nothing has been published yet, so this is measured against the last commit',
  };
}

/**
 * Record the tree that was just published, so later diffs have a point to measure from.
 *
 * A commit object built from the working tree, through a scratch index, so that neither the
 * real index nor HEAD moves: publishing is not committing, and a publish that quietly staged
 * the whole tree would change what every other screen reads. `commit-tree` with HEAD as the
 * parent makes it a real commit in the history's shape without being on any branch, which is
 * what makes `git diff <ref>` and `git blame` work against it.
 *
 * Best effort on purpose. A publish that worked is not undone by a ref that could not be
 * written; the cost is one screen saying it measured from the last commit instead.
 *
 * Best effort is not the same as silent, and it used to be both. `.catch(() => '')` around an
 * `inPackage` that read only stdout meant a `git update-ref` refused by a root-owned `.git` was
 * indistinguishable from one that worked, and the only symptom was every diff screen quietly
 * measuring from the wrong point for the rest of the extension's life. So the reason comes back
 * with the answer, and `publishExtension` puts it in the log the publish dialog shows.
 */
interface BaselineWrite {
  /** The commit the ref was moved to. '' when it was not written. */
  sha:   string;
  /** Why not, as a sentence. '' when it was written. */
  error: string;
}

async function recordBaseline(name: string, ref: string, subject: string): Promise<BaselineWrite> {
  try {
    const out = await inPackageStrict(name, [
      'test -d .git || { echo BARN-BASELINE-NOGIT ; exit 0 ; }',
      'export GIT_INDEX_FILE=/tmp/barn-baseline-index.$$',
      'rm -f "$GIT_INDEX_FILE"',
      'git read-tree HEAD 2>/dev/null',
      'git add -A || exit 1',
      'tree=$(git write-tree)',
      'unset GIT_INDEX_FILE',
      '[ -n "$tree" ] || exit 1',
      `commit=$(git -c user.email=barn@rancher.local -c user.name=barn commit-tree "$tree" -p HEAD -m ${ shellQuote(subject) })`,
      '[ -n "$commit" ] || exit 1',
      `git update-ref ${ ref } "$commit" || exit 1`,
      'echo "BARN-BASELINE:$commit"',
    ].join(' ; '), `recording the baseline ${ ref }`);

    if (out.includes('BARN-BASELINE-NOGIT')) {
      return { sha: '', error: `${ name } has no git repository in its pod, so there is no baseline to record` };
    }

    const sha = (/BARN-BASELINE:(\S+)/.exec(out)?.[1] || '').trim();

    return sha ? { sha, error: '' } : { sha: '', error: `git wrote no commit for ${ ref }` };
  } catch (e: any) {
    return { sha: '', error: e?.message || String(e) };
  }
}

/** How many files differ from the baseline, so the UI can offer to hand them over. */
export async function countChanges(name: string): Promise<number> {
  const out = await inPackage(name, [BASELINE_SH, COUNT_SH].join(' ; '));

  return parseInt(out.trim(), 10) || 0;
}

/**
 * The change, file by file, measured from the baseline.
 *
 * Rename detection off, because the Studio's review screen lists paths and a rename shown as
 * `old -> new` is a path that matches nothing. Untracked files are included and reported as
 * additions, which is what they are to somebody reading the screen - the distinction between
 * "untracked" and "added" is git's, not theirs.
 */
export interface ChangedFile {
  path:   string;
  /** added | modified | deleted */
  status: string;
  /** Lines added and removed. Counted for untracked files too - see below. */
  added:   number;
  removed: number;
}

export async function changedFiles(name: string): Promise<ChangedFile[]> {
  // Two readings in one exec, because a name-status alone cannot say how big a change is and
  // a second shell into the pod per screen is a second the reviewer waits.
  //
  // Against the baseline rather than against `git status`, which is the whole of step 2 for
  // this function: status answers "what is uncommitted", and once the assistant commits a
  // turn at a time that is nothing, while the change the reviewer is here for is every commit
  // since the last published version. `git diff --name-status <baseline>` answers the
  // question the screen is actually asking, and it covers untracked files too once INTENT_SH
  // has told git they are coming.
  const out = await inPackage(
    name,
    [
      BASELINE_SH,
      INTENT_SH,
      'git diff --name-status --no-renames "$BARN_BASE" 2>/dev/null',
      'echo "--numstat--"',
      'git diff --numstat --no-renames "$BARN_BASE" 2>/dev/null',
    ].join(' ; ')
  ).catch(() => '');

  return parseChangedFiles(out);
}

/**
 * The two halves of the reading above, turned into rows.
 *
 * Split out so `changedFilesSince` parses the same output the same way rather than growing a
 * second copy that drifts. Nothing about it is specific to which commit the diff was against.
 */
function parseChangedFiles(out: string): ChangedFile[] {
  const [statusOut, numstatOut = ''] = out.split('--numstat--');
  const stats: Record<string, { added: number; removed: number }> = {};
  // Quotes come off the same way on both readings: git quotes a path with anything awkward in
  // it, and every caller keys on the plain one.
  const unquote = (path: string) => path.trim().replace(/^"|"$/g, '');

  numstatOut.split('\n').forEach((line) => {
    const [added, removed, ...rest] = line.trimEnd().split(/\t/);

    if (rest.length) {
      // A binary file is reported as `-\t-\t<path>`, which parses to zero on both counts -
      // which is true: it has no lines.
      stats[unquote(rest.join('\t'))] = { added: parseInt(added, 10) || 0, removed: parseInt(removed, 10) || 0 };
    }
  });

  return statusOut.split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [code, ...rest] = line.split(/\t/);
      const path = unquote(rest.join('\t'));

      let status = 'modified';

      if (code.startsWith('A')) {
        status = 'added';
      } else if (code.startsWith('D')) {
        status = 'deleted';
      }

      const { added = 0, removed = 0 } = stats[path] || {};

      return {
        path, status, added, removed
      };
    })
    .filter((f) => !!f.path);
}

/**
 * One file's diff, collapsed against the baseline.
 *
 * The same point `changedFiles` measures from, so a row's counts and the patch under it are
 * two readings of one change rather than two answers to different questions.
 */
export async function fileDiff(name: string, path: string): Promise<string> {
  const quoted = `'${ path.replace(/'/g, `'\\''`) }'`;

  return inPackage(name, [
    BASELINE_SH,
    INTENT_SH,
    `git diff --no-renames "$BARN_BASE" -- ${ quoted } 2>/dev/null`,
  ].join(' ; '));
}

// ---------------------------------------------------------------------------
// The same two readings, against an arbitrary commit.
//
// Cross-screen rule 9, "re-review is incremental across visits". The per-reviewer half of it
// already works - `markLook` in review.ts records the packet and the commit a reviewer last
// read, and `sinceLastLook` says how many landed since - but the diff half could not, because
// every diff in this file was pinned to `$BARN_BASE`. Screen 12's banner said so in as many
// words: "narrowing it needs a diff taken against the commit you last read, and nothing in the
// Studio takes one against an arbitrary commit yet". These are that.
//
// Separate functions rather than an optional argument on `changedFiles` and `fileDiff`. Those
// two are called from six screens and their whole contract is "measured from the baseline, and
// the screen says which baseline"; a second meaning smuggled in behind a default parameter is
// the kind of change that makes one caller's diff quietly mean something else.
//
// Both REFUSE rather than fall back when the commit is not in the pod. A reviewer's last look
// can name a commit that a `git reset` has since taken out of the branch, and answering that
// with the whole change - or with nothing - is answering a different question from the one the
// filter asked. The screen has to be able to say "the commit you last read is no longer in
// this branch", which it can only do if this says so.
// ---------------------------------------------------------------------------

/** A sha this product will put into a shell. Nothing else is allowed near one. */
function requireCommitish(sha: string): string {
  const trimmed = (sha || '').trim();

  if (!/^[0-9a-f]{4,40}$/.test(trimmed)) {
    throw new Error(`"${ trimmed }" is not a commit`);
  }

  return trimmed;
}

/**
 * Shell that resolves `$BARN_SINCE` or prints `BARN-NO-COMMIT` and stops.
 *
 * `^{commit}` so a tag or a ref that happens to share the prefix cannot resolve to something
 * that is not a commit, which `git diff` would then report on as a tree.
 */
function sinceSh(sha: string): string {
  return [
    `BARN_SINCE=$(git rev-parse --verify -q ${ requireCommitish(sha) }^{commit})`,
    '|| { echo BARN-NO-COMMIT ; exit 0 ; }',
  ].join(' ');
}

/**
 * The files that changed since one particular commit, in the same shape `changedFiles` returns.
 *
 * What screen 12's "since your last look" filter lists. The commit is the one the reviewer's
 * own record says they last read, so this is "what has landed while I was away" and not "what
 * this change is", which is the question `changedFiles` already answers beside it.
 */
export async function changedFilesSince(name: string, sha: string): Promise<ChangedFile[]> {
  const out = await inPackage(name, [
    sinceSh(sha),
    INTENT_SH,
    'git diff --name-status --no-renames "$BARN_SINCE" 2>/dev/null',
    'echo "--numstat--"',
    'git diff --numstat --no-renames "$BARN_SINCE" 2>/dev/null',
  ].join(' ; '));

  if (out.includes('BARN-NO-COMMIT')) {
    throw new Error(`${ sha } is not a commit in ${ name } any more, so there is nothing to measure from`);
  }

  return parseChangedFiles(out);
}

/**
 * One file's diff since one particular commit.
 *
 * The pair of `fileDiff`, measured from the same point `changedFilesSince` measured from, so a
 * row's counts and the patch under it are two readings of one thing.
 */
export async function fileDiffSince(name: string, sha: string, path: string): Promise<string> {
  const quoted = `'${ path.replace(/'/g, `'\\''`) }'`;
  const out = await inPackage(name, [
    sinceSh(sha),
    INTENT_SH,
    `git diff --no-renames "$BARN_SINCE" -- ${ quoted } 2>/dev/null`,
  ].join(' ; '));

  if (out.includes('BARN-NO-COMMIT')) {
    throw new Error(`${ sha } is not a commit in ${ name } any more, so there is nothing to measure from`);
  }

  return out;
}

/**
 * Throw the working tree away.
 *
 * Both halves are needed and neither is enough: `checkout` restores tracked files to HEAD and
 * says nothing about files git has never seen, and `clean` removes those but will not touch a
 * tracked file that has been edited. `-d` for directories the assistant created, and `-e
 * node_modules` because that is a hundred megabytes the pod spent minutes installing and is
 * not anybody's idea of a change to discard.
 */
export async function discardChanges(name: string, paths: string[] = []): Promise<void> {
  // `git reset` first, and it is not optional.
  //
  // A file the assistant has just created is usually intent-to-add rather than plain untracked,
  // because `workingDiff` runs `git add -A -N` over the whole tree so that `git diff HEAD` can
  // show new files at all. An intent-to-add path is in the index against the empty blob, and that
  // puts it in the blind spot between the two halves of a discard: `git checkout --` restores it
  // from that empty blob, truncating it to nothing, and `git clean` skips it because as far as
  // clean is concerned it is tracked.
  //
  // The result was that discarding a new file emptied it and left it there. The review screen
  // came back from "Discard all 5" still listing files, still marked Unsaved, and the assistant's
  // work was gone rather than reverted. Resetting the pathspec out of the index first puts the
  // files back to plain untracked, where clean removes them and checkout leaves them alone.
  // One pathspec for all four readings. Named files for the review screen's per-file selection,
  // `.` for the whole tree: all of them take the same one, so an untracked file in the list is
  // removed and a tracked one is restored, and nothing outside the list is touched.
  const spec = paths.length ? paths.map((p) => `'${ p.replace(/'/g, `'\\''`) }'`).join(' ') : '.';
  // `checkout` legitimately fails on a path git has never seen and `clean` legitimately fails
  // on a path that is not there any more, so the exit code of the three commands is not the
  // question. The question is whether anything survived them, which is what the last line
  // reads back: the union of "still differs from HEAD" and "git still does not know about it",
  // over the same pathspec, which after a discard has to be empty.
  //
  // Until this, all three were `2>/dev/null` and `;`-joined and the function returned void, so
  // a discard refused by a permission - or by an `index.lock` a concurrent count had taken -
  // came back looking exactly like one that worked, and the screen cleared its selection and
  // said "discarded".
  const out = await inPackageStrict(
    name,
    [
      `git reset -q -- ${ spec } 2>/dev/null || true`,
      // Checkout only what git knows about, and let clean take the rest.
      //
      // These cannot share a pathspec, and finding that out cost a regression. `git checkout --`
      // aborts the whole invocation on the first path it has never seen, restoring none of the
      // others - so a mixed list of one modified file and one new file left the modified one
      // modified while clean removed the new one. A discard that half-happens is worse than one
      // that refuses, because the screen says it discarded.
      //
      // It only became reachable when the `git reset` above was added, which is what turns an
      // intent-to-add path into one git no longer knows. Before that they were all known, and
      // checkout truncated the new ones to nothing instead. Two bugs, one at each end of the same
      // line, and the fix for the first uncovered the second.
      `known=$(git ls-files -- ${ spec } 2>/dev/null)`,
      `[ -n "$known" ] && git checkout -- $known 2>/dev/null || true`,
      `git clean -fd -e node_modules -- ${ spec } 2>/dev/null || true`,
      `echo "BARN-DISCARD-LEFT:$({ git diff --name-only --no-renames HEAD -- ${ spec } 2>/dev/null ; git ls-files -o --exclude-standard -- ${ spec } 2>/dev/null ; } | sort -u | tr '\\n' ' ')"`,
    ].join(' ; '),
    paths.length ? `discarding ${ paths.length } file${ paths.length === 1 ? '' : 's' }` : 'discarding the working tree'
  );

  const left = (/BARN-DISCARD-LEFT:(.*)/.exec(out)?.[1] || '').trim();

  if (left) {
    throw new Error(
      `the discard did not take: ${ left.split(/\s+/).slice(0, 6).join(', ') } ${ left.split(/\s+/).length === 1 ? 'is' : 'are' } still changed in ${ name }`
    );
  }
}

/**
 * Everything the Studio's extension list wants to know about one extension, in one exec.
 *
 * The list needs a branch, a change count and a last-changed time per row, and each of those on
 * its own is a shell into the pod. Three execs per row times a dozen rows is a page that takes
 * ten seconds to fill in; one exec that prints three lines is a page that does not. The parsing
 * is deliberately dull - `KEY=value` lines - because the alternative is quoting JSON through
 * two layers of shell.
 *
 * Everything is best-effort: a pod that is still coming up has no git repository yet, and the
 * right answer for that row is blanks rather than a failed page.
 */
export interface ExtensionDetail {
  branch:     string;
  changes:    number;
  /** The last commit, ISO 8601. '' when the repository has no history yet. */
  lastChange: string;
  /**
   * The newest modification time among the files git reports as changed, ISO 8601.
   *
   * A commit is not when an extension last changed, it is when somebody last decided a change
   * was finished. A column headed "Last change" that only moves on commit reads "1 day ago"
   * beside a subtitle announcing a change from four minutes ago, which is what the Studio's
   * list was doing. Only the uncommitted files are stat'ed: a clean tree has nothing newer
   * than its own last commit, and walking the package would mean walking node_modules.
   *
   * '' when nothing is uncommitted, or when the pod cannot be reached.
   */
  lastTouched: string;
}

export async function extensionDetail(name: string): Promise<ExtensionDetail> {
  const out = await inPackage(name, [
    'echo "BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"',
    // Against the baseline, not against HEAD, and for the reason countChanges gives: with the
    // assistant committing a turn at a time, "uncommitted files" is not a count of anything a
    // person is waiting on. This row's number has to mean the same thing as the review
    // screen's or the two disagree in front of somebody.
    BASELINE_SH,
    `echo "CHANGES=$(${ COUNT_SH })"`,
    'echo "LAST=$(git log -1 --format=%cI 2>/dev/null)"',
    // `cut -c4-` drops porcelain's two status characters and the space, and the sed keeps the
    // right-hand side of a rename. A path git had to quote fails `stat` and is skipped, which
    // costs one file's mtime out of a set and never the reading.
    `echo "TOUCHED=$(git status --porcelain 2>/dev/null | cut -c4- | sed 's/.* -> //' | tr '\\n' '\\0' | xargs -0 -r stat -c %Y 2>/dev/null | sort -n | tail -1)"`,
  ].join(' ; ')).catch(() => '');

  const read = (key: string): string => {
    const m = new RegExp(`^${ key }=(.*)$`, 'm').exec(out);

    return (m?.[1] || '').trim();
  };

  const touched = parseInt(read('TOUCHED'), 10);

  return {
    branch:      read('BRANCH'),
    changes:     parseInt(read('CHANGES'), 10) || 0,
    lastChange:  read('LAST'),
    lastTouched: touched ? new Date(touched * 1000).toISOString() : '',
  };
}

/**
 * What an extension was made from, as recorded when it was created.
 *
 * `github:owner/repo#ref` for an import, a seed name for one made from a template, or the name
 * of another extension for a copy. The Studio's list turns the first into a repository line and
 * everything else into "Created here".
 */
export async function extensionSource(name: string): Promise<string> {
  const cm = await extGet('configmaps', extensionObject(name)).catch(() => null);

  return cm?.metadata?.annotations?.[SOURCE_ANNOTATION] || '';
}

/**
 * Deferring a review: "I have seen this and I am not deciding today."
 *
 * Kept in the pod repository's own `git config`, which is the right shape for it three ways
 * over: it is local to the clone so it never travels to a remote, it is not a file so it never
 * appears in the working tree the review screens are counting, and it survives a pod restart
 * because the repository is on the hostPath.
 *
 * Deliberately not stored in BRIEF.md. The brief is the record of what a change is *for*, it
 * is committed, and it is read by a person - a scheduling note about one reviewer's afternoon
 * does not belong in it.
 */
const DEFER_KEY = 'barn.review.deferred';

export interface Deferral {
  at:   string;
  note: string;
}

export async function deferReview(name: string, note = ''): Promise<void> {
  const stamp = new Date().toISOString();

  await inPackage(name, [
    `git config --local ${ DEFER_KEY } ${ shellQuote(stamp) }`,
    `git config --local ${ DEFER_KEY }-note ${ shellQuote(note.slice(0, 200)) }`,
  ].join(' ; '));
}

export async function readDeferral(name: string): Promise<Deferral | null> {
  const out = await inPackage(name, [
    `echo "AT:$(git config --local --get ${ DEFER_KEY } 2>/dev/null)"`,
    `echo "NOTE:$(git config --local --get ${ DEFER_KEY }-note 2>/dev/null)"`,
  ].join(' ; ')).catch(() => '');

  const at = (/^AT:(.*)$/m.exec(out)?.[1] || '').trim();

  return at ? { at, note: (/^NOTE:(.*)$/m.exec(out)?.[1] || '').trim() } : null;
}

export async function clearDeferral(name: string): Promise<void> {
  await inPackage(name, [
    `git config --local --unset ${ DEFER_KEY } 2>/dev/null`,
    `git config --local --unset ${ DEFER_KEY }-note 2>/dev/null`,
    'true',
  ].join(' ; '));
}

/**
 * Where the change under review came from: the last commit, and when the tree was last edited.
 *
 * The masthead of screen 12 says which review this is, and the honest answer to "who authored
 * it and when" has two halves. The commit half is a fact git holds. The uncommitted half is
 * not: git records no author for a working tree, so the only thing that can be said about it
 * is when a file in it was last written, which `find -newer`-free `ls` cannot give portably
 * and `git status` does not carry. `stat` does, and busybox has it.
 *
 * Everything is best-effort and empty on failure, because a masthead is not worth a broken
 * page.
 */
export interface ChangeProvenance {
  /** ISO time of the most recently modified changed file, '' when there are none. */
  edited:  string;
  /** The last commit, which is what the change will sit on top of. */
  commit:  { sha: string; author: string; when: string; subject: string };
}

export async function changeProvenance(name: string): Promise<ChangeProvenance> {
  const out = await inPackage(name, [
    `git log -1 --format='SHA:%h%nAUTHOR:%an%nWHEN:%cI%nSUBJECT:%s' 2>/dev/null`,
    'echo "--edited--"',
    // The newest mtime among the files git reports as changed, as an epoch second. `cut -c4-`
    // drops porcelain's two status characters and the space after them.
    'git status --porcelain --no-renames 2>/dev/null | cut -c4- | tr -d \'"\' | while read -r p ; do [ -f "$p" ] && stat -c %Y "$p" 2>/dev/null ; done | sort -n | tail -1',
  ].join(' ; ')).catch(() => '');

  const [logOut = '', editedOut = ''] = out.split('--edited--');
  const field = (key: string) => (new RegExp(`^${ key }:(.*)$`, 'm').exec(logOut)?.[1] || '').trim();
  const epoch = parseInt(editedOut.trim(), 10);

  return {
    edited: Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000).toISOString() : '',
    commit: {
      sha: field('SHA'), author: field('AUTHOR'), when: field('WHEN'), subject: field('SUBJECT'),
    },
  };
}

/**
 * Snapshots: a named point you can put the working tree back to.
 *
 * `git stash create` plus a tag, not `git stash push` - push would *remove* the changes from
 * the tree, which is the opposite of what a snapshot is for. `create` builds the commit object
 * and leaves the tree alone; tagging it gives it a name and keeps it from being collected.
 *
 * Untracked files are included with `-u`, because on this product most of what the assistant
 * has just written is untracked and a snapshot that silently omits it is a trap.
 */
export interface Snapshot {
  ref:   string;
  label: string;
  when:  string;
}

const SNAP_PREFIX = 'barn-snap';

/**
 * Take a snapshot: a commit object holding the whole working tree, tagged so it survives.
 *
 * Not `git stash create`, which is the obvious tool and does not work here. This product runs
 * `git add -N` in several places (it is the only way an untracked file appears in `git diff`),
 * and `stash create` refuses outright when an intent-to-add entry is present - "Entry X not
 * uptodate. Cannot merge." Swallow that error and you get a snapshot that reports a sha, is
 * actually just HEAD, and quietly captures nothing.
 *
 * So: build a tree from a *scratch index*, commit it, and tag the commit. GIT_INDEX_FILE keeps
 * the real index untouched, `add -A` picks up untracked files that a stash would have needed
 * `-u` for, and the result is an ordinary commit any git tool can read.
 */
export async function createSnapshot(name: string, label: string): Promise<string> {
  const stamp = String(Date.now());
  const safe = label.replace(/[^\w .-]/g, '').slice(0, 60) || 'snapshot';
  const tag = `${ SNAP_PREFIX }/${ stamp }`;

  // Every step reports, and the tag is verified after it is written.
  //
  // This is the function the exec fix was written for. It used to send every git call to
  // /dev/null and answer with `SNAP:<sha>` as soon as commit-tree produced one, so a `git tag`
  // that git refused - which is what a root-owned `.git/refs` does - left a commit nothing
  // pointed at, a sha returned to a caller that believed it, and no snapshot in the list. The
  // rollback screen and the "before overwriting this file" safety step both took snapshots
  // that were not there when they were needed. So: strict, so a refusal arrives with git's own
  // stderr, and `rev-parse` on the tag afterwards, because the only proof a ref was written is
  // reading it back.
  const out = await inPackageStrict(name, [
    'test -d .git || { echo BARN-SNAP-NOGIT ; exit 1 ; }',
    'idx=$(mktemp)',
    'cp .git/index "$idx" 2>/dev/null || true',
    'GIT_INDEX_FILE="$idx" git add -A || { rm -f "$idx" ; exit 1 ; }',
    'tree=$(GIT_INDEX_FILE="$idx" git write-tree)',
    'rm -f "$idx"',
    '[ -n "$tree" ] || { echo BARN-SNAP-NOTREE ; exit 1 ; }',
    // A pod whose repository has no commit yet has no HEAD to parent to, and a snapshot of the
    // very first state is exactly the one worth having. `-p HEAD` only when there is a HEAD.
    'parent=""',
    'git rev-parse --verify -q HEAD >/dev/null && parent="-p HEAD"',
    `sha=$(git -c user.email=barn@rancher.local -c user.name=barn commit-tree $parent "$tree" -m ${ shellQuote(safe) })`,
    '[ -n "$sha" ] || { echo BARN-SNAP-NOCOMMIT ; exit 1 ; }',
    `git tag -f ${ tag } "$sha" || exit 1`,
    `git rev-parse --verify -q ${ tag } >/dev/null || { echo BARN-SNAP-NOTAG ; exit 1 ; }`,
    'echo "SNAP:$sha"',
  ].join(' ; '), `the snapshot of ${ name }`);

  const m = /SNAP:([0-9a-f]{7,40})/.exec(out);

  if (!m) {
    throw new Error(`could not snapshot ${ name }: ${ out.trim().slice(0, 200) || 'no output' }`);
  }

  return m[1];
}

/**
 * The last build of this extension that worked, as a point to go back to.
 *
 * Read out of the pod rather than out of the browser, which is what makes it a guarantee rather
 * than a convenience: it is there for somebody who has never published this extension
 * themselves, in a browser that has never seen it, on a tab opened a week later. Null means no
 * build of this extension has ever succeeded here, which is a real state on a pod that was
 * seeded an hour ago and is the one the failure screen has to say out loud instead of offering
 * the nearest hand-made snapshot as though it were a working build.
 */
export interface WorkingBuildPoint {
  /** The commit the ref is at. */
  sha:     string;
  /** Its subject, which `recordBaseline` wrote as "Working build <plugin> <version>". */
  subject: string;
  /** git's own relative wording, for a screen to render. */
  when:    string;
}

export async function lastWorkingBuild(name: string): Promise<WorkingBuildPoint | null> {
  const out = await inPackage(
    name,
    `git log -1 --format='%H%x1f%s%x1f%cr' ${ WORKING_BUILD_REF } 2>/dev/null`
  ).catch(() => '');
  const [sha = '', subject = '', when = ''] = out.trim().split('\x1f');

  return sha ? { sha: sha.trim(), subject: subject.trim(), when: when.trim() } : null;
}

/** The snapshots, newest first. The label is the commit's own subject. */
export async function listSnapshots(name: string): Promise<Snapshot[]> {
  const out = await inPackage(
    name,
    `git for-each-ref --sort=-creatordate --format='%(refname:short)%09%(creatordate:relative)%09%(contents:subject)' refs/tags/${ SNAP_PREFIX } 2>/dev/null`
  ).catch(() => '');

  return out.split('\n').map((l) => l.trimEnd()).filter(Boolean).map((line) => {
    const [ref, when = '', label = ''] = line.split('\t');

    return { ref, when, label: label || 'snapshot' };
  });
}

export interface HistoryEntry {
  /** A short sha for a commit, the tag ref for a snapshot. `showCommit` takes either. */
  ref:     string;
  subject: string;
  /** git's own relative wording. */
  when:    string;
  /** The commit's author. '' for a snapshot, which nobody authored. */
  who:     string;
  /** 'commit' | 'snapshot' */
  kind:    string;
  /** Seconds since the epoch, so the two sources can be put in one order. */
  at:      number;
}

/**
 * The commits and the automatic snapshots, newest first, in one list.
 *
 * `git log` alone cannot show a snapshot: createSnapshot commit-trees the working tree with
 * HEAD as its parent and tags the result, so a snapshot is a child of HEAD and never an
 * ancestor of it - it is invisible to a log walk by construction. The Files screen's history
 * is supposed to say where each entry came from, and half of the entries were missing.
 *
 * Added beside listCommits and listSnapshots rather than in place of them: both have callers
 * that want exactly one of the two.
 */
export async function listHistory(name: string, limit = 50): Promise<HistoryEntry[]> {
  const out = await inPackage(name, [
    `git log -n ${ limit } --format='%h%x1f%s%x1f%cr%x1f%an%x1f%ct' 2>/dev/null`,
    'echo "--snapshots--"',
    // A tab rather than the unit separator the log half uses: `%x1f` is a `git log` format
    // and `for-each-ref` prints it literally. A snapshot's subject cannot contain a tab -
    // createSnapshot strips its label to `[\w .-]` before it becomes one.
    `git for-each-ref --sort=-creatordate --format='%(refname:short)%09%(contents:subject)%09%(creatordate:relative)%09%(creatordate:unix)' refs/tags/${ SNAP_PREFIX } 2>/dev/null`,
  ].join(' ; ')).catch(() => '');

  const [logOut = '', snapOut = ''] = out.split('--snapshots--');

  const commits: HistoryEntry[] = logOut.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const [ref, subject = '', when = '', who = '', at = ''] = line.split('\x1f');

    return {
      ref, subject, when, who, kind: 'commit', at: parseInt(at, 10) || 0,
    };
  });

  const snapshots: HistoryEntry[] = snapOut.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const [ref, subject = '', when = '', at = ''] = line.split('\t');

    return {
      ref, subject: subject || 'snapshot', when, who: '', kind: 'snapshot', at: parseInt(at, 10) || 0,
    };
  });

  return [...commits, ...snapshots].sort((a, b) => b.at - a.at).slice(0, limit);
}

/**
 * Put the working tree back to a snapshot.
 *
 * Destructive, and the caller has to have asked first. It restores every path the snapshot
 * holds; it does not delete a file created after the snapshot was taken, because a restore
 * that removes work nobody asked it to remove is a worse surprise than one that leaves a
 * stray file behind. The screen says so.
 */
export async function restoreSnapshot(name: string, ref: string): Promise<void> {
  // `&&`, not `;`. With a semicolon the echo runs whatever the checkout did, so the guard below
  // could never fire: restoring a ref that does not resolve reported success, the caller cleared
  // the failure record and dismissed its panel, and nothing had been restored. A roll back that
  // says it worked and did not is worse than one that refuses, because the person stops looking.
  //
  // The ref is verified first rather than trusted to the checkout's exit code, so a ref that is
  // gone is reported as gone rather than as whatever git says about a pathspec it cannot resolve.
  //
  // Strict, and without the `2>&1` it used to carry: a checkout git refuses now arrives with
  // its own stderr and its exit code instead of as an empty string that failed the guard below
  // with nothing after the colon. "Could not restore: " told the person nothing.
  const out = await inPackageStrict(
    name,
    `git rev-parse --verify -q ${ shellQuote(ref) }^{commit} >/dev/null 2>&1 || { echo "NOREF"; exit 0; } ; ` +
    `git checkout ${ shellQuote(ref) } -- . || exit 1 ; echo "RESTORED"`,
    `restoring ${ ref }`
  );

  if (out.includes('NOREF')) {
    throw new Error(`could not restore ${ ref }: no such commit in this extension`);
  }

  if (!out.includes('RESTORED')) {
    throw new Error(`could not restore ${ ref }: ${ out.trim().slice(0, 200) || 'git said nothing at all' }`);
  }
}

/**
 * Undo the most recent change, whichever kind the last one was.
 *
 * Two kinds now, because the assistant commits a turn at a time (see barn-provenance.mjs):
 *
 *   A dirty working tree - the most recently modified changed file, restored to HEAD, or
 *   deleted if it is one the assistant created. Scoped to one file on purpose: an "undo" that
 *   reverts everything is a discard, and there is already a Discard all for that.
 *
 *   A clean tree whose HEAD is an assistant turn - `git reset --keep` back to the commit
 *   before it, which puts the whole turn back. Without this the Undo button stopped working
 *   the moment provenance started committing: there was never anything uncommitted to undo.
 *
 * It will not reset past the baseline. The last published version is not "a change" and
 * winding back through it would leave the review screens measuring from a commit that is no
 * longer in the branch's history.
 *
 * Returns a description of what it undid, or '' if there was nothing to undo. The caller puts
 * it in "The last change to <this> has been undone", so it has to read as a thing.
 */
export async function undoLastChange(name: string): Promise<string> {
  const turn = await inPackage(name, [
    BASELINE_SH,
    // Only when there is nothing uncommitted: an uncommitted edit is the more recent change
    // and is what the branch below undoes.
    'test -z "$(git status --porcelain 2>/dev/null)" || exit 0',
    'head=$(git rev-parse --verify -q HEAD)',
    '[ -n "$head" ] || exit 0',
    '[ "$head" != "$BARN_BASE" ] || exit 0',
    // A turn commit, not a hand commit: an assistant turn carries its own id, and undoing
    // somebody's deliberate commit is not what this button offers.
    'git log -1 --format=%B "$head" | grep -q "^Barn-Turn:" || exit 0',
    'git rev-parse --verify -q "$head^" >/dev/null || exit 0',
    'files=$(git show --name-only --format= "$head" | grep -c . )',
    'subject=$(git log -1 --format=%s "$head")',
    'first=$(git show --name-only --format= "$head" | head -1)',
    'git reset --keep "$head^" >/dev/null 2>&1 || exit 0',
    'echo "BARN-UNDID-TURN:$files:$first:$subject"',
  ].join(' ; ')).catch(() => '');

  const undone = /BARN-UNDID-TURN:(\d+):([^:]*):(.*)/.exec(turn);

  if (undone) {
    const count = parseInt(undone[1], 10) || 1;
    const first = undone[2] || 'the tree';
    const rest = count > 1 ? ` and ${ count - 1 } other file${ count === 2 ? '' : 's' }` : '';

    return `${ first }${ rest } (the assistant's turn "${ undone[3].trim() }")`;
  }

  const out = await inPackage(name, [
    // Newest first among the files git reports as changed.
    'f=$(git status --porcelain --no-renames 2>/dev/null | sed "s/^...//" | tr -d \'"\' | while read -r p; do [ -e "$p" ] && printf "%s\\t%s\\n" "$(stat -c %Y "$p" 2>/dev/null || echo 0)" "$p"; done | sort -rn | head -1 | cut -f2-)',
    '[ -z "$f" ] && { echo "NONE"; exit 0; }',
    // Tracked at HEAD -> restore it. Untracked -> the undo is removing it.
    'if git cat-file -e HEAD:"$f" 2>/dev/null; then git checkout HEAD -- "$f" 2>/dev/null; else rm -f "$f"; fi',
    'echo "UNDID:$f"',
  ].join(' ; ')).catch(() => '');

  const m = /UNDID:(.+)/.exec(out);

  return m ? m[1].trim() : '';
}

/**
 * Search every extension in the namespace for a set of terms.
 *
 * What the brief's "this already exists, partly" card needs: the same fixed-string grep
 * findUsages runs, but across all the packages rather than one, so the answer can be "the
 * longhorn-capacity extension already does part of this".
 */
export interface PriorArt {
  extension: string;
  path:      string;
  line:      number;
  text:      string;
}

export async function findPriorArt(terms: string[], limit = 24): Promise<PriorArt[]> {
  const useful = terms
    .map((t) => t.trim())
    .filter((t) => t.length >= 4)
    .slice(0, 6);

  if (!useful.length) {
    return [];
  }

  const all = await listExtensions().catch(() => []);
  const pattern = useful.map((t) => t.replace(/[.[\]*^$(){}|+?\\]/g, '\\$&')).join('|');

  const perExtension = await Promise.all(all.map(async(summary) => {
    const out = await inPackage(
      summary.name,
      `grep -rniE --exclude-dir=node_modules --exclude-dir=.git --include='*.vue' --include='*.ts' --include='*.md' -- ${ shellQuote(pattern) } . 2>/dev/null | head -n 8`
    ).catch(() => '');

    return out.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
      const m = /^\.?\/?(.+?):(\d+):(.*)$/.exec(line);

      return m ? {
        extension: summary.name, path: m[1], line: parseInt(m[2], 10), text: m[3].trim().slice(0, 160),
      } : null;
    }).filter(Boolean) as PriorArt[];
  }));

  return perExtension.flat().slice(0, limit);
}

/**
 * The change as one patch, collapsed against the baseline.
 *
 * What the Studio's Changes tab shows, and what the review screens read. One diff against the
 * last published version rather than the sequence of intermediate edits that produced it,
 * which is cross-screen rule 7: an edit made and undone before the hand-over contributes
 * nothing by construction, and a turn the assistant committed an hour ago is still in here
 * because it is still not in what anybody else can install.
 *
 * Against a commit, never against the index. `git diff` alone shows only what is *unstaged*,
 * so anything already staged vanishes from the review screens - and this product stages.
 * Found exactly that way, with the index fully staged and the diff pane empty.
 */
export async function workingDiff(name: string): Promise<string> {
  return inPackage(name, [BASELINE_SH, INTENT_SH, 'git diff --no-renames "$BARN_BASE" 2>/dev/null'].join(' ; '));
}

/**
 * The tmux session the workspace's terminal attaches to.
 *
 * `mc-` is the prefix shell.sh gives every session it opens; `editor` is the session id
 * PodTerminal defaults to, which is the one the workspace pane is looking at. Anything typed
 * into it is typed into the claude running in that pane.
 */
const ASSISTANT_TAB = 'editor';
const ASSISTANT_SESSION = `mc-${ ASSISTANT_TAB }`;

/** Where shell.sh looks for a prompt to open a new conversation with (see pod/shell.sh). */
const ASSISTANT_QUEUE = '/app/.queue/editor';

/**
 * Where a prompt came from, for the turn it is about to start.
 *
 * Only ever what a screen knows and says: the screen it was sent from, and the Rancher
 * principal whose session sent it. A prompt typed straight into the pane has no origin at all,
 * and the record for that turn carries no name rather than the nearest one. See the refusals
 * at the top of pod/barn-provenance.mjs.
 *
 * The principal is passed in rather than read here, so that this module never has to import
 * the review record and the two never form a cycle. `originStamp()` in review.ts builds one.
 */
export interface AssistantOrigin {
  /** Which screen sent it, e.g. `review-change`. */
  screen:     string;
  /** The Rancher principal id, when a screen resolved one. Empty is honest, wrong is not. */
  principal?: string;
  /** A readable name for that principal, when Rancher gave one. */
  name?:      string;
}

/**
 * Leave the stamp the UserPromptSubmit hook consumes, immediately before typing.
 *
 * One file, overwritten, consumed once by the hook that reads it. It is deliberately not a
 * queue: if two screens ask something a second apart, the second stamp replaces the first and
 * the turn it describes is the one that ran, which is a small loss and never a wrong name.
 */
async function stampOrigin(name: string, origin: AssistantOrigin): Promise<void> {
  const stamp = JSON.stringify({
    screen: origin.screen || '', principal: origin.principal || '', name: origin.name || '', at: new Date().toISOString(),
  });

  await podExecOnce(await extensionPod(name) || '', asPodUser(
    `mkdir -p /app/.barn && printf %s ${ shellQuote(stamp) } > /app/.barn/origin`
  )).catch(() => '');
}

/** One turn of the assistant, as the pod recorded it. See pod/barn-provenance.mjs. */
export interface AssistantTurn {
  turn:      string;
  /** What was asked. Empty for a turn whose prompt record was lost. */
  prompt:    string;
  at:        string;
  endedAt:   string;
  /** The screen that sent it, when the product sent it. Empty for a prompt typed in the pane. */
  screen:    string;
  principal: string;
  who:       string;
  files:     string[];
  /** The commit the turn ended in, or '' when it changed nothing. */
  commit:    string;
}

/** The turns the pod recorded, newest first. What the workspace's activity stream can show. */
export async function assistantTurns(name: string, limit = 25): Promise<AssistantTurn[]> {
  const out = await inPackage(name, `node /seed/barn-provenance.mjs turns ${ limit } 2>/dev/null`).catch(() => '');
  const found = /BARN-PROV:(.*)/.exec(out);

  if (!found) {
    return [];
  }

  try {
    return JSON.parse(found[1]) as AssistantTurn[];
  } catch {
    return [];
  }
}

/**
 * What produced the lines of the collapsed diff, hunk by hunk.
 *
 * The review-time half of the provenance system: the pod blames each hunk of the diff against
 * the baseline, resolves each line's commit to the `Barn-Turn:` trailer it carries, and looks
 * the turn up in the prompt log. See pod/barn-provenance.mjs for how it is captured and for
 * the four things it refuses to claim - in particular that a hunk answers with the *set of
 * turns* that produced its lines, never with one prompt, and that a line nobody watched is
 * reported as unrecorded rather than attributed to the nearest turn.
 *
 * `available: false` is the normal state of an extension whose pod predates the hooks. It
 * carries the reason so a screen can say which, rather than rendering an empty column.
 */
export interface TurnAttribution {
  turn:      string;
  prompt:    string;
  at:        string;
  screen:    string;
  principal: string;
  who:       string;
  subject:   string;
  /** How many of the hunk's lines came from this turn. */
  lines:     number;
  /**
   * True when the turn's commit contains this file but no tool record names it: swept into
   * the turn rather than caused by it. A `Bash` edit, or somebody typing in the Terminal tab.
   */
  swept:     boolean;
}

export interface HunkProvenance {
  /** First and last line of the hunk in the new file. */
  from:  number;
  to:    number;
  added: number;
  /** A hunk that only removed lines. There is no new line to attribute. */
  deletion?:  boolean;
  turns:      TurnAttribution[];
  /** Lines with no turn behind them: changed in the pod, no prompt recorded. */
  unrecorded: number;
}

export interface ChangeAttribution {
  available: boolean;
  /** Why not, when it is not. Shown as-is. */
  reason:    string;
  /** The commit the diff was taken against. */
  base:      string;
  baseRef:   string;
  files:     { path: string; hunks: HunkProvenance[] }[];
}

export async function provenanceFor(name: string): Promise<ChangeAttribution> {
  const missing = (reason: string): ChangeAttribution => ({
    available: false, reason, base: '', baseRef: '', files: [],
  });

  const out = await inPackage(name, [
    'test -f /seed/barn-provenance.mjs || { echo BARN-PROV-ABSENT ; exit 0 ; }',
    'node /seed/barn-provenance.mjs report 2>/dev/null',
  ].join(' ; ')).catch(() => '');

  if (out.includes('BARN-PROV-ABSENT')) {
    return missing('this pod was started before the Studio recorded provenance, so nothing was captured for it');
  }

  const found = /BARN-PROV:(.*)/.exec(out);

  if (!found) {
    return missing('the pod did not answer, so what produced these lines is not known');
  }

  try {
    return JSON.parse(found[1]) as ChangeAttribution;
  } catch {
    return missing('the pod answered with something unreadable');
  }
}

/**
 * Ask the claude running in an extension's pod a question, from a page that is not the
 * terminal.
 *
 * There is one conversation per pod and the workspace's pane is attached to it, so the way to
 * ask it something from another screen is to type into that pane - which is what `tmux
 * send-keys` does, and it is the same thing the terminal component does over its websocket. The
 * answer therefore arrives where the answer always arrives: in the workspace's terminal, in the
 * conversation that already knows what has been happening to this extension.
 *
 * Two outcomes, and the caller has to tell a person which one it was:
 *
 *   'sent'   - the session was there and now has the question in it.
 *   'queued' - nobody has opened the workspace for this pod yet, so there is no session to type
 *              into. The prompt is written to the file shell.sh reads when it starts a session
 *              (pod/shell.sh, `MC_QUEUE`), which makes it the first thing that conversation is
 *              asked. That is a real delivery, not a silent drop, and it is worth saying out
 *              loud because the answer does not exist until somebody opens the workspace.
 *
 * One line, always. The pane is a REPL: a newline in the middle of a prompt submits half a
 * question, so every caller's text is flattened before it goes anywhere near it.
 */
/**
 * Where a new conversation starts, for the stream that shows it.
 *
 * `/clear` is claude's own command and it clears claude's context. It does not - and must not -
 * clear the pod's provenance log: that log is what every change set in the Changes tab is made
 * of, and a commit whose prompt had been deleted would be a change nobody could account for.
 *
 * So the two are separated. The record keeps everything; the conversation on screen starts at
 * this mark. Written into the pod rather than held in the browser so that it survives a reload
 * and is the same for anybody else looking at the same extension.
 */
const CONVERSATION_MARK = '/app/.barn/conversation-since';

/**
 * Start a new conversation: clear claude's context, and move the mark.
 *
 * The `/clear` goes through the session the way a person at the pane would type it, and the
 * mark is written first - if the typing fails, a stream that has already moved on is a worse
 * lie than a conversation that did not clear.
 */
export async function startNewConversation(name: string): Promise<string> {
  const since = new Date().toISOString();

  await inPackageStrict(
    name,
    `mkdir -p /app/.barn && printf %s ${ shellQuote(since) } > ${ CONVERSATION_MARK }`,
    'starting a new conversation',
  );

  await askAssistant(name, '/clear').catch(() => 'queued');

  return since;
}

/** When the conversation on screen starts. '' when it has never been cleared. */
export async function conversationSince(name: string): Promise<string> {
  const out = await inPackage(name, `cat ${ CONVERSATION_MARK } 2>/dev/null`).catch(() => '');

  return out.trim();
}

export async function askAssistant(
  name: string, prompt: string, origin?: AssistantOrigin
): Promise<'sent' | 'queued'> {
  const line = prompt.replace(/\s+/g, ' ').trim();

  if (!line) {
    throw new Error('there is nothing to ask');
  }

  const pod = await extensionPod(name);

  if (!pod) {
    throw new Error(`${ name } has no running pod to ask`);
  }

  if (origin) {
    await stampOrigin(name, origin);
  }

  const text = shellQuote(line);
  // The pause between the text and the Return is not superstition: claude's input is a TUI that
  // redraws as it receives, and a Return in the same burst as a long paste is read before the
  // paste has finished being taken in.
  // Start the session if it is not there, rather than going straight to the
  // queue. The queue was written when the Terminal tab ran claude and was
  // therefore certain to start it sooner or later; the Terminal tab is now a
  // plain shell, so nothing else would ever start it and a queued prompt would
  // wait for a pane that is never opened. `shell.sh ... start` creates it
  // detached and is a no-op when it already exists, so this costs one exec the
  // first time and nothing afterwards.
  //
  // The queue is still the fallback: if the session cannot be started, a prompt
  // written down is better than one lost.
  const out = await inPackage(name, [
    `if ! tmux has-session -t ${ ASSISTANT_SESSION } 2>/dev/null ; then`,
    `/bin/sh /seed/shell.sh ${ ASSISTANT_TAB } '' '' start >/dev/null 2>&1 || true ;`,
    'sleep 2 ; fi ;',
    `if tmux has-session -t ${ ASSISTANT_SESSION } 2>/dev/null ; then`,
    `tmux send-keys -t ${ ASSISTANT_SESSION } -l ${ text } && sleep 1 &&`,
    `tmux send-keys -t ${ ASSISTANT_SESSION } Enter && echo BARN-ASK-SENT ;`,
    `else mkdir -p "$(dirname ${ ASSISTANT_QUEUE })" && printf %s ${ text } > ${ ASSISTANT_QUEUE } &&`,
    'echo BARN-ASK-QUEUED ; fi',
  ].join(' '));

  if (out.includes('BARN-ASK-SENT')) {
    return 'sent';
  }

  if (out.includes('BARN-ASK-QUEUED')) {
    return 'queued';
  }

  throw new Error(`the question did not reach ${ name }: ${ out.trim().slice(0, 200) || 'no output' }`);
}

/**
 * Whether the claude in this extension's pod has a credential to work with, and whose.
 *
 * The workspace's status strip used to say "Connected as admin" and mean the dashboard's own
 * signed-in user, which is not the assistant's session at all: the strip read green while every
 * turn in the pane came back "Not logged in - Please run /login". That is worse than the
 * terminal line it was meant to replace, so this reads the thing it claims to.
 *
 * Three places a credential can be, in the order claude itself looks: the OAuth credentials file
 * the CLI writes on login, an API key or OAuth token in the pod's environment, and the account
 * record in `.claude.json` (which is what names the address). The marker line separates "read
 * the pod and there is nothing" from "could not read the pod", because saying somebody is signed
 * out when you failed to ask is the same class of mistake this replaces.
 */
export interface AssistantLogin {
  /** Whether the pod could be read at all. Nothing else here means anything when false. */
  read:     boolean;
  signedIn: boolean;
  /** The account, when the credential says which. Empty for an API key, which names nobody. */
  account:  string;
}

const LOGIN_MARKER = 'BARN-LOGIN';

/** The tmux session `claude setup-token` runs in, separate from the assistant's own. */
const LOGIN_SESSION = 'mc-login';

/**
 * Everything the sign-in printed, kept where it can still be read after it has gone.
 *
 * The session ends the moment `claude setup-token` finishes, successfully or not, so the pane
 * is not a place a result can be waited for. This file is.
 */
const LOGIN_LOG = '/app/.barn/login.log';

/**
 * Start the sign-in and hand back the page to authorise on.
 *
 * `claude setup-token` is the flow that produces a long-lived token, and it is interactive: it
 * prints a URL, waits, and exchanges whatever code is pasted back. Nothing in a browser can run
 * it on the pod's behalf, but the pod can run it and this can carry the two ends - which is the
 * whole of what a person needs to do here, without a terminal.
 *
 * In a tmux session of its own, never the assistant's: the assistant's pane holds a
 * conversation, and starting a login in it would leave a half-finished prompt in the middle of
 * one. Detached, so this returns as soon as the URL is on screen rather than holding an exec
 * open for as long as somebody takes to authorise.
 */
export async function beginAssistantLogin(name: string): Promise<string> {
  await inPackage(name, [
    `tmux kill-session -t ${ LOGIN_SESSION } 2>/dev/null || true`,
    `mkdir -p /app/.barn ; : > ${ LOGIN_LOG }`,
    `tmux -f /seed/tmux.conf new-session -d -x 200 -y 50 -s ${ LOGIN_SESSION } -c /app 'claude setup-token'`,
    // Everything the pane prints, into a file as well.
    //
    // `claude setup-token` prints the token it obtained and then exits, which takes the tmux
    // session with it - so a reader polling `capture-pane` every second and a half loses the
    // one line it exists to read, and reports a sign-in that worked as one that produced
    // nothing. `pipe-pane` keeps the TTY the TUI needs and writes a copy that outlives it.
    `sleep 1 ; tmux pipe-pane -t ${ LOGIN_SESSION } -o ${ shellQuote(`cat >> ${ LOGIN_LOG }`) } 2>/dev/null || true`,
  ].join(' ; ')).catch(() => '');

  // It prints the URL a moment after starting. Polled rather than slept at, so a fast pod is
  // not waited on and a slow one is not cut off.
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const pane = await inPackage(name, `tmux capture-pane -p -t ${ LOGIN_SESSION } 2>/dev/null`).catch(() => '');
    const url = urlInPane(pane);

    if (url) {
      return url;
    }
  }

  throw new Error('the pod started the sign-in but printed no address to authorise at');
}

/**
 * The authorise URL, put back together out of the pane.
 *
 * claude wraps it at seventy columns with hard breaks, so the address is several lines and a
 * pane of any width still splits it. The continuation lines are the only ones with no spaces
 * in them, which is what makes rejoining them safe: the first line that contains a space is
 * prose again ("Paste code here if prompted"), not more URL.
 */
export function urlInPane(pane: string): string {
  const lines = String(pane || '').split('\n').map((line) => line.trim());
  const start = lines.findIndex((line) => line.startsWith('https://'));

  if (start === -1) {
    return '';
  }

  let url = lines[start];

  for (const next of lines.slice(start + 1)) {
    if (!next || next.includes(' ')) {
      break;
    }

    url += next;
  }

  return url;
}

/**
 * Finish the sign-in with the code from that page.
 *
 * Typed and submitted separately, with a pause between: claude's input is a TUI that redraws as
 * it receives, and a Return arriving in the same burst as a long paste is read before the paste
 * has finished. The same reason `askAssistant` does it that way.
 *
 * What comes back is a token, which is then stored the way a pasted one would be, so there is
 * one path into the pod's credential rather than two.
 */
/**
 * Start the assistant's session again, so a credential written just now is the one it uses.
 *
 * A signed-in pod can still answer every prompt with `401 Invalid bearer token`, and this is
 * why: claude reads its credential when it starts and holds it. The session in a pod that has
 * been up for a day began before anybody signed in, so it goes on sending the auth it started
 * with - none - while `.credentials.json` sits beside it, valid and unread. The strip said
 * "the assistant is signed in", because the file it checks was there, and it was right about
 * the pod and wrong about the process.
 *
 * Killed rather than reloaded, because there is no reload: the session is `claude` running
 * under tmux, and the only way it re-reads that file is to be it again. `shell.sh` starts a new
 * one with `-A`, so the next thing that attaches gets a fresh session rather than an error, and
 * the conversation continues from claude's own transcript with `--continue`.
 *
 * Best effort. A sign-in that stored a credential has done the thing it was asked to do; if the
 * restart fails, the next tab to open starts a session that reads it anyway.
 */
async function restartAssistantSession(name: string): Promise<void> {
  await inPackage(name, [
    `tmux kill-session -t ${ ASSISTANT_SESSION } 2>/dev/null || true`,
    `/bin/sh /seed/shell.sh ${ ASSISTANT_TAB } '' '' start >/dev/null 2>&1 || true`,
  ].join(' ; ')).catch(() => '');
}

/**
 * The token in whatever the sign-in printed.
 *
 * Claude prints it into a TUI, so it arrives wrapped across two pane lines with terminal
 * control sequences between the halves, and coloured - which puts an escape immediately after
 * it. Two mistakes are available here and this made both:
 *
 *   Matching on the raw text stops at the first escape and stores half a token.
 *   Stripping every escape first joins the token to the sentence after it ("Store this token
 *   securely...") and stores 22 characters too many.
 *
 * Both fail the same way at the server - "OAuth access token is invalid" - which is why this
 * took so long to see. So only the WRAP is undone: a carriage return followed by cursor-right
 * or cursor-down, which is how the pane continues a long line. Every other escape is left in
 * place, and one of them is what ends the match.
 */
function tokenIn(output: string): string {
  const esc = String.fromCharCode(27);
  const text = String(output || '');
  const at = text.indexOf('sk-ant-');

  if (at === -1) {
    return '';
  }

  const unwrapped = text
    .slice(at, at + 400)
    .split(new RegExp(`\r?${ esc }\\[[0-9]*[CB]`, 'g'))
    .join('')
    .split('\r')
    .join('');

  return /^(sk-ant-[A-Za-z0-9_-]+)/.exec(unwrapped)?.[1] || '';
}

export async function completeAssistantLogin(name: string, code: string): Promise<'apikey' | 'oauth'> {
  const value = String(code || '').trim();

  if (!value) {
    throw new Error('there is no code to send');
  }

  if (/\s/.test(value)) {
    throw new Error('that does not look like a code: it has whitespace in it');
  }

  // The session has to be there, and has to be asking for a code.
  //
  // Two states this used to type into regardless. A sign-in that already succeeded kills its
  // session, so a second attempt from a dialog left open sent the code to a name tmux no longer
  // knows - `send-keys` fails quietly and nothing happens. And a code claude rejected leaves it
  // showing "OAuth error: Invalid code · Press Enter to retry", which is not the paste prompt:
  // anything typed there is dropped, so every retry after the first failure failed the same way
  // whatever was pasted. Enter is what returns it to the prompt, so that is what this sends.
  const opening = await inPackage(
    name,
    `tmux capture-pane -p -t ${ LOGIN_SESSION } 2>/dev/null || echo BARN-NO-LOGIN-SESSION`,
  ).catch(() => 'BARN-NO-LOGIN-SESSION');

  // A session that has already gone may still have left the answer behind.
  if (opening.includes('BARN-NO-LOGIN-SESSION')) {
    const finished = await inPackage(name, `cat ${ LOGIN_LOG } 2>/dev/null`).catch(() => '');
    const already = tokenIn(finished);

    if (already) {
      const kind = await setAssistantToken(name, already);

      await restartAssistantSession(name);

      return kind;
    }
  }

  if (opening.includes('BARN-NO-LOGIN-SESSION') || !opening.trim()) {
    throw new Error('the sign-in this code belongs to has ended. Close this and open it again for a fresh address.');
  }

  if (/press enter to retry/i.test(opening)) {
    await inPackage(name, [
      `tmux send-keys -t ${ LOGIN_SESSION } Enter`,
      'sleep 2',
    ].join(' && ')).catch(() => '');
  }

  // What the credential looked like BEFORE the code was sent.
  //
  // The check further down used to be `test -f`, which is true of a pod that has signed in at
  // any point in its life - including one whose token expired an hour ago. So a sign-in
  // reported success the instant it was asked, restarted the session onto the same dead
  // credential, and the next prompt came back "401 OAuth access token has been revoked". What
  // says the exchange actually happened is the file CHANGING, so this is what it is compared
  // against.
  const before = await inPackage(
    name,
    `node -e 'const f=process.env.HOME+"/.claude/.credentials.json";let d={};try{d=require(f)}catch{};const o=d.claudeAiOauth||{};process.stdout.write(o.accessToken&&(!o.expiresAt||o.expiresAt>Date.now())?"valid:"+(o.expiresAt||0):"no")' 2>/dev/null`,
  ).catch(() => 'no');

  await inPackage(name, [
    `tmux send-keys -t ${ LOGIN_SESSION } -l ${ shellQuote(value) }`,
    'sleep 1',
    `tmux send-keys -t ${ LOGIN_SESSION } Enter`,
  ].join(' && '));

  const done = async (kind: 'apikey' | 'oauth'): Promise<'apikey' | 'oauth'> => {
    await inPackage(name, `tmux kill-session -t ${ LOGIN_SESSION } 2>/dev/null || true`).catch(() => '');
    await restartAssistantSession(name);

    return kind;
  };

  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // The live pane when there is one, and the log either way: the session may already have
    // exited with the answer in it.
    const pane = await inPackage(
      name,
      `tmux capture-pane -p -t ${ LOGIN_SESSION } 2>/dev/null ; cat ${ LOGIN_LOG } 2>/dev/null`,
    ).catch(() => '');
    const token = tokenIn(pane);

    if (token) {
      return done(await setAssistantToken(name, token));
    }

    // Claude stored it itself.
    //
    // `claude setup-token` used to print the token for the caller to do something with, and
    // this scraped it out of the pane. It does not any more: it writes the credential into
    // `$HOME/.claude/.credentials.json` and says so in words. Watching only for a printed
    // token therefore failed a sign-in that had already succeeded - the dialog said "the pod
    // took the code but printed no token, so nothing was stored" over a pod that was, at that
    // moment, signed in. The credential is the thing that matters and the thing every other
    // screen reads, so its arrival is what this waits for.
    // Changed AND usable.
    //
    // "Changed" alone is not success, and waiting for it caused the loop this was meant to end.
    // The credential file is touched by things that are not this sign-in: `claude-credentials
    // .mjs pull` writes the shared copy from the Secret whenever a session starts, and claude
    // rewrites the block itself when a token is refused. Both look like a change. Worse, this
    // returning early restarts the session, and the restart runs a `pull` - so the fresh token
    // was replaced by the shared, expired one before it had been written.
    //
    // What can only be true when the exchange worked is a credential with a token in it that
    // has not expired. So that is what is waited for.
    const now = await inPackage(
      name,
      `node -e 'const f=process.env.HOME+"/.claude/.credentials.json";let d={};try{d=require(f)}catch{};const o=d.claudeAiOauth||{};process.stdout.write(o.accessToken&&(!o.expiresAt||o.expiresAt>Date.now())?"valid:"+(o.expiresAt||0):"no")' 2>/dev/null`,
    ).catch(() => 'no');

    if (now.startsWith('valid:') && now.trim() !== before.trim()) {
      return done('oauth');
    }

    // Claude's own words for a code it would not take. It says this and waits, so the message
    // has to name the likely cause: a code can be exchanged once, and the one on screen has
    // usually already been spent by the attempt before this one.
    if (/oauth error|invalid code|expired|failed/i.test(pane)) {
      throw new Error('the pod did not accept that code: claude reported it invalid. A code can only be used once - take a fresh one from the address above.');
    }
  }

  // Neither printed nor stored. Say which, because "nothing happened" and "it worked and this
  // could not tell" are different problems and the second one was this function's own bug.
  throw new Error('the pod took the code but never ended up with a working credential. The code may have been used already, or pasted incomplete - take a fresh one from the address above.');
}

/**
 * Give this pod's claude a credential, from a token somebody pasted.
 *
 * The interactive `/login` is an OAuth round trip through a browser, which a dialog in Rancher
 * cannot perform on the pod's behalf. What it can do is take the artefact that flow produces -
 * a token from `claude setup-token`, or an Anthropic API key - and put it where claude looks.
 *
 * Into `settings.json`'s `env` rather than a shell profile, because that is the one environment
 * every claude in this pod inherits: the pane, and the hooks, which do not run under a login
 * shell. Written 0600 and never read back by anything here.
 *
 * Which variable is decided by the token's own shape: an `sk-ant-` key is an API key, and
 * anything else is treated as an OAuth token. Guessing wrong is a login that does not work, so
 * the caller is told which one it chose.
 */
export async function setAssistantToken(name: string, token: string): Promise<'apikey' | 'oauth'> {
  const value = String(token || '').trim();

  if (!value) {
    throw new Error('there is no token to set');
  }

  if (/\s/.test(value)) {
    throw new Error('that does not look like a token: it has whitespace in it');
  }

  // Which of the two this is, by the prefix claude gives it.
  //
  // `sk-ant-oat…` is the long-lived OAuth token `claude setup-token` prints, and claude's own
  // closing line says what to do with it: "Use this token by setting
  // CLAUDE_CODE_OAUTH_TOKEN". `sk-ant-api…` is an API key. Both begin `sk-ant-`, and testing
  // only that put every OAuth token into ANTHROPIC_API_KEY - where claude sends it as an API
  // key, the server rejects it, and the pod answers "401 Invalid bearer token" with a
  // perfectly good token stored. A sign-in that ends in a 401 is this line.
  const oauth = /^sk-ant-oat/i.test(value);
  const kind = oauth ? 'oauth' : 'apikey';
  const variable = oauth ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY';

  const script = [
    `node -e 'const fs=require("fs");const p=process.env.HOME+"/.claude/settings.json";`,
    'let s={};try{s=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){};',
    's.env=Object.assign({},s.env);',
    // Only one of the two is ever set: leaving a stale key beside a new token is how a pod
    // goes on using the credential somebody thought they had just replaced.
    'delete s.env.ANTHROPIC_API_KEY;delete s.env.CLAUDE_CODE_OAUTH_TOKEN;',
    's.env[process.argv[1]]=process.argv[2];',
    'fs.mkdirSync(require("path").dirname(p),{recursive:true});',
    `fs.writeFileSync(p,JSON.stringify(s,null,2)+"\\n",{mode:0o600})' ${ shellQuote(variable) } ${ shellQuote(value) }`,
    '&& echo BARN-TOKEN-SET',
  ].join(' ');

  const out = await inPackage(name, script);

  if (!out.includes('BARN-TOKEN-SET')) {
    throw new Error(`the token did not reach ${ name }: ${ out.trim().slice(0, 200) || 'no output' }`);
  }

  // The running session has the old credential in memory - or none - and will keep answering
  // 401 with a valid one on disk beside it. See restartAssistantSession.
  await restartAssistantSession(name);

  return kind;
}

export async function assistantLogin(name: string): Promise<AssistantLogin> {
  const out = await inPackage(name, [
    `echo ${ LOGIN_MARKER }`,
    // Not `test -f`. A credentials file exists in every pod that has ever signed in, including
    // one whose tokens claude has since emptied - which is what it does when the server says
    // the token was revoked: the file stays, with `accessToken: ""` and `expiresAt: 0` in it.
    // Read that way, "signed in" was true of a pod that could not answer a single prompt.
    `node -e 'const d=require(process.env.HOME+"/.claude/.credentials.json");const o=d.claudeAiOauth||{};if(o.accessToken&&(!o.expiresAt||o.expiresAt>Date.now()))process.stdout.write("credentials")' 2>/dev/null`,
    '[ -n "$ANTHROPIC_API_KEY$CLAUDE_CODE_OAUTH_TOKEN" ] && echo apikey',
    // A token pasted into the sign-in dialog lands in claude's settings rather than in this
    // exec's environment, so the check above cannot see it. Without this the strip went on
    // saying "not signed in" immediately after somebody had signed in, which reads as the
    // dialog having done nothing.
    `grep -q '"\\(ANTHROPIC_API_KEY\\|CLAUDE_CODE_OAUTH_TOKEN\\)"' "$HOME/.claude/settings.json" 2>/dev/null && echo apikey`,
    `grep -o '"emailAddress":"[^"]*"' "$HOME/.claude.json" 2>/dev/null | head -1`,
  ].join(' ; ')).catch(() => '');

  if (!out.includes(LOGIN_MARKER)) {
    return { read: false, signedIn: false, account: '' };
  }

  const email = /"emailAddress":"([^"]*)"/.exec(out);

  return {
    read:     true,
    signedIn: out.includes('credentials') || out.includes('apikey') || !!email,
    account:  email ? email[1] : '',
  };
}

export interface PullRequest {
  number: number;
  title:  string;
  url:    string;
  head:   string;
}

/**
 * The open pull request whose head branch is this extension's branch, if there is one.
 *
 * Asked from inside the pod rather than from the page, for the reason the settings Secret gives
 * for living in the cluster: the token belongs to the cluster, and the pod is the thing that
 * already talks to GitHub with it (`publishExtensionToGithub` pushes from there). Keeping both
 * halves in the same place means one story about where the credential goes, and it works from a
 * browser that cannot reach github.com.
 *
 * The list is filtered on `head.ref` here rather than with the API's `head=owner:branch`
 * parameter, because that parameter needs the head *owner*, and a branch pushed from a fork has
 * an owner this product never learns. Null means asked and answered: there is no open PR for
 * that branch. A failure throws, so the caller can say "could not ask" rather than "there is
 * none", which are different facts.
 */
export async function findOpenPullRequest(name: string, repo: string, branch: string): Promise<PullRequest | null> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(`"${ repo }" is not owner/name`);
  }

  if (!branch) {
    throw new Error('the extension is not on a branch');
  }

  // One call through the shared script rather than a fetch of its own. The list of open pull
  // requests is not a credential, so the matching is done here where it can be read, and the
  // pod is left doing the one thing only it can do: getting at the token.
  const answer = await githubApi(name, 'GET', `/repos/${ repo }/pulls?state=open&per_page=100`);
  const list: any[] = Array.isArray(answer) ? answer : [];
  const pr = list.find((p) => p?.head?.ref === branch);

  return pr ? {
    number: pr.number, title: pr.title, url: pr.html_url, head: pr.head.ref,
  } : null;
}

/**
 * Run a GitHub API call from inside the pod, with the configured token.
 *
 * The same reasoning findOpenPullRequest gives for asking from in there: the token belongs to
 * the cluster, the pod is the thing that already talks to GitHub with it, and it works from a
 * browser that cannot reach github.com. The token goes in the environment rather than in argv,
 * so it is not in the pod's process list for the length of the call.
 *
 * Every caller here needs the same three things - a method, a path and a body - so they share
 * one script instead of each embedding their own fetch in a shell-quoted string.
 */
async function githubApi(
  name: string, method: string, apiPath: string, body?: unknown
): Promise<any> {
  const out = await runInPackage(
    name,
    [
      `node -e ${ shellQuote(githubScript()) }`,
      shellQuote(method),
      shellQuote(apiPath),
      shellQuote(body === undefined ? '' : JSON.stringify(body)),
      '2>&1',
    ].join(' ')
  );

  // The body alone. The two headers the shared script also carries are only wanted by the
  // settings card, which asks through `githubApiAnywhere` below.
  return readGithubAnswer(out, `${ name }'s pod`).body;
}

/**
 * The same call, from whatever pod happens to be running, with the response headers.
 *
 * For the questions that come before an extension exists. Import is asked on a screen where
 * there is no pod of this extension's own to run in, because the extension is what the answer
 * is going to create - so it borrows one, the way `githubFiles` already does.
 *
 * The scopes a token carries and when it expires are in response headers and nowhere in any
 * body, and the settings card states both, so this form hands back what the script saw rather
 * than only the JSON.
 */
async function githubApiAnywhere(method: string, apiPath: string): Promise<any> {
  const pod = await anyRunningPod();

  if (!pod) {
    throw new Error('no extension pod is running to ask GitHub from');
  }

  const out = await podExecOnce(pod, asPodUser(
    `node -e ${ shellQuote(githubScript()) } ${ shellQuote(method) } ${ shellQuote(apiPath) } '' 2>&1`
  ));

  return readGithubAnswer(out, 'a running extension pod');
}

/** Who the configured token belongs to, and what it is allowed to do. */
export interface GithubIdentity {
  login:     string;
  /** The scopes GitHub says the token carries. Empty for a fine-grained token, which lists none. */
  scopes:    string[];
  /** When it expires, when GitHub says. Empty means it does not, or would not say. */
  expiresAt: string;
}

/**
 * Whose token this is.
 *
 * Null means there is no token configured, which is a different fact from "the token is bad"
 * and the two must not be shown as the same sentence. A bad token throws.
 */
export async function githubIdentity(): Promise<GithubIdentity | null> {
  // Whether there is one, from the annotation. Not the token itself, which this page may not
  // have and does not need: the pod reads it when the question is put.
  if (!(await readSettings('')).hasToken) {
    return null;
  }

  const answer = await githubApiAnywhere('GET', '/user');

  return {
    login:     answer?.body?.login || '',
    scopes:    String(answer?.scopes || '').split(',').map((s: string) => s.trim()).filter(Boolean),
    expiresAt: answer?.expires || '',
  };
}

export interface GithubRepo {
  fullName:      string;
  private:       boolean;
  updatedAt:     string;
  defaultBranch: string;
  description:   string;
}

/**
 * The repositories this token can see, most recently touched first.
 *
 * `affiliation` rather than `/users/<login>/repos`, so a repository somebody was added to as a
 * collaborator is in the list. An import is as likely to be of somebody else's extension as of
 * your own.
 */
export async function listGithubRepos(limit = 30): Promise<GithubRepo[]> {
  const capped = Math.max(1, Math.min(100, limit));
  const answer = await githubApiAnywhere(
    'GET',
    `/user/repos?sort=updated&per_page=${ capped }&affiliation=owner,collaborator,organization_member`
  );
  const list = Array.isArray(answer?.body) ? answer.body : [];

  return list.map((repo: any) => ({
    fullName:      repo.full_name || '',
    private:       !!repo.private,
    updatedAt:     repo.updated_at || '',
    defaultBranch: repo.default_branch || '',
    description:   repo.description || '',
  })).filter((repo: GithubRepo) => !!repo.fullName);
}

/** The branch a repository calls its default, which is where a distribution goes. */
export async function githubDefaultBranch(name: string, repo: string): Promise<string> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(`"${ repo }" is not owner/name`);
  }

  const info = await githubApi(name, 'GET', `/repos/${ repo }`);

  return info?.default_branch || 'main';
}

/**
 * Open the pull request that is the hand-off record.
 *
 * Cross-screen rule 5: crossing the gate produces the PR, and the PR is what carries the
 * review. Until now nothing in the product ever created one, which is why the chip that reads
 * them had a precondition the product could not produce.
 *
 * A PR that already exists for the same head branch is not an error and is returned as it
 * stands: pushing a packet again after a review asked for changes should find its own PR
 * rather than fail on the second attempt.
 */
export async function createPullRequest(
  name: string, repo: string, spec: { head: string; base: string; title: string; body: string }
): Promise<PullRequest> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(`"${ repo }" is not owner/name`);
  }

  try {
    const pr = await githubApi(name, 'POST', `/repos/${ repo }/pulls`, spec);

    return {
      number: pr.number, title: pr.title, url: pr.html_url, head: pr.head?.ref || spec.head,
    };
  } catch (e: any) {
    // GitHub answers 422 for "a pull request already exists" as well as for a bad request, so
    // the only way to tell them apart is to go and look.
    const existing = await findOpenPullRequest(name, repo, spec.head).catch(() => null);

    if (existing) {
      return existing;
    }

    throw e;
  }
}

/**
 * Add a comment to the pull request that records this hand-off.
 *
 * Best effort by contract: the review lives in the cluster and the PR is a mirror of it, so a
 * mirror that failed must be reported as a mirror that failed and never allowed to look like
 * the review did not happen.
 */
export async function commentOnPullRequest(
  name: string, repo: string, number: number, body: string
): Promise<void> {
  await githubApi(name, 'POST', `/repos/${ repo }/issues/${ number }/comments`, { body });
}

/**
 * Give the pod what it needs to photograph itself, and refresh it while the workspace is open.
 *
 * Two things: a short-lived Rancher session for the shared browser, and the route to point it
 * at. The hooks that take the pictures run inside the pod with no way to mint either - the pod
 * is deliberately not told a password, and the route lives in the extension's own routing table
 * which this side has already parsed.
 *
 * The token expires by itself. That is the point of writing it rather than a password: a pod
 * left running overnight holds nothing that still works, and the only consequence is that the
 * next turn's pictures are not taken.
 *
 * Best effort throughout. Evidence is not a step of anybody's turn, and a workspace that
 * refused to open because a screenshot credential could not be minted would be a bad trade.
 */
export async function pushCaptureSetup(name: string, route: string): Promise<void> {
  const token = await captureToken().catch(() => '');

  if (!token) {
    return;
  }

  const where = shellQuote(route || '/');

  await inPackage(name, [
    `printf %s ${ shellQuote(token) } > "$HOME/.capture-token"`,
    'chmod 600 "$HOME/.capture-token"',
    // The route reaches the hooks as an environment variable, and a hook inherits the session's
    // environment rather than this exec's - so it is written where claude's own settings put
    // it, which is the one environment every hook in this pod does get.
    `node -e 'const fs=require("fs");const p=process.env.HOME+"/.claude/settings.json";let s={};try{s=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){};s.env=Object.assign({},s.env,{BARN_CAPTURE_ROUTE:process.argv[1]});fs.mkdirSync(require("path").dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(s,null,2)+"\\n",{mode:0o600})' ${ where }`,
  ].join(' ; ')).catch(() => '');
}

/**
 * What to outline in a change set's picture, read out of the change itself.
 *
 * A changed template line that carries `class="..."`, `data-testid="..."` or `id="..."` names
 * something that is in the rendered document by that exact string, so an outline drawn on it is
 * a match rather than a guess. This is the same reading the change screen's diff-to-page
 * pointer uses; it is applied here to the commit rather than to a line somebody clicked.
 *
 * Added lines only. A removed line names something that is no longer on the page, and outlining
 * it would draw a box around whatever happens to carry that class now.
 *
 * Empty when the change set touched nothing that names itself - a script-only change, a
 * rename - and empty is the right answer there: a picture with no box on it says "this is what
 * it looks like", which is true, where a box around the whole page would not be.
 */
export function selectorsInDiff(patch: string): string[] {
  const found = new Set<string>();

  for (const line of String(patch || '').split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) {
      continue;
    }

    // The leading whitespace is load bearing: without it `:class="x"` matches as the plain
    // attribute `class`, and a Vue binding's expression becomes a class selector that is in no
    // rendered document anywhere. Same fix as the pod-side copy of this in barn-provenance.
    for (const m of line.matchAll(/\s([a-zA-Z][a-zA-Z0-9-]*)="([^"]+)"/g)) {
      const [, attr, value] = m;

      if (value.includes('{') || !SELECTABLE_ATTR.test(attr)) {
        continue;
      }

      if (attr === 'class') {
        // The first class only. A long class list is mostly layout, and the compound selector
        // matches nothing the moment one of them is conditional.
        const first = value.trim().split(/\s+/)[0];

        if (first) {
          found.add(`.${ first }`);
        }
      } else if (attr === 'id') {
        found.add(`#${ value }`);
      } else {
        found.add(`[${ attr }="${ value }"]`);
      }
    }

    // A changed style rule names its own subject: `.trend-source-note { ... }` is a CSS
    // selector and a DOM selector at once, so a stylesheet-only change still points somewhere.
    const rule = /^\+\s*([.#][\w-][\w-]*(?:[\s>+~][^{]*)?)\s*\{/.exec(line);

    if (rule) {
      const first = rule[1].trim().split(/[\s>+~,]/)[0];

      if (first && first.length > 1) {
        found.add(first);
      }
    }

    if (found.size >= 6) {
      break;
    }
  }

  return [...found];
}

/**
 * Attributes worth turning into a selector. An allowlist, because `style` and every Vue
 * binding are attributes too and none of them find an element in a rendered document.
 *
 * The pod's copy is SELECTABLE in extension-skeleton/pod/barn-provenance.mjs; see the note
 * there for why there are two and what stops them drifting.
 */
const SELECTABLE_ATTR = /^(class|id|data-[\w-]+|name|role|aria-label|href|src|alt|title|type|placeholder|for)$/;

/**
 * The selectors a change set's capture recorded, read back out of the pod.
 *
 * This is the answer, and everything that used to be guessed here has gone with it. The
 * capture walks the document it is photographing and records, beside the picture, the element
 * it outlined and that element's own path. Those selectors are not derived from a patch: they
 * were resolved in a rendered page, so they name something that exists, and the live preview
 * resolves them again in the same page.
 *
 * What they replaced was a chain of readings of the source - the member a changed line sits in,
 * where that member is interpolated in a template, the nearest ancestor tag carrying a class -
 * each of which had to be right for the answer to be. A `<script setup>` component resolved
 * nothing at all; a helper the template never names resolved nothing; an unclassed element
 * resolved to whatever ancestor happened to carry a class, which is a box round something much
 * larger than what changed. None of that is recoverable from a patch, and none of it has to be:
 * the pod already looked at the page.
 */
async function recordedSelectors(name: string, commit: string): Promise<string[]> {
  const file = `/app/.shots/${ commit }-after.png.json`;
  const out = await inPackage(
    name,
    `[ -f ${ file } ] && printf %s BARN-REGIONS: && base64 -w0 ${ file } && echo ; true`,
  ).catch(() => '');
  const at = out.indexOf('BARN-REGIONS:');

  if (at === -1) {
    return [];
  }

  try {
    const parsed = JSON.parse(atob(out.slice(at + 'BARN-REGIONS:'.length).split('\n')[0].trim()));
    const regions: ShotRegion[] = Array.isArray(parsed?.regions) ? parsed.regions : [];

    return [...new Set(regions
      .map((r) => String(r.selector || ''))
      // `changed-pixels` is a region of a picture and `text:` is a string, and neither is
      // something a document can be asked for. Both are recorded by captures older than the
      // snapshot comparison; the outline over the picture still uses them.
      .filter((sel) => sel && sel !== 'changed-pixels' && !sel.startsWith('text:')))]
      .slice(0, 6);
  } catch {
    return [];
  }
}

/**
 * The newest change set's commit, or '' when nothing has been recorded.
 *
 * A one-line read, so the preview can ask for the same pictures the Changes tab is looking at
 * without pulling the whole turn list across.
 */
export async function latestChangeCommit(name: string): Promise<string> {
  const out = await inPackage(name, 'git rev-parse --verify -q HEAD 2>/dev/null').catch(() => '');

  return (/[0-9a-f]{40}/i.exec(out)?.[0] || '');
}

/**
 * Where a change set landed, as selectors the framed page can be asked about.
 *
 * The capture's own record first, because it is the only one of these two that looked at a
 * rendered page. `selectorsInDiff` stays as the fallback for a change set with no picture -
 * a pod whose browser could not be reached, or one whose capture predates the snapshot - and
 * it is honest in a narrower way: it only answers when the patch itself added a class, a test
 * id or a style rule, which names something by the exact string that put it in the document.
 */
export async function latestChangeSelectors(name: string, commit = 'HEAD'): Promise<string[]> {
  const at = /^[0-9a-f]{7,40}$/i.test(commit) ? commit : 'HEAD';

  if (at !== 'HEAD') {
    const recorded = await recordedSelectors(name, at).catch(() => []);

    if (recorded.length) {
      return recorded;
    }
  }

  const patch = await inPackage(
    name,
    `git show --unified=0 --no-color ${ shellQuote(at) } 2>/dev/null`,
  ).catch(() => '');

  return selectorsInDiff(patch);
}

/**
 * A short-lived Rancher token, for the browser that takes the pictures.
 *
 * The namespace's Chromium is shared and starts with an empty profile, so it has no session and
 * the cluster proxy answers it with "not authorized" - which is what a change set's picture was,
 * until this. This page is already authenticated, so it can mint a token rather than anybody
 * handing a password around; the TTL is minutes, and it is described so a token list says what
 * it was for rather than leaving somebody to guess.
 *
 * Returns empty rather than throwing when the token cannot be minted. A picture is evidence,
 * not a feature anything depends on, and the screen says why there is none.
 */
async function captureToken(): Promise<string> {
  const made = await rancherFetch('/v3/tokens', {
    method: 'POST',
    body:   JSON.stringify({
      type:        'token',
      description: 'barn: change-set screenshot',
      ttl:         10 * 60 * 1000,
    }),
  }).catch(() => null);

  return made?.token || '';
}

/**
 * A before/after picture of one change set, taken in the pod that made it.
 *
 * The pod drives the namespace's Chromium itself (see the barn-screenshot skill it is given),
 * so this is one exec that returns a data URL rather than a pipeline this side has to run. The
 * picture is written into the pod first and read back base64, because the skill's output is a
 * file and a screenshot is too big to come back on a command line.
 *
 * Before is the build installed in this Rancher and After is the pod's dev server, which is the
 * same reading the change screen's Before/After panels already use: the installed build is the
 * only unchanged rendering of this extension that exists anywhere. An extension nothing has
 * published has no Before, and this says so rather than shooting the same page twice and
 * captioning one of them "before".
 *
 * Cached by commit in the pod: a change set does not change once it is committed, so the second
 * ask for the same one is a read rather than two page loads.
 */
/** One outlined thing in a picture, in that picture's own pixels. */
export interface ShotRegion {
  /** This element's own path in the document that was photographed. */
  selector: string;
  /**
   * The pattern the capture was asked for, when it is not the same thing.
   *
   * A mark out of a patch can be a class that matches six elements, or a `text:` string that
   * is not CSS at all. `selector` is what that resolved to; this is what was asked.
   */
  match?:   string;
  label:    string;
  x:        number;
  y:        number;
  width:    number;
  height:   number;
}

export interface ChangeShot {
  /** The page as it was when the prompt arrived. `data:image/png;base64,...`, or empty. */
  before:  string;
  /** The page after the turn committed, with what the commit named outlined on it. */
  after:   string;
  /**
   * Where the outlines are in `after`, so they can be pointed at.
   *
   * The picture knows which of its pixels are the change and a PNG cannot say so; these are how
   * it says so. Empty for a change set whose capture predates them, which is a picture that
   * cannot be clicked rather than one that is wrong.
   */
  regions: ShotRegion[];
  /**
   * How those regions were measured. 0 for anything recorded before the capture stopped adding
   * the header's height to every box, which is every change set photographed up to that point:
   * their rectangles sit a header's height below what they name, and the pane re-measures from
   * the two pictures rather than trusting them.
   */
  geometry: number;
  /** The size `after` was captured at, which is what the regions are measured against. */
  width:   number;
  height:  number;
  /** Why a picture is missing, when one is. Never a guess. */
  why:     string;
}

/**
 * A change set's two pictures, as two pictures.
 *
 * They are returned separately rather than composed into one image because they are shown one
 * after the other in a column, and a joined image would be a fixed side-by-side layout baked
 * into a PNG - unreadable at half the width, and impossible to lay out any other way later.
 *
 * Both come from the pod's hooks: the before was taken as the prompt arrived, which is the only
 * moment the old rendering exists, and the after once the turn committed. Nothing here
 * re-renders anything, which is what makes the before true.
 *
 * A change set from before the hooks existed has neither, and says so. A live shot is taken in
 * that case so the tab is not empty, and it is offered as the after with the before left blank -
 * never as a pair, because a copy of the after wearing a "before" label is worse than nothing.
 */
export async function changeSetShot(
  name: string, commit: string, route: string, highlights: string[] = []
): Promise<ChangeShot> {
  const id = /^[0-9a-f]{7,40}$/i.test(commit) ? commit : '';

  if (!id) {
    return {
      before: '', after: '', regions: [], geometry: 0, width: 0, height: 0,
      why:    `${ commit || 'that change set' } is not a commit this can shoot`,
    };
  }

  const before = `/app/.shots/${ id }-before.png`;
  const after = `/app/.shots/${ id }-after.png`;

  // Both, in one exec, each behind a marker so a missing one is silence rather than a
  // truncated image. base64 because a screenshot does not survive a command line otherwise.
  // printf rather than echo for the markers: echo ends the line, which puts the image on the
  // next one and left the reader below taking the empty remainder of the marker's own line.
  // Marker and data on one line, one line per image.
  const recorded = await inPackage(name, [
    `[ -f ${ before } ] && printf %s BARN-BEFORE: && base64 -w0 ${ before } && echo ;`,
    `[ -f ${ after } ] && printf %s BARN-AFTER: && base64 -w0 ${ after } && echo ;`,
    `[ -f ${ after }.json ] && printf %s BARN-REGIONS: && base64 -w0 ${ after }.json && echo ;`,
    'true',
  ].join(' ')).catch(() => '');

  const read = (marker: string): string => {
    const at = recorded.indexOf(marker);

    if (at === -1) {
      return '';
    }

    const data = recorded.slice(at + marker.length).split('\n')[0].trim();

    return data ? `data:image/png;base64,${ data }` : '';
  };

  // The sidecar the capture wrote: where each outline landed, and the size it was measured
  // against. Bad JSON is treated as no regions - a picture that cannot be clicked, rather than
  // hotspots in the wrong places, which would be worse than none.
  const readRegions = (blob: string): { regions: ShotRegion[]; width: number; height: number; geometry: number } => {
    const at = blob.indexOf('BARN-REGIONS:');

    if (at === -1) {
      return {
        regions: [], width: 0, height: 0, geometry: 0,
      };
    }

    try {
      const raw = blob.slice(at + 'BARN-REGIONS:'.length).split('\n')[0].trim();
      const parsed = JSON.parse(atob(raw));

      return {
        regions:  Array.isArray(parsed?.regions) ? parsed.regions : [],
        width:    Number(parsed?.width) || 0,
        height:   Number(parsed?.height) || 0,
        // Absent on everything written before the capture learned to measure with the header's
        // space in place. See GEOMETRY_VERSION in the barn-screenshot skill.
        geometry: Number(parsed?.v) || 0,
      };
    } catch {
      return {
        regions: [], width: 0, height: 0, geometry: 0,
      };
    }
  };

  const shotBefore = read('BARN-BEFORE:');
  const shotAfter = read('BARN-AFTER:');
  const marked = readRegions(recorded);

  if (shotBefore && shotAfter) {
    return {
      before:  shotBefore,
      after:   shotAfter,
      regions:  marked.regions,
      geometry: marked.geometry,
      width:    marked.width,
      height:   marked.height,
      why:     '',
    };
  }

  // Nothing recorded. Take one now so the tab shows something, and be explicit that it is the
  // page as it stands rather than half of a pair.
  const slug = (route || '/').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') || 'root';
  const out = `/app/.shots/${ id }-${ slug }.png`;
  const session = await captureToken().catch(() => '');
  const patch = highlights.length
    ? ''
    : await inPackage(name, `git show --unified=0 --no-color ${ id } 2>/dev/null`).catch(() => '');
  const marks = highlights.length ? highlights : selectorsInDiff(patch);
  const notes = marks.map((sel) => `--note ${ shellQuote(`${ sel }=changed here`) }`).join(' ');

  // The skill is refreshed out of /seed first, and its stderr is kept.
  //
  // Both because a picture that does not arrive used to be indistinguishable from a browser
  // that could not be reached. The copy under $HOME is made when a terminal tab opens, so a
  // pod whose assistant session has been up for days runs whatever the skill was then - a
  // corrected capture would sit in /seed unused, which is how a fixed script went on producing
  // nothing. And `2>&1` into a file rather than /dev/null means the reason the script gave is
  // the reason this reports, instead of a sentence guessing at two possible causes.
  const log = `${ out }.err`;
  const seeded = '/seed/skills__barn-screenshot__screenshot.mjs';

  const answer = await inPackage(name, [
    `if [ ! -f ${ out } ] ; then`,
    `mkdir -p "$HOME/.claude/skills/barn-screenshot" ;`,
    `[ -f ${ seeded } ] && cp ${ seeded } "$HOME/.claude/skills/barn-screenshot/screenshot.mjs" ;`,
    `node "$HOME/.claude/skills/barn-screenshot/screenshot.mjs"`,
    `--path ${ shellQuote(route || '/') } ${ notes }`,
    // The shared browser has a profile of its own and no Rancher session in it, so without this
    // every picture is the proxy's "not authorized" page. The token expires by itself; the pod
    // is never told a password.
    session ? `--token ${ shellQuote(session) }` : '',
    `--output ${ out } >${ log } 2>&1 || true ; fi ;`,
    `[ -f ${ out } ] && echo BARN-SHOT: && base64 -w0 ${ out } && echo ;`,
    `[ ! -f ${ out } ] && [ -f ${ log } ] && printf %s BARN-SHOT-ERR: && tail -c 600 ${ log } ;`,
    'true',
  ].filter(Boolean).join(' ')).catch((e) => `ERR:${ e?.message || e }`);

  if (answer.startsWith('ERR:')) {
    return {
      before: '', after: '', regions: [], geometry: 0, width: 0, height: 0, why: answer.slice(4).trim(),
    };
  }

  const at = answer.indexOf('BARN-SHOT:');
  const live = at === -1 ? '' : answer.slice(at + 'BARN-SHOT:'.length).split('\n')[0].trim();

  if (!live) {
    const failedAt = answer.indexOf('BARN-SHOT-ERR:');
    const said = failedAt === -1 ? '' : answer.slice(failedAt + 'BARN-SHOT-ERR:'.length).trim();

    return {
      before:   '',
      after:    '',
      regions:  [],
      geometry: 0,
      width:    0,
      height:   0,
      why:      said
        ? `The pod could not take this picture. It said: ${ said }`
        : 'The pod took no picture and said nothing about why, which usually means its browser could not be reached at all.',
    };
  }

  return {
    before:   '',
    after:    `data:image/png;base64,${ live }`,
    regions:  [],
    geometry: 0,
    width:    0,
    height:   0,
    why:      shotAfter || shotBefore
      ? 'only one of the pair was recorded for this change set'
      : 'this change set was committed before the pod started taking pictures, so there is no Before for it - this is the page as it stands now',
  };
}

/**
 * Write a binary file into an extension's pod.
 *
 * For images pasted into the terminal. Base64 all the way in, because the payload is binary and
 * everything between here and the file is a shell: the exec subresource takes argv, the argv is
 * a `sh -c` script, and a PNG put through that directly would be mangled by the first byte that
 * looked like a quote.
 *
 * Chunked, because a screenshot is a megabyte or two and the whole command is a URL query
 * parameter on the exec websocket. There is no documented ceiling on that and the ones that
 * exist are in whatever proxies the request, so this appends in pieces small enough that none
 * of them is anywhere near a limit rather than finding out where the limit is in production.
 */
// How much base64 goes into one exec.
//
// It was 48KB, and that could not work: `execUrl` puts every argument in the URL's *query
// string*, so a chunk that size makes a request line tens of kilobytes long. Servers cap that
// and drop it, silently - the exec came back fine, the append wrote nothing, and the file ended
// up 0 bytes with "the image did not land" as the only clue. Attaching an image has therefore
// never worked, by paste, paperclip or otherwise; it was just never exercised with a payload
// big enough to notice.
//
// 4KB keeps the whole request line comfortably under the usual 8KB limit with the setpriv
// wrapper and the path still to fit. The cost is round trips - one per 4KB - which is why a
// large attachment is slow, and why MAX_ATTACHMENT being 8MB is a promise this transport cannot
// really keep.
const IMAGE_CHUNK = 4 * 1024;

export async function writePodImage(name: string, path: string, data: ArrayBuffer): Promise<void> {
  const pod = await extensionPod(name);

  if (!pod) {
    throw new Error(`${ name } has no running pod to write to`);
  }

  const bytes = new Uint8Array(data);
  let binary = '';

  // A chunk at a time rather than String.fromCharCode(...bytes), which blows the argument limit
  // and throws on anything the size of a screenshot.
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }

  const encoded = btoa(binary);
  const quoted = shellQuote(path);
  const stage = `${ quoted }.b64`;

  await podExecOnce(pod, asPodUser(`mkdir -p "$(dirname ${ quoted })" && : > ${ stage }`));

  for (let i = 0; i < encoded.length; i += IMAGE_CHUNK) {
    const chunk = encoded.slice(i, i + IMAGE_CHUNK);

    // printf %s rather than echo: the payload is base64, which cannot contain a quote or a
    // backslash, so this is safe, and echo would interpret escapes on some shells.
    await podExecOnce(pod, asPodUser(`printf %s '${ chunk }' >> ${ stage }`));
  }

  const out = await podExecOnce(pod, asPodUser(
    `base64 -d ${ stage } > ${ quoted } && rm -f ${ stage } && wc -c < ${ quoted }`
  ));

  if (!parseInt(out.trim(), 10)) {
    throw new Error(`the image did not land in ${ name }`);
  }
}

/** Single-quote for `sh`, the only form that needs no other escaping inside it. */
function shellQuote(value: string): string {
  return `'${ value.split("'").join(`'\\''`) }'`;
}

// ---------------------------------------------------------------------------
// Publishing: from the pod's working tree to an extension Rancher has installed.
//
// Rancher loads UI extensions from the index it serves at /v1/uiplugins, which is built from
// the UIPlugin resources in cattle-ui-plugin-system. An entry whose metadata says
// `direct: "true"` is loaded by the browser straight from its `endpoint`, as a script tag -
// that is the mechanism behind Developer Load, and it is the whole of what publishing needs
// here.
//
// So: build in the pod, put the bundle where the pod's dev server already serves static files,
// and point a UIPlugin at it through the apiserver's service proxy. The browser fetches it on
// Rancher's own origin, carrying the session it already has, and there is nothing to
// authenticate and nothing to host.
//
// What this deliberately does not do is add a Helm repository. That is the other route - a
// chart in a repo, a ClusterRepo pointing at it, the plugin operator downloading and serving
// the contents - and every part of it is machinery this does not need: Rancher would have to
// reach the pod server-side, the operator would have to be installed, and the result is the
// same extension loaded from the same pod. The trade is real and worth knowing: an extension
// published this way lives exactly as long as the pod serving it does. It is a dev loop, not a
// release.
// ---------------------------------------------------------------------------

/** Where Rancher keeps the resources behind its /v1/uiplugins index. */
const PLUGIN_NS = 'cattle-ui-plugin-system';

/** Under /app/public, which the pod's dev server serves at the root of the proxy path. */
const PUBLISHED_DIR = 'plugins';

/**
 * The package's name, version and Rancher annotations, read out of the tree rather than assumed.
 *
 * By reading the file and parsing it here rather than by running `node -p` in the pod. The node
 * version worked when it was pasted into a shell and returned nothing at all through the exec
 * websocket, and chasing that is time spent on a quoting problem that did not need to exist:
 * the command had a JavaScript expression inside double quotes inside a single-quoted `sh -c`
 * inside a query parameter. `cat` has none of those layers, and the browser can parse JSON.
 *
 * The annotations matter as much as the name. Rancher's dashboard refuses to load an extension
 * whose entry carries no `catalog.cattle.io/ui-extensions-version`, and says so only as
 * `plugins.error.apiAnnotationMissing` in a store nobody is looking at, so the symptom is an
 * extension that installs cleanly, reports Ready, and never appears. A published chart carries
 * these across from package.json; this does the same thing by hand.
 */
interface PackageIdentity {
  name: string;
  version: string;
  annotations: Record<string, string>;
}

async function packageIdentity(name: string): Promise<PackageIdentity> {
  const raw = await readExtensionFile(name, 'package.json');

  try {
    const parsed = JSON.parse(raw);

    return {
      name:        parsed.name,
      version:     parsed.version,
      annotations: parsed.rancher?.annotations || {},
    };
  } catch {
    throw new Error(`could not read the package.json of ${ name }: ${ raw.trim() || 'no output' }`);
  }
}

export interface PublishResult {
  plugin: string;
  version: string;
  url: string;
  log: string;
}

/**
 * The steps a publish goes through, in order, so the page can say which one it is on.
 *
 * Named here rather than in the page because the page cannot know: only this file knows that
 * "building" and "copying it where the dev server can serve it" are two separate things, and a
 * bar that counted them differently from the code that runs them would be a bar that lies.
 */
// ---------------------------------------------------------------------------
// What the editor is configured with.
// ---------------------------------------------------------------------------

/**
 * One Secret in the extensions' own namespace, holding what the editor needs and does not
 * generate: today a GitHub token and the repository it belongs to.
 *
 * A Secret rather than localStorage, and not because a token is dramatic. It is that the
 * thing which eventually uses it is a pod: publishing runs in the extension's own container,
 * so a credential kept in one person's browser is a credential the build cannot reach.
 *
 * THE TOKEN IS WRITE-ONLY, AND IT IS THE PAGE THAT MAKES IT SO. Four surfaces say the token
 * never comes back into the browser, and until this it was not true: `readSettings` and the
 * old `readToken` both did a plain GET of this Secret, so the credential arrived in a response
 * body in the page - three times in one page load, by one verifier's count - on its way into a
 * pod command. Two changes make the claim true, and both have to hold for either to be worth
 * anything:
 *
 *   - Nothing in this file ever GETs the Secret's `data` again. Reads ask the apiserver for
 *     `PartialObjectMetadata`, which answers with metadata and no data at all, and writes are
 *     merge patches, which send a value without needing the object back first.
 *   - The pod reads the token itself, with its own service account, which is what the design
 *     intended and what the settings page already tells people is happening ("The question is
 *     put from an extension pod, which is what can read the Secret"). `EXT_ACCOUNT` is bound to
 *     cluster-admin, so it can, and `GITHUB_SCRIPT` below is the only thing that does.
 *
 * Which moves two facts out of `data`, where they can no longer be read from here, and into
 * annotations, where they can:
 *
 *   - whether a token is stored at all, which a settings form needs and which is not itself a
 *     credential;
 *   - the repository, which was never a secret and only lived in here because the token did.
 */
export const SETTINGS_SECRET = 'barn-settings';

/** The key names are the Secret's, so `kubectl get secret barn-settings -o yaml` reads plainly. */
export const TOKEN_KEY = 'gh_token';

/**
 * Set to `set` when a token is stored, removed when it is cleared.
 *
 * An annotation rather than a probe of `data`, because the whole point is that nothing here
 * fetches `data`. It says only that there is one, which is all a form needs to decide between
 * "Connect" and "Replace".
 */
const TOKEN_ANNOTATION = 'barn.rancher.io/gh-token';

/**
 * The repository is per extension; the token is not.
 *
 * A token is an account's, and the account is the person using this - one of them, reused by
 * everything they publish. A repository is the extension's own: two extensions in here are two
 * separate things that belong in two separate repositories, and a single setting would mean
 * publishing one of them over the other. Which has to be a setting rather than a convention
 * because the name in the pod and the name of a repository agree only by luck.
 *
 * An annotation name may hold `[-._a-zA-Z0-9]` and may not end in one of the punctuation
 * characters, and an extension's name is normalised into that same alphabet before it ever
 * names an object (see normalizeExtensionName), so this cannot produce a name Kubernetes will
 * reject. The empty extension - which is how a caller asks the token-only question - gets no
 * annotation at all, because `barn.rancher.io/repo.` is exactly the name that would be
 * rejected.
 */
export function repoAnnotation(extension: string): string {
  return extension ? `barn.rancher.io/repo.${ extension }` : '';
}

/**
 * Where the repository used to live: a key in the Secret's `data`.
 *
 * Still exported because it still names a real thing - a Secret written before the token became
 * write-only has its repositories in here - and because `kubectl get secret barn-settings` is
 * how somebody would find them. Nothing reads it any more: reading it would mean fetching
 * `data`, which is the thing that was leaking the token.
 */
export function repoKey(extension: string): string {
  return `gh_repo.${ extension }`;
}

export interface EditorSettings {
  /**
   * Whether a token is stored - never the token itself.
   *
   * A credential that has been saved does not come back out to a page. What a settings form
   * needs to know is whether the field is already filled, which this answers, and the field
   * then says "leave blank to keep" rather than showing a value somebody could shoulder-read.
   */
  hasToken: boolean;
  /** `owner/name`. Not a secret, so it comes back as typed and the field can show it. */
  repo: string;
  /**
   * True when this extension's repository is still in the old storage and cannot be read back.
   *
   * The repository used to be a key in the Secret's `data`, and `data` is the thing nothing
   * fetches any more. Rather than guess, or fetch it and undo the point of the change, the
   * fact is reported: a form seeing this says the repository has to be entered once more, and
   * saving it writes it to the annotation where it is readable from now on. Absent, rather
   * than false, on the overwhelmingly common path where there is nothing old to find.
   */
  legacyRepo?: boolean;
}

/** UTF-8 safe, because btoa alone throws on anything outside latin-1 and a repo name can be. */
function encodeSecret(value: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)));
}

/** The Secret on the raw Kubernetes API rather than on Steve, which is where the two verbs below need it. */
const SETTINGS_PATH = `${ EXT_BASE }/api/v1/namespaces/${ EXT_NS }/secrets/${ SETTINGS_SECRET }`;

/**
 * Ask for metadata and nothing else.
 *
 * `PartialObjectMetadata` is a content negotiation the apiserver does on any object: ask for it
 * and the response carries `metadata` with no `data` and no `stringData`, which is the only way
 * to read anything about a Secret from a browser without the browser receiving the Secret.
 *
 * On the writes as much as on the read, and that is not belt and braces. A `PATCH` answers with
 * the whole updated object by default, so a save that only sent a token got the token back in
 * the response - which is the same leak in the other direction, and the first version of this
 * change had it. It has to go to `/api/v1/...` rather than to Steve's `/v1/secrets/...`,
 * because Steve answers in its own shape and ignores this header: it was asked, and it returned
 * the whole object.
 */
const METADATA_ONLY = { Accept: 'application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1' };

/** The Secret's metadata, or null when it is not there yet - which is "nothing is configured". */
async function settingsMetadata(): Promise<any> {
  const answer = await rancherFetch(SETTINGS_PATH, { headers: METADATA_ONLY }).catch(() => null);

  return answer?.metadata || null;
}

/**
 * Which keys the Secret's `data` holds, without reading any of their values.
 *
 * From `managedFields`, which every object carries and which records the shape of what each
 * writer set - `f:data: { f:gh_token: {} }` for a token written by anybody. It is used for one
 * thing only: recognising a Secret written before the annotations existed, so a token stored by
 * the previous version still reports as stored and an old repository is reported as needing to
 * be re-entered rather than silently disappearing.
 */
function managedDataKeys(metadata: any): string[] {
  const keys = new Set<string>();

  (metadata?.managedFields || []).forEach((entry: any) => {
    Object.keys(entry?.fieldsV1?.['f:data'] || {}).forEach((field) => {
      if (field.startsWith('f:')) {
        keys.add(field.slice(2));
      }
    });
  });

  return [...keys];
}

/**
 * What is configured for one extension. Absent, unreadable and empty Secret are all "nothing yet".
 *
 * The token half of the answer is the same whichever extension asks; the repository half is
 * that extension's own.
 */
export async function readSettings(extension: string): Promise<EditorSettings> {
  const metadata = await settingsMetadata();
  const annotations = metadata?.annotations || {};
  const legacyKeys = managedDataKeys(metadata);
  const annotation = repoAnnotation(extension);
  const repo = annotation ? annotations[annotation] || '' : '';

  return {
    hasToken: annotations[TOKEN_ANNOTATION] === 'set' || legacyKeys.includes(TOKEN_KEY),
    repo,
    legacyRepo: !repo && !!extension && legacyKeys.includes(repoKey(extension)),
  };
}

/**
 * Write only the keys that were touched.
 *
 * A field the form left `undefined` is not in `changes` and is not written, which is what stops
 * opening settings and saving from blanking a token nobody could see. `''` is a deliberate
 * clear, and is the only way to remove one.
 *
 * A merge patch rather than the read-modify-PUT this used to do. The read half of that cycle
 * fetched the whole Secret in order to preserve the keys it was not touching, which meant every
 * save also pulled the token into the page - so the write was leaking the credential just as
 * surely as the read was. A patch says what changed and nothing else, `null` deletes a key, and
 * neither needs the object back first.
 */
export async function saveSettings(extension: string, changes: { token?: string; repo?: string }): Promise<void> {
  const data: Record<string, string | null> = {};
  const annotations: Record<string, string | null> = {};

  if (changes.token !== undefined) {
    data[TOKEN_KEY] = changes.token === '' ? null : encodeSecret(changes.token);
    annotations[TOKEN_ANNOTATION] = changes.token === '' ? null : 'set';
  }

  const annotation = repoAnnotation(extension);

  if (changes.repo !== undefined && annotation) {
    annotations[annotation] = changes.repo === '' ? null : changes.repo;
    // The old home for the same fact, cleared as it is superseded. Blind, because reading it is
    // what this change exists to stop; deleting a key that was never there is a no-op.
    data[repoKey(extension)] = null;
  }

  if (!Object.keys(data).length && !Object.keys(annotations).length) {
    return;
  }

  await ensureShared();

  const patch = () => rancherFetch(SETTINGS_PATH, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/merge-patch+json', ...METADATA_ONLY },
    body:    JSON.stringify({ metadata: { annotations }, data }),
  });

  try {
    await patch();
  } catch (e: any) {
    // A patch cannot create, so the first save on a fresh cluster lands here. Create the empty
    // Secret and patch it, rather than POSTing the values, so there is exactly one code path
    // that writes them.
    if (!/404|not ?found/i.test(e?.message || '')) {
      throw e;
    }

    await rancherFetch(`${ EXT_BASE }/api/v1/namespaces/${ EXT_NS }/secrets`, {
      method:  'POST',
      headers: METADATA_ONLY,
      body:    JSON.stringify({
        apiVersion: 'v1',
        kind:       'Secret',
        type:       'Opaque',
        metadata:   { namespace: EXT_NS, name: SETTINGS_SECRET },
      }),
    }).catch((created: any) => {
      // Two tabs saving at once: the other one made it, which is the outcome both wanted.
      if (!/409|already exists|alreadyexists/i.test(created?.message || '')) {
        throw created;
      }
    });

    await patch();
  }
}

export const PUBLISH_STAGES = [
  'Reading the package',
  'Building the extension',
  'Serving it from the pod',
  'Installing it into Rancher',
];

export type PublishProgress = (stage: number, label: string, total: number) => void;

/** Thrown with the output attached, because a build failure is only diagnosable from its log. */
export class PublishError extends Error {
  log: string;
  stage: string;

  constructor(message: string, stage: string, log: string) {
    super(message);
    this.name = 'PublishError';
    this.stage = stage;
    this.log = log;
  }
}

/**
 * Build the extension in its own pod and install it into this Rancher.
 *
 * The build is `build-pkg`, run in the pod, and it takes minutes: it is a production build of
 * the package against the shell. It is one exec that stays open for the duration rather than
 * something polled, because the output is the only diagnostic there is when it fails.
 *
 * THIS PATH IS DELIBERATELY UNGATED AND MUST STAY THAT WAY. It is dev preview and developer
 * load: it reaches exactly the cluster you are standing in, and cross-screen rule 2 says that
 * everything before the distribution boundary asks nobody - "creating, building, previewing,
 * breaking, rebuilding, developer-loading and reviewing your own diff must never require
 * anyone's approval". The gate lives on `distributeExtension`, which is the point at which the
 * extension becomes installable by other people. Do not add `assertGateOpen` here. Rule 2 is
 * as load bearing as rule 1 and is much easier to break by accident.
 */
export async function publishExtension(name: string, onProgress?: PublishProgress): Promise<PublishResult> {
  const total = PUBLISH_STAGES.length;
  const report = (stage: number) => onProgress?.(stage, PUBLISH_STAGES[stage - 1], total);
  const pod = await extensionPod(name);

  if (!pod) {
    throw new PublishError(`${ name } has no running pod to build in`, PUBLISH_STAGES[0], '');
  }

  // Before anything is built.
  //
  // Publishing is the one action here that leaves the pod, so it is the one that has to be
  // reviewed first. Checked in this function rather than only on the button, because the
  // button is not the only caller: the publish dialog, the GitHub flow and anything added
  // later all come through here, and a gate that lives in a component is a gate with a way
  // around it.
  // Fails closed: a gate that cannot read the queue does not open it.
  const approval = await approvalState(name).catch(() => ({
    sha: '', pending: [], clear: false, read: false,
  }));

  if (!approval.clear) {
    const n = approval.pending.length;

    throw new PublishError(
      approval.read
        ? `${ n } change set${ n === 1 ? '' : 's' } ${ n === 1 ? 'has' : 'have' } not been reviewed yet. Approve ${ n === 1 ? 'it' : 'them' } on the Changes tab, or reject ${ n === 1 ? 'it' : 'them' }, and publish again.`
        : 'This could not read what has been reviewed, so it will not publish. Open the Changes tab and see whether it can.',
      PUBLISH_STAGES[0],
      '',
    );
  }

  report(1);

  const { name: plugin, version, annotations } = await packageIdentity(name);
  const built = `${ plugin }-${ version }`;

  report(2);

  // `2>&1` because build-pkg says everything useful on stderr, and this exec reads only stdout.
  const log = await podExecOnce(pod, asPodUser(
    `cd /app && ./node_modules/@rancher/shell/scripts/build-pkg.sh ${ plugin } 2>&1`
  ));

  const bundle = `dist-pkg/${ built }/${ built }.umd.min.js`;
  const builtOk = await podExecOnce(pod, asPodUser(`test -f /app/${ bundle } && echo yes`));

  if (!builtOk.includes('yes')) {
    throw new PublishError(`${ plugin } did not build`, PUBLISH_STAGES[1], log);
  }

  report(3);

  // /app/public is what the dev server serves at the root of the proxy path, so a copy in there
  // is reachable at a URL on Rancher's own origin without anything else being started.
  const copyLog = await podExecOnce(pod, asPodUser([
    'cd /app',
    `mkdir -p public/${ PUBLISHED_DIR }`,
    `rm -rf public/${ PUBLISHED_DIR }/${ built }`,
    `cp -r dist-pkg/${ built } public/${ PUBLISHED_DIR }/${ built }`,
    'echo BARN-COPY-OK',
  ].join(' && ')));

  if (!copyLog.includes('BARN-COPY-OK')) {
    throw new PublishError('the built bundle could not be copied where the pod serves it', PUBLISH_STAGES[2], `${ log }\n${ copyLog }`);
  }

  report(4);

  // Cache-busting on the URL rather than trust in noCache. The browser has almost certainly
  // loaded this exact path before, and a republish that serves the previous bundle is the
  // failure this whole button exists to avoid. The stamp is the pod's own clock, which is the
  // only clock that knows when the build happened.
  const stamp = (await podExecOnce(pod, asPodUser('date +%s'))).trim();
  const url = `${ extensionProxyPath(name) }/${ PUBLISHED_DIR }/${ built }/${ built }.umd.min.js?t=${ stamp }`;

  try {
    await upsertUiPlugin(plugin, version, url, annotations);
  } catch (e: any) {
    throw new PublishError(e?.message || String(e), PUBLISH_STAGES[3], log);
  }

  // After the UIPlugin and not before: the baseline records what this Rancher is loading, so
  // it must not move for a build that never got installed. Best effort - see recordBaseline.
  //
  // What it records is the source tree that was built, which is not the bundle. The bundle is
  // in /app/public and dies with the node, so what this offers a screen is a rebuild from a
  // recorded tree, and no screen may call it a rollback to the running artifact.
  const baseline = await recordBaseline(name, BASELINE_LOCAL_REF, `Published ${ plugin } ${ version } into this Rancher`);
  // The way back, recorded at the only moment anything can know this tree works: it has just
  // been built and installed. See WORKING_BUILD_REF.
  const working = await recordBaseline(name, WORKING_BUILD_REF, `Working build ${ plugin } ${ version }`);

  // Said rather than swallowed. The publish stands - the bundle is installed and this Rancher
  // is loading it - but a baseline that was not written means every diff screen goes on
  // measuring from the previous point, and the person who just published is the only one in a
  // position to notice.
  const note = [
    baseline.error
      ? `\n[barn] the publish worked, but the baseline ref could not be written, so the review screens will still measure from the previous point: ${ baseline.error }`
      : '',
    working.error
      ? `\n[barn] the publish worked, but the working-build ref could not be written, so a later failure will not have this build to roll back to: ${ working.error }`
      : '',
  ].join('');

  return {
    plugin, version, url, log: `${ log }${ note }`
  };
}


export const GITHUB_PUBLISH_STAGES = [
  'Reading the settings',
  'Reading the package',
  'Committing the package',
  'Pushing to GitHub',
];

/**
 * Push the extension's own source to the repository configured in settings, on a named branch.
 *
 * The other Publish builds a bundle and points this Rancher at it, which reaches exactly the
 * cluster you are standing in. This one is the other half: the package is already a git
 * repository in the pod (see ensureExtensionRepo), so publishing it is adding a remote and
 * pushing, and what comes out is a repository somebody else can build from.
 *
 * It pushes source rather than a built bundle deliberately. A chart repository is built by the
 * receiving repository's own workflow from a tagged version - that is how barn itself is
 * published - and a bundle committed by hand would be the same artifact with no provenance.
 *
 * THE BRANCH IS NOW REQUIRED, and that is the gate. This used to push `HEAD:refs/heads/main`
 * with no argument and no question asked, which made it an ungated distribution: one press and
 * the change was on the branch everybody else builds from, with no review, no packet and no
 * PR. Cross-screen rule 1 says there is exactly one hard gate and it is the point at which the
 * extension becomes installable by other people, so this function no longer chooses where to
 * push. Two callers do, both in review.ts:
 *
 *   handOverForReview()   pushes the packet's own branch and opens the PR. Entering the gate.
 *   distributeExtension() pushes the default branch, after assertGateOpen(). Leaving it.
 *
 * Called with no branch it refuses and says which of those to use, rather than defaulting back
 * to the behaviour the gate exists to prevent.
 *
 * `source` is what gets pushed and defaults to `HEAD`. Both gate callers pass the packet's own
 * commit instead, because a packet is a fixed object: what is reviewed and what is distributed
 * have to be the same commit, and pushing HEAD would push whatever the tip happens to be by
 * the time the button was pressed.
 *
 * The token never reaches this page at all: the pod reads it out of the Secret with its own
 * service account, and hands it to git through the environment. The log is scrubbed of
 * anything token-shaped on the way back, which is belt and braces rather than the guard - the
 * log is shown in the UI when a publish fails, which is the wrong place to discover that
 * nothing puts the credential in a command's text after all.
 *
 * The repository is asked for at the point of publishing rather than configured beforehand,
 * because it is a decision about this push and not a property of the extension. It is
 * remembered afterwards so the next one only has to be agreed with, which is the difference
 * between a cache and a setting: the answer is kept, but the question is still asked.
 */
export async function publishExtensionToGithub(
  name: string, repo: string, onProgress?: PublishProgress, branch?: string, source = 'HEAD'
): Promise<GithubPublishResult> {
  const total = GITHUB_PUBLISH_STAGES.length;
  const report = (stage: number) => onProgress?.(stage, GITHUB_PUBLISH_STAGES[stage - 1], total);

  report(1);

  if (!repo) {
    throw new PublishError('No repository was given.', GITHUB_PUBLISH_STAGES[0], '');
  }

  // Whether one is stored, not what it is. The push below reads the credential in the pod; this
  // is here so a publish with nothing configured is refused before it writes a commit, and says
  // the one thing the person can act on.
  if (!(await readSettings('')).hasToken) {
    throw new PublishError('No GitHub token is configured. Add one in the editor settings.', GITHUB_PUBLISH_STAGES[0], '');
  }

  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new PublishError(`"${ repo }" is not owner/name`, GITHUB_PUBLISH_STAGES[0], '');
  }

  // The same gate as the local publish, for the same reason and more so: this one leaves the
  // machine, not just the pod.
  // Fails closed: a gate that cannot read the queue does not open it.
  const approval = await approvalState(name).catch(() => ({
    sha: '', pending: [], clear: false, read: false,
  }));

  if (!approval.clear) {
    const n = approval.pending.length;

    throw new PublishError(
      `${ n } change set${ n === 1 ? '' : 's' } ${ n === 1 ? 'has' : 'have' } not been reviewed yet. Approve ${ n === 1 ? 'it' : 'them' } on the Changes tab before handing this over.`,
      GITHUB_PUBLISH_STAGES[0],
      '',
    );
  }

  if (!branch) {
    throw new PublishError(
      'A push has to say which branch it is going to. Handing a change over for review is handOverForReview(); putting a reviewed change on the default branch is distributeExtension(), which will not run until both sign-offs are in.',
      GITHUB_PUBLISH_STAGES[0],
      ''
    );
  }

  if (!/^[\w./-]+$/.test(branch)) {
    throw new PublishError(`"${ branch }" is not a branch name`, GITHUB_PUBLISH_STAGES[0], '');
  }

  // Remembered before the push rather than after it. A push that fails is the one most likely
  // to be tried again, and retyping the repository to do so is the annoyance this avoids.
  await saveSettings(name, { repo }).catch(() => null);

  const pod = await extensionPod(name);

  if (!pod) {
    throw new PublishError(`${ name } has no running pod to push from`, GITHUB_PUBLISH_STAGES[0], '');
  }

  report(2);

  const { name: plugin, version } = await packageIdentity(name);

  const remote = `https://github.com/${ repo }.git`;

  // A repository to push, which for a pod that has never had one is one `git init`.
  await ensureExtensionRepo(name);

  report(3);

  // Only when the push is of the tip. A push of a packet is a push of a fixed commit that was
  // assembled earlier, and sweeping the working tree into a new commit on the way past would
  // send something nobody reviewed - or, worse, quietly change what the packet's branch means
  // after somebody had already signed it off.
  if (source === 'HEAD') {
    const commitLog = await inPackage(name, [
      'git add -A',
      // Nothing to commit is not a failure: the push below is still worth making, because the
      // last one may have been what failed.
      `git diff --cached --quiet || git -c user.email=barn@rancher.local -c user.name=barn commit -q -m ${ shellQuote(`${ plugin } ${ version }`) }`,
      'echo BARN-COMMIT-OK',
    ].join(' ; '));

    if (!commitLog.includes('BARN-COMMIT-OK')) {
      throw new PublishError('the package could not be committed', GITHUB_PUBLISH_STAGES[2], scrubTokens(commitLog));
    }
  }

  report(4);

  // The same basic auth GitHub Actions uses for a token: the header rather than the URL, so it
  // is not written into .git/config where the next person to open a terminal would find it.
  //
  // Read in the pod and passed to git through the environment. Two things follow. The browser
  // never holds the credential, which is what makes the "write-only" the settings page states
  // true; and it is not in any command's arguments either, so a `ps` in the pod during a push
  // finds the remote and nothing else.
  const pushLog = await inPackage(name, [
    readTokenSh(),
    'BARN_GH_HEADER="AUTHORIZATION: basic $(printf %s "x-access-token:$BARN_GH_TOKEN" | base64 -w0)"',
    'export BARN_GH_HEADER',
    `git --config-env=http.extraheader=BARN_GH_HEADER push ${ shellQuote(remote) } ${ shellQuote(source) }:refs/heads/${ branch } 2>&1 || exit 1`,
    'echo BARN-PUSH-OK',
  ].join(' ; '));

  const noToken = /BARN-NO-TOKEN:(\d+)/.exec(pushLog);

  if (noToken) {
    throw new PublishError(
      `The push did not happen: ${ noTokenReason(noToken[1]) }.`, GITHUB_PUBLISH_STAGES[3], ''
    );
  }

  if (!pushLog.includes('BARN-PUSH-OK')) {
    throw new PublishError(`could not push to ${ repo }`, GITHUB_PUBLISH_STAGES[3], scrubTokens(pushLog));
  }

  return {
    plugin, version, repo, branch, url: `https://github.com/${ repo }/tree/${ branch }`, log: scrubTokens(pushLog),
  };
}

export interface GithubPublishResult {
  plugin: string;
  version: string;
  repo: string;
  /** Where it went. Never the default branch unless the gate let it. */
  branch: string;
  url: string;
  log: string;
}

/**
 * Create or update the UIPlugin that makes Rancher load it.
 *
 * PUT rather than delete-and-create on an update: the resource is what Rancher's index is built
 * from, and removing it even briefly is an extension disappearing out of somebody's nav.
 */
async function upsertUiPlugin(
  plugin: string, version: string, url: string, annotations: Record<string, string>
): Promise<void> {
  const body = {
    apiVersion: 'catalog.cattle.io/v1',
    kind:       'UIPlugin',
    metadata:   { namespace: PLUGIN_NS, name: plugin },
    spec:       {
      plugin: {
        name:     plugin,
        version,
        endpoint: url,
        noCache:  true,
        metadata: {
          ...annotations,
          // What makes the browser load `endpoint` itself instead of asking Rancher to serve
          // the plugin's files from a chart it downloaded. See extension-manager-impl.js.
          direct: 'true',
        },
      },
    },
  };

  const type = 'catalog.cattle.io.uiplugins';
  const existing = await rancherFetch(`${ EXT_BASE }/v1/${ type }/${ PLUGIN_NS }/${ plugin }`).catch(() => null);

  if (existing) {
    await rancherFetch(`${ EXT_BASE }/v1/${ type }/${ PLUGIN_NS }/${ plugin }`, {
      method: 'PUT',
      body:   JSON.stringify({ ...existing, spec: body.spec }),
    });

    return;
  }

  await rancherFetch(`${ EXT_BASE }/v1/${ type }`, { method: 'POST', body: JSON.stringify(body) });
}

/**
 * Take this extension back out of the Rancher it was published into.
 *
 * The undo for the near half of the Publish button, and the whole of it: publishing locally
 * makes one UIPlugin pointing at a URL the pod serves, so removing that object is the removal.
 * The pod, its tree and everything in it are untouched - this is about what Rancher loads, not
 * about the extension existing.
 *
 * Resolving the plugin's name through the package rather than assuming it matches the
 * extension's, for the reason packageIdentity exists: the two agree by convention and not by
 * construction, and an import can arrive with a package named after where it came from.
 */
export async function removeLocalInstall(name: string): Promise<string> {
  const { name: plugin } = await packageIdentity(name);
  const type = 'catalog.cattle.io.uiplugins';
  const existing = await rancherFetch(`${ EXT_BASE }/v1/${ type }/${ PLUGIN_NS }/${ plugin }`).catch(() => null);

  if (!existing) {
    throw new Error(`${ plugin } is not installed in this Rancher`);
  }

  await rancherFetch(`${ EXT_BASE }/v1/${ type }/${ PLUGIN_NS }/${ plugin }`, { method: 'DELETE' });

  return plugin;
}

/** What is installed right now, so the button can say "update" rather than "install". */
export async function publishedVersion(name: string): Promise<string> {
  const plugin = await packageIdentity(name).then((identity) => identity.name).catch(() => '');

  if (!plugin) {
    return '';
  }

  const existing = await rancherFetch(
    `${ EXT_BASE }/v1/catalog.cattle.io.uiplugins/${ PLUGIN_NS }/${ plugin }`
  ).catch(() => null);

  return existing?.spec?.plugin?.version || '';
}

/**
 * The dev server's own output, straight out of the pod's log.
 *
 * This is what "raw output" means in the workspace. The design's strip under the steps is
 * labelled "Show raw output · vue-cli-service serve" (32:893), and that command is literally
 * what the pod runs (pod/boot.sh ends `exec ./node_modules/.bin/vue-cli-service serve`), so
 * its compile output is a real thing to expand rather than a stand-in for the terminal.
 *
 * A plain `fetch` and not `rancherFetch`: a container log is text/plain, and the JSON parse
 * every other call in this file wants would throw on it. Same origin and the same session, so
 * there is still nothing to configure.
 *
 * Empty string when the extension has no running pod - there is no log of a server that is not
 * running, and that is a different thing from a log that could not be read, which throws.
 */
export async function devServerLog(name: string, lines = 400): Promise<string> {
  const pod = await extensionPod(name);

  if (!pod) {
    return '';
  }

  // No Accept header. The pod log endpoint answers plain text, and asking for it explicitly is
  // what breaks it: the apiserver behind Rancher's proxy replies 406 to `Accept: text/plain` and
  // 200 to no header at all. That regressed the cover's no-regression clause for one wave, with
  // "Show raw output" rendering an HTTP 406 where the log should be.
  const resp = await fetch(
    `${ EXT_BASE }/api/v1/namespaces/${ EXT_NS }/pods/${ pod }/log?tailLines=${ lines }`,
  );

  if (!resp.ok) {
    throw new Error(`the dev server's log could not be read: HTTP ${ resp.status }`);
  }

  return resp.text();
}

/**
 * What the claude in this pod may do without asking, read rather than asserted.
 *
 * The design draws a permission-mode picker on the composer's status strip (11:226, 16:557) and
 * this product has nothing to point it at: the mode is fixed by the arguments claude is started
 * with, in `pod/claude-session.sh`, which is seeded from the bundle and re-written on every page
 * load (`ensureDefaultExtension`). So the chip states the mode instead of setting it - and it
 * states the one the pod is actually running, not the one this file happens to remember.
 *
 * The running process first, because that is the fact; the session script second, for a pod
 * where no session has been opened yet and there is therefore no process to read. `read` says
 * whether the pod answered at all, which is a different thing from a pod with no claude in it.
 */
export interface AssistantPermissions {
  /** Whether the pod could be asked. Nothing else here means anything when false. */
  read:    boolean;
  /** Whether a claude process was found. False means the mode comes from the session script. */
  running: boolean;
  /** 'bypass' | 'accept-edits' | 'plan' | 'default' | '' when nothing could be read. */
  mode:    string;
  /** The command line it was read off, for the tooltip: a claim with its evidence attached. */
  argv:    string;
  /** 'process' | 'script' | '' */
  source:  string;
}

const PERM_MARKER = 'BARN-PERM';

/** The mode a claude command line asks for. Its own default when it asks for nothing. */
function permissionModeOf(argv: string): string {
  if (/--dangerously-skip-permissions\b/.test(argv)) {
    return 'bypass';
  }

  const named = /--permission-mode[\s=]+(\S+)/.exec(argv)?.[1] || '';

  if (/^acceptEdits$/i.test(named)) {
    return 'accept-edits';
  }

  if (/^plan$/i.test(named)) {
    return 'plan';
  }

  if (/^bypassPermissions$/i.test(named)) {
    return 'bypass';
  }

  return 'default';
}

export async function assistantPermissions(name: string): Promise<AssistantPermissions> {
  const none = {
    read: false, running: false, mode: '', argv: '', source: '',
  };
  const out = await inPackage(name, [
    `echo ${ PERM_MARKER }`,
    "ps -eo args= 2>/dev/null | grep -m1 '^claude'",
    'echo "--script--"',
    "sed -n 's/^ *\\(claude .*\\)$/\\1/p' /seed/claude-session.sh 2>/dev/null | head -1",
  ].join(' ; ')).catch(() => '');

  if (!out.includes(PERM_MARKER)) {
    return none;
  }

  const [head = '', tail = ''] = out.split('--script--');
  const running = head.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('claude'))[0] || '';
  // The script writes the same command twice with different arguments; either says the mode.
  // `|| true` and a shell variable at the end of the line are the script's, not the command's.
  const scripted = (tail.split('\n').map((l) => l.trim()).filter(Boolean)[0] || '')
    .replace(/\s*\|\|.*$/, '')
    .trim();
  const argv = running || scripted;

  if (!argv) {
    return { ...none, read: true };
  }

  return {
    read:    true,
    running: !!running,
    mode:    permissionModeOf(argv),
    argv,
    source:  running ? 'process' : 'script',
  };
}

/**
 * The cluster every extension pod runs in, and every cluster this Rancher has.
 *
 * The masthead's "Preview on: local" (16:511) is drawn as a target you could change, and it is
 * not one: `EXT_CLUSTER` above is a module literal, so a pod is created in this cluster or
 * nowhere. Rather than assert that in a tooltip, the chip reads what is there - if this Rancher
 * ever had a second cluster the reading would say so, and the sentence about why the preview is
 * not a picker would still be true and would be measurably about something.
 */
export interface PreviewTarget {
  /** The cluster extension pods are created in. */
  cluster:  string;
  /** Every cluster this Rancher manages, when it could be read. */
  clusters: string[];
  read:     boolean;
}

export async function previewTarget(): Promise<PreviewTarget> {
  const list = await rancherFetch('/v1/management.cattle.io.clusters').catch(() => null);
  const names = (list?.data || [])
    .map((c: any) => c?.spec?.displayName || c?.metadata?.name || c?.id)
    .filter(Boolean);

  return { cluster: EXT_CLUSTER, clusters: names, read: !!list };
}

/**
 * The clusters a previewed page can be about, with what each one is.
 *
 * Not the same question as `previewTarget` above, and the difference is the whole reason this
 * exists. That one answers "where does the dev server run", which is `EXT_CLUSTER` and is not
 * a choice. This one answers "which cluster is the page in the frame about", which is a choice,
 * because the framed thing is a whole dashboard and its routes carry a cluster id: the seeded
 * extension's own page is `/<product>/c/<cluster>/home`, and the explorer under it is
 * `/c/<cluster>/explorer`. Pointing that at another cluster exercises the extension against
 * another cluster's data, which is what screen 13's picker (39:1364) is for.
 *
 * Each entry carries what the cluster object says about itself, because the design annotates
 * the current one with why it matters here. This cannot know which capability matters to a
 * particular extension, so it reports what is true of every cluster - whether it is ready, what
 * it runs on, its Kubernetes version and how many nodes it has - and leaves the reading to the
 * person choosing.
 */
export interface PreviewCluster {
  /** The cluster id, which is what goes in a route. */
  id:       string;
  /** What Rancher calls it on screen. */
  name:     string;
  ready:    boolean;
  /** k3s, rke2, imported, ... as Rancher reports it. Empty when it does not. */
  provider: string;
  /** The Kubernetes version, as reported. Empty when it is not. */
  version:  string;
  /** How many nodes, or 0 when the cluster does not say. */
  nodes:    number;
}

export async function previewClusters(): Promise<PreviewCluster[]> {
  const list = await rancherFetch('/v1/management.cattle.io.clusters').catch(() => null);

  if (!list) {
    // A reading that did not happen is not "no clusters". The caller has to be able to tell
    // the two apart, so this throws rather than answering with an empty list.
    throw new Error('Rancher would not list its clusters');
  }

  return (list.data || [])
    .map((c: any) => {
      const id = c?.metadata?.name || c?.id || '';
      const ready = (c?.status?.conditions || [])
        .some((cond: any) => cond?.type === 'Ready' && cond?.status === 'True');

      return id ? {
        id,
        name:     c?.spec?.displayName || id,
        ready,
        provider: c?.status?.provider || c?.status?.driver || '',
        version:  c?.status?.version?.gitVersion || '',
        nodes:    Number(c?.status?.nodeCount) || 0,
      } : null;
    })
    .filter(Boolean)
    .sort((a: PreviewCluster, b: PreviewCluster) => a.name.localeCompare(b.name));
}

/**
 * When this extension came into existence, as the cluster recorded it.
 *
 * The ConfigMap holding its seed is the first object `ensureExtension` creates, so its
 * creation timestamp is the moment the extension was made. Empty when the object cannot be
 * read, which reads downstream as "no age known" rather than as "made just now".
 *
 * It is deliberately not offered as the age of a *request*. Nothing asked for an extension the
 * Studio created by itself, and a brief that records no `## Who asked` records no date either;
 * this is the only date about the extension that is not a guess, and screen 10 says which of
 * the two it is showing.
 */
export async function extensionCreatedAt(name: string): Promise<string> {
  const cm = await extGet('configmaps', extensionObject(name)).catch(() => null);

  return cm?.metadata?.creationTimestamp || '';
}

/**
 * Interrupt whatever the assistant is doing, the way a person at the keyboard would.
 *
 * The design puts a Stop beside Send (11:347, 19:807) and the product had nothing behind it.
 * What there is, is the same wire `askAssistant` types down: claude is a TUI in a tmux pane,
 * and Escape is its interrupt. `tmux send-keys Escape` presses it from here.
 *
 * What this cannot do is tell you whether anything was running. Nothing in the pod records a
 * turn starting or ending in real time (the Stop hook is the only end there is, and it fires
 * after the fact), so the caller must not claim the run was halted - only that the interrupt
 * was delivered. 'none' means there is no session to interrupt, which is a different answer
 * from a failure and is worth saying out loud.
 */
export async function interruptAssistant(name: string): Promise<'sent' | 'none'> {
  const out = await inPackage(name, [
    `if tmux has-session -t ${ ASSISTANT_SESSION } 2>/dev/null ; then`,
    `tmux send-keys -t ${ ASSISTANT_SESSION } Escape && echo BARN-STOP-SENT ;`,
    'else echo BARN-STOP-NONE ; fi',
  ].join(' '));

  if (out.includes('BARN-STOP-SENT')) {
    return 'sent';
  }

  if (out.includes('BARN-STOP-NONE')) {
    return 'none';
  }

  throw new Error(`the interrupt did not reach ${ name }: ${ out.trim().slice(0, 200) || 'no output' }`);
}

// ---------------------------------------------------------------------------
// What claude itself recorded: its replies, the model that answered, and the mode it is in.
//
// Everything above this line reads the pod's own provenance log (pod/barn-provenance.mjs),
// which is deliberately coarse: it records a prompt, the files an editing tool touched, and the
// end of a turn, and nothing between. That is the right source for attribution - it is stable,
// it is checkable with git, and it degrades honestly - and it is the wrong source for two
// things the design asks for, because it never had them:
//
//   The assistant's own words (11:242). The provenance log has no reply in it at all, so the
//   stream could only ever say what a turn *ended in*. claude writes every reply into its own
//   transcript (~/.claude/projects/<slug>/<session>.jsonl), which is where it is read from
//   here. The transcript is claude's private format and it may change; that risk is taken here
//   and not in the provenance record, and the difference matters: a shape this does not
//   recognise shows as "no reply recorded", which is a gap on screen, while the same failure in
//   the attribution record would be lines silently credited to the wrong prompt.
//
//   The model and the permission mode. Neither is anywhere in the provenance log. The model is
//   in claude's own settings and on every reply it wrote; the mode is on claude's status line
//   in the pane, which is the only place that reports the mode it is in *now* rather than the
//   one it was started with.
// ---------------------------------------------------------------------------

/** One reply, exactly as claude wrote it into its transcript. */
export interface AssistantReply {
  /** ISO, claude's own timestamp for the message. */
  at:      string;
  /** The text parts of the reply, joined. Tool calls are not text and are not here. */
  text:    string;
  /** The model it came back on. '<synthetic>' is claude's own marker for a local message. */
  model:   string;
  /** Non-empty when claude recorded this as an error rather than an answer. */
  error:   string;
  session: string;
}

export interface AssistantConversation {
  /** Whether the pod answered. Nothing else here means anything when false. */
  read:    boolean;
  /** The tree the transcript belongs to, so a caller can say which conversation it read. */
  dir:     string;
  session: string;
  /** The claude that wrote it, for a tooltip that has to age well. */
  version: string;
  /** The permission mode claude stamped on its last prompt. Its own spelling. */
  mode:    string;
  /** The model the last real reply came back on. '' when nothing has answered yet. */
  model:   string;
  /** Oldest first, capped. */
  replies: AssistantReply[];
}

const CONVERSATION_MARKER = 'BARN-CLAUDE:';

/**
 * Read back in the pod rather than shipped here as JSONL.
 *
 * A transcript is megabytes of tool calls and file contents and the panel wants a few hundred
 * words of it, so the filtering happens where the file is. Only the tail of each file is read,
 * for the same reason - a half-parsed first line is dropped, which is the whole cost.
 */
const CONVERSATION_JS = String.raw`
const fs = require('node:fs');
const path = require('node:path');

const HOME = process.env.HOME || '/app/.home';
const ROOT = path.join(HOME, '.claude', 'projects');
const TEXT_LIMIT = 2000;
const TAIL_BYTES = 1500000;
const FILES = 4;
/**
 * How much prose comes back at all, newest first.
 *
 * This is read on a poll while somebody watches the panel, so the answer has to be bounded by
 * something other than how long the conversation is: one turn can be a dozen assistant
 * messages, and a long session would otherwise send a megabyte of prose through the exec every
 * fifteen seconds. Older replies are dropped rather than truncated, so what is shown is whole.
 */
const TOTAL_LIMIT = 60000;

function packageDir() {
  try {
    const dirs = fs.readdirSync('/app/pkg', { withFileTypes: true }).filter((e) => e.isDirectory());

    return dirs.length ? path.join('/app/pkg', dirs[0].name) : '';
  } catch { return ''; }
}

function transcripts() {
  const out = [];
  let dirs = [];

  try { dirs = fs.readdirSync(ROOT); } catch { return out; }

  dirs.forEach((d) => {
    let names = [];

    try { names = fs.readdirSync(path.join(ROOT, d)); } catch { return; }

    names.filter((n) => n.endsWith('.jsonl')).forEach((n) => {
      const p = path.join(ROOT, d, n);

      try { out.push({ path: p, at: fs.statSync(p).mtimeMs }); } catch { /* gone */ }
    });
  });

  return out.sort((a, b) => a.at - b.at).slice(-FILES);
}

function tail(file) {
  let fd;

  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const from = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - from);

    fs.readSync(fd, buf, 0, buf.length, from);

    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* closed */ } }
  }
}

const PKG = packageDir();
const replies = [];
let mode = '';
let version = '';
let session = '';

transcripts().forEach((entry) => {
  tail(entry.path).split('\n').forEach((line) => {
    let r;

    try { r = JSON.parse(line); } catch { return; }

    if (!r || typeof r !== 'object') { return; }
    // One pod can hold conversations from more than one directory. Only the extension's own.
    if (PKG && r.cwd && r.cwd !== PKG) { return; }

    if (r.version) { version = r.version; }
    if (r.sessionId) { session = r.sessionId; }
    if (r.permissionMode) { mode = r.permissionMode; }
    if (r.type !== 'assistant') { return; }

    const content = r.message && Array.isArray(r.message.content) ? r.message.content : [];
    const text = content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text.trim())
      .filter(Boolean)
      .join('\n\n');

    if (!text) { return; }

    replies.push({
      at:      r.timestamp || '',
      text:    text.slice(0, TEXT_LIMIT),
      model:   (r.message && r.message.model) || '',
      error:   r.isApiErrorMessage ? String(r.error || 'the request failed') : '',
      session: r.sessionId || '',
    });
  });
});

replies.sort((a, b) => String(a.at).localeCompare(String(b.at)));

// The model that answered, which is only ever read off a reply that is one: claude marks its
// own local messages '<synthetic>' and those name no model.
const answered = replies.filter((x) => x.model && x.model !== '<synthetic>' && !x.error);
const limit = parseInt(process.argv[2], 10) || 40;

// Newest first until the budget runs out, then back into order.
const kept = [];
let budget = TOTAL_LIMIT;

for (let i = replies.length - 1; i >= 0 && kept.length < limit && budget > 0; i--) {
  kept.unshift(replies[i]);
  budget -= replies[i].text.length;
}

// Escaped to ASCII on purpose. podExecResult decodes each frame with atob, which produces a
// binary string - one character per byte - so a UTF-8 character arrives as its bytes and
// renders as mojibake. Nothing that goes through that exec had contained a non-ASCII
// character before this, and claude's prose is full of them. A \uXXXX escape is ASCII on the
// wire and the right character after JSON.parse, so this is correct without changing how
// every other reader in this file decodes.
// (No backticks in this comment: it lives inside a template literal.)
process.stdout.write('BARN-CLAUDE:' + JSON.stringify({
  read:    true,
  dir:     PKG,
  session,
  version,
  mode,
  model:   answered.length ? answered[answered.length - 1].model : '',
  replies: kept,
}).replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '\n');
`;

const NO_CONVERSATION: AssistantConversation = {
  read: false, dir: '', session: '', version: '', mode: '', model: '', replies: [],
};

/**
 * Every reply claude has written in this pod's conversation, newest last.
 *
 * The one thing the activity stream could never show. The provenance hooks record that a turn
 * happened and what it left behind; this is what the assistant actually said while doing it,
 * which is the half of the design's turn (11:242, 11:249) that has been missing.
 *
 * Correlating a reply with a recorded turn is the caller's job and is done on time alone: a
 * reply belongs to the last turn that started before it. Nothing here guesses.
 */
export async function assistantConversation(name: string, limit = 40): Promise<AssistantConversation> {
  const out = await inPackage(name, [
    `node - ${ Math.max(1, Math.min(200, Math.floor(limit))) } <<'BARN_CONVERSATION_JS'`,
    CONVERSATION_JS,
    // The terminator has to be alone on its line, and `inPackage` puts ` ; }` after whatever
    // this ends with. `exit $?` is what goes between them: dash parses `EOF` followed by
    // ` ; }` as a command list beginning with a semicolon and refuses the whole script with
    // "Syntax error: ";" unexpected", which is a shell parse error rather than anything to do
    // with the JS above it and therefore takes a while to recognise. A real command on the
    // line after the terminator gives the semicolon something to follow, and this one also
    // keeps node's exit status.
    'BARN_CONVERSATION_JS',
    'exit $?',
  ].join('\n')).catch(() => '');

  const at = out.indexOf(CONVERSATION_MARKER);

  if (at < 0) {
    return NO_CONVERSATION;
  }

  try {
    const parsed = JSON.parse(out.slice(at + CONVERSATION_MARKER.length).split('\n')[0]);

    return {
      ...NO_CONVERSATION,
      ...parsed,
      replies: Array.isArray(parsed.replies) ? parsed.replies : [],
    };
  } catch {
    // A transcript claude writes in a shape this does not recognise reads as "nothing recorded",
    // which is a gap on screen rather than a wrong sentence in it.
    return NO_CONVERSATION;
  }
}

/**
 * The model the pod's claude will answer on, and the aliases it will accept for another one.
 *
 * The design puts a model chip in the composer's action bar (11:340, "Claude Opus 5") and draws
 * no chevron on it, so the drawn thing is a badge; the promise around it is that it names the
 * model the assistant will use. Four places can set that, in the order claude itself resolves
 * them, and each is read rather than assumed:
 *
 *   argv     - `--model` on the running process, which beats everything else for this session.
 *   env      - ANTHROPIC_MODEL in the pod.
 *   settings - `model` in ~/.claude/settings.json, which is what claude's own `/model` writes
 *              and is on the hostPath, so a choice made here survives a pod restart.
 *   config   - `model` in ~/.claude.json.
 *
 * When none of them names one - which is this pod's state until somebody chooses - claude uses
 * whatever that install defaults to, and this reports nothing rather than picking a name for
 * it. Deliberately not filled in from claude's transcript: that record is a private format and
 * the product has decided not to depend on it for facts it states about itself.
 *
 * `aliases` is parsed out of the pod's own `claude --help`, not listed here. A hard-coded list
 * would be a claim about a program this file does not ship.
 */
export interface AssistantModel {
  read:    boolean;
  /** The model as the pod spells it. '' when nothing in the pod names one. */
  model:   string;
  /** 'argv' | 'env' | 'settings' | 'config' | '' */
  source:  string;
  /** The aliases `claude --help` documents for --model, in the order it lists them. */
  aliases: string[];
  /** Whether there is a session to type `/model` into. */
  session: boolean;
}

const MODEL_MARKER = 'BARN-MODEL';

export async function assistantModel(name: string): Promise<AssistantModel> {
  const none: AssistantModel = {
    read: false, model: '', source: '', aliases: [], session: false,
  };
  const out = await inPackage(name, [
    `echo ${ MODEL_MARKER }`,
    "ps -eo args= 2>/dev/null | grep -m1 '^claude'",
    "echo '--env--'",
    'printenv ANTHROPIC_MODEL 2>/dev/null',
    "echo '--settings--'",
    `node -e 'const fs=require("fs");const g=(f)=>{try{return JSON.parse(fs.readFileSync(f,"utf8")).model||""}catch(e){return ""}};console.log(g(process.env.HOME+"/.claude/settings.json"));console.log(g(process.env.HOME+"/.claude.json"))' 2>/dev/null`,
    "echo '--help--'",
    "claude --help 2>/dev/null | sed -n '/--model </,/^ *-[a-zA-Z-]/p'",
    "echo '--session--'",
    `tmux has-session -t ${ ASSISTANT_SESSION } 2>/dev/null && echo BARN-SESSION`,
  ].join(' ; ')).catch(() => '');

  if (!out.includes(MODEL_MARKER)) {
    return none;
  }

  const section = (from: string, to: string) => {
    const head = out.split(from)[1] || '';

    return (to ? head.split(to)[0] : head);
  };
  const argv = (out.split('--env--')[0] || '').split('\n').map((l) => l.trim())
    .filter((l) => l.startsWith('claude'))[0] || '';
  const flagged = /--model[\s=]+(\S+)/.exec(argv)?.[1] || '';
  const env = section('--env--', '--settings--').trim();
  // Positional, and skipping index 0 on purpose. `echo '--settings--'` ends the marker line with
  // a newline, so splitting the output on the marker leaves the tail of that line as the first
  // element: the array is ['', settings, config, '']. Destructuring the first two took the empty
  // tail as `settings` and the settings.json value as `config`, so a model set in settings.json
  // was reported as coming from ~/.claude.json and one set only in ~/.claude.json was dropped.
  //
  // Trimming the section first would be wrong for the same reason in the other direction: an
  // empty first value is meaningful (that file sets no model), and trimming would shift the
  // second value into its place.
  const lines = section('--settings--', '--help--').split('\n');
  const settings = (lines[1] || '').trim();
  const config = (lines[2] || '').trim();
  const help = section('--help--', '--session--');

  // The aliases, and only the aliases: claude's own sentence is "an alias for the latest model
  // (e.g. 'opus', or 'sonnet') or a model's full name (e.g. 'claude-...')", so everything from
  // "full name" onwards is an example of the other kind and is not offered as one of these.
  const aliases = [...help.split(/full name/)[0].matchAll(/'([A-Za-z0-9][\w.-]*)'/g)]
    .map((m) => m[1])
    .filter((alias, i, all) => all.indexOf(alias) === i);

  const found: [string, string][] = [
    ['argv', flagged], ['env', env], ['settings', settings], ['config', config],
  ];
  const [source = '', model = ''] = found.find(([, value]) => !!value) || [];

  return {
    read:    true,
    model,
    source,
    aliases,
    session: out.includes('BARN-SESSION'),
  };
}

/**
 * Point the pod's claude at another model.
 *
 * Two ways, because there are two states the pod can be in and both have to work:
 *
 *   'session' - a pane is open, so `/model <alias>` is typed into it. That is claude's own
 *               command: it changes the model this conversation is using from the next turn,
 *               and claude writes the choice into ~/.claude/settings.json itself, so it also
 *               becomes the default for the next session.
 *   'settings' - nobody has opened the workspace for this pod, so there is no conversation to
 *               change. The same key is written into ~/.claude/settings.json here, which is
 *               where claude reads it when a session does start. On the hostPath, so it
 *               survives the pod restarting.
 *
 * The alias is checked against `[\w.-]` before it goes anywhere near the shell or the pane.
 */
export async function setAssistantModel(name: string, alias: string): Promise<'session' | 'settings'> {
  const wanted = String(alias || '').trim();

  if (!/^[\w.-]+$/.test(wanted)) {
    throw new Error(`${ wanted || 'that' } is not a model name this can send`);
  }

  const out = await inPackageStrict(name, [
    `if tmux has-session -t ${ ASSISTANT_SESSION } 2>/dev/null ; then`,
    `tmux send-keys -t ${ ASSISTANT_SESSION } -l ${ shellQuote(`/model ${ wanted }`) } && sleep 1 &&`,
    `tmux send-keys -t ${ ASSISTANT_SESSION } Enter && echo BARN-MODEL-SESSION ;`,
    `else node -e 'const fs=require("fs");const p=process.env.HOME+"/.claude/settings.json";let s={};try{s=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){};s.model=process.argv[1];fs.mkdirSync(require("path").dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(s,null,2)+"\\n",{mode:0o600})' ${ shellQuote(wanted) } &&`,
    'echo BARN-MODEL-SETTINGS ; fi',
  ].join(' '), `choosing ${ wanted }`);

  if (out.includes('BARN-MODEL-SESSION')) {
    return 'session';
  }

  if (out.includes('BARN-MODEL-SETTINGS')) {
    return 'settings';
  }

  throw new Error(`${ wanted } did not reach ${ name }: ${ out.trim().slice(0, 200) || 'no output' }`);
}

/**
 * The permission mode the assistant is in right now, read off claude's own status line.
 *
 * `assistantPermissions` above reads the command line claude was *started* with, which is the
 * mode it began in and not necessarily the one it is in: claude cycles its mode on shift+tab
 * and prints the current one at the bottom of the pane ("bypass permissions on (shift+tab to
 * cycle)"). That line is the only reading in this pod that is about now, so it is the one the
 * chip should prefer, with the command line behind it for a pod with no session open.
 *
 * claude's own words are kept rather than mapped to an enum here. It has more modes than this
 * file knows about - "auto mode" appeared without notice - and a reading that silently drops
 * one it does not recognise is worse than one that repeats what the pane says.
 */
export interface AssistantMode {
  /** Whether the pane could be read. */
  read:    boolean;
  /** Whether there is a session at all. False with read true means nothing is running. */
  session: boolean;
  /** claude's own spelling: 'bypass permissions', 'accept edits', 'plan mode', 'auto mode', ... */
  mode:    string;
  /** The whole status line, for a tooltip that shows what the reading came off. */
  line:    string;
}

const MODE_MARKER = 'BARN-MODE';
/** claude's status line, which is the only line in the pane that offers the cycle. */
const MODE_LINE = /^(.*?)\s+on\s*\(shift\+tab to cycle\)/;

function parseMode(out: string): AssistantMode {
  if (!out.includes(MODE_MARKER)) {
    return {
      read: false, session: false, mode: '', line: '',
    };
  }

  if (out.includes('BARN-MODE-NONE')) {
    return {
      read: true, session: false, mode: '', line: '',
    };
  }

  const line = out.split('\n').map((l) => l.trim())
    .filter((l) => l.includes('shift+tab to cycle'))
    .pop() || '';
  // The glyphs claude prefixes the line with are its own; the mode is the words before " on".
  const mode = (MODE_LINE.exec(line.replace(/^[^A-Za-z]+/, ''))?.[1] || '').trim();

  return {
    read: true, session: true, mode, line,
  };
}

export async function assistantMode(name: string): Promise<AssistantMode> {
  const out = await inPackage(name, [
    `echo ${ MODE_MARKER } ;`,
    `if tmux has-session -t ${ ASSISTANT_SESSION } 2>/dev/null ; then`,
    // ASCII only. The status line begins with claude's own glyphs and `podExecResult` decodes
    // a frame with `atob`, which turns a UTF-8 character into its bytes; the tooltip quotes
    // this line, and mojibake in it would look like a bug in the reading rather than in the
    // decoding. The words the mode is read from are ASCII either way.
    `tmux capture-pane -p -t ${ ASSISTANT_SESSION } | tr -cd '\\11\\12\\15\\40-\\176' ;`,
    'else echo BARN-MODE-NONE ; fi',
  ].join(' ')).catch(() => '');

  return parseMode(out);
}

/**
 * Cycle the pane to the mode that was asked for, which is how a person changes it.
 *
 * claude has no "set the mode to X": shift+tab moves to the next one and the status line says
 * where it landed. So this does exactly that, in the pod so the round trips are not paid for
 * one keystroke at a time - press, read, stop when the line says the wanted mode - and returns
 * the mode it actually ended on. A mode this claude does not have is therefore reported as the
 * one it is in, not as the one that was asked for.
 *
 * What it cannot do is outlive the session. The mode claude *starts* in is fixed by the
 * arguments in pod/claude-session.sh, which is seeded from this bundle and written again on
 * every page load, so a restart comes back on the seeded mode. The caller has to say so.
 */
export async function cycleAssistantMode(name: string, want: string): Promise<AssistantMode> {
  const wanted = String(want || '').trim();

  if (!/^[\w ]+$/.test(wanted)) {
    throw new Error(`${ wanted || 'that' } is not a mode this can ask for`);
  }

  const out = await inPackageStrict(name, [
    `echo ${ MODE_MARKER } ;`,
    `if tmux has-session -t ${ ASSISTANT_SESSION } 2>/dev/null ; then`,
    `want=${ shellQuote(`${ wanted } on (shift+tab to cycle)`) } ; i=0 ;`,
    'while [ $i -lt 6 ] ; do',
    `case "$(tmux capture-pane -p -t ${ ASSISTANT_SESSION })" in *"$want"*) break ;; esac ;`,
    `tmux send-keys -t ${ ASSISTANT_SESSION } BTab ; sleep 1 ; i=$((i+1)) ;`,
    'done ;',
    `tmux capture-pane -p -t ${ ASSISTANT_SESSION } | tr -cd '\\11\\12\\15\\40-\\176' ;`,
    'else echo BARN-MODE-NONE ; fi',
  ].join(' '), `changing the assistant's permission mode in ${ name }`);

  return parseMode(out);
}
