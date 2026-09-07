// Publishing an extension, as two calls rather than two screens.
//
// Both of these existed only in the browser bundle (pkg/extension-studio/extensions.ts), which
// meant the only way to publish was for a person - or something driving a browser - to be on
// the publish screen. Everything they do is a pod command and a Rancher write, and this service
// already does both as the caller, so there was no reason for that except that nobody had
// moved it.
//
// What has NOT moved is the gate. `publishExtension` in the browser refuses while a change set
// is unreviewed, and `handOverForReview` is what opens a pull request; those are decisions
// about whether a change may leave, they belong with the screens that record the sign-off, and
// a second door into the same room with no lock on it would be worse than no door. So:
//
//   POST .../publish         builds in the pod and points a UIPlugin at the result - the same
//                            "load into this Rancher" that is ungated by design, because a dev
//                            preview asks nobody.
//   POST .../publish/github  pushes the package's own commit to a branch you name. It will not
//                            push to the repository's default branch: that is the gate, and
//                            the way through it is a pull request.
import { ApiError, rancherFetch } from './rancher.mjs';
import { runInPod } from './podexec.mjs';
import { inPackageCommand, shellQuote } from './podscript.mjs';
import { EXT_BASE, EXT_NS, extensionProxyPath } from './names.mjs';

/** Where a built bundle is put so the dev server serves it on Rancher's own origin. */
const PUBLISHED_DIR = 'published';
const UI_PLUGIN_NS = 'cattle-ui-plugin-system';
const SETTINGS_SECRET = 'settings';
const TOKEN_KEY = 'gh_token';
const BUILD_MS = 15 * 60 * 1000;

/** Run shell in the extension's package directory, as the tree's owner. */
async function inPackage(cred, pod, name, script, timeoutMs) {
  const result = await runInPod(cred, pod, inPackageCommand(name, script), timeoutMs);

  return String(result?.stdout || '') + String(result?.stderr || '');
}

/** What the package calls itself, which is not reliably what the extension is called. */
async function packageIdentity(cred, pod, name) {
  const raw = await inPackage(cred, pod, name, 'cat package.json', 30000);

  try {
    const parsed = JSON.parse(raw);

    if (!parsed.name || !parsed.version) {
      throw new Error('no name or version in it');
    }

    return { plugin: parsed.name, version: parsed.version, annotations: parsed.rancher?.annotations || {} };
  } catch (e) {
    throw new ApiError(`could not read the package.json of ${ name }: ${ e?.message || e }`, 502);
  }
}

/**
 * Point this Rancher's UIPlugin at a bundle, creating it if it is not there.
 *
 * A merge patch rather than a replace, so a UIPlugin somebody installed from a catalog keeps
 * whatever else is on it and changes only where it loads from.
 */
async function upsertUiPlugin(cred, plugin, version, url, annotations) {
  const spec = {
    plugin: {
      name: plugin, version, endpoint: url, noCache: true, noAuth: false, metadata: annotations,
    },
  };
  const path = `${ EXT_BASE }/v1/catalog.cattle.io.uiplugins/${ UI_PLUGIN_NS }/${ plugin }`;
  const existing = await rancherFetch(cred, path).catch(() => null);

  if (existing) {
    return rancherFetch(cred, path, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/merge-patch+json' },
      body:    JSON.stringify({ spec }),
    });
  }

  return rancherFetch(cred, `${ EXT_BASE }/v1/catalog.cattle.io.uiplugins`, {
    method: 'POST',
    body:   JSON.stringify({
      apiVersion: 'catalog.cattle.io/v1',
      kind:       'UIPlugin',
      metadata:   { name: plugin, namespace: UI_PLUGIN_NS },
      spec,
    }),
  });
}

/**
 * Build in the pod and load the result into this Rancher.
 *
 * The bundle is copied into /app/public, which the dev server already serves at the root of its
 * proxy path, so it is reachable on Rancher's own origin without anything else being started.
 * The URL carries the pod's clock as a cache-buster: the browser has almost certainly loaded
 * that exact path before, and a republish that quietly served the previous bundle is the
 * failure this whole call exists to avoid.
 */
export async function publishLocal(cred, pod, name) {
  const { plugin, version, annotations } = await packageIdentity(cred, pod, name);
  const built = `${ plugin }-${ version }`;
  // 2>&1 because build-pkg says everything useful on stderr.
  const log = await inPackage(cred, pod, name,
    `cd /app && ./node_modules/@rancher/shell/scripts/build-pkg.sh ${ shellQuote(plugin) } 2>&1`, BUILD_MS);
  const bundle = `dist-pkg/${ built }/${ built }.umd.min.js`;
  const check = await inPackage(cred, pod, name, `test -f /app/${ bundle } && echo BUILT`, 30000);

  if (!check.includes('BUILT')) {
    throw new ApiError(`${ plugin } did not build: ${ log.slice(-1200) }`, 502);
  }

  const copy = await inPackage(cred, pod, name, [
    'cd /app',
    `mkdir -p public/${ PUBLISHED_DIR }`,
    `rm -rf public/${ PUBLISHED_DIR }/${ built }`,
    `cp -r dist-pkg/${ built } public/${ PUBLISHED_DIR }/${ built }`,
    'date +%s',
    'echo COPIED',
  ].join(' && '), 120000);

  if (!copy.includes('COPIED')) {
    throw new ApiError(`the built bundle could not be copied where the pod serves it: ${ copy.slice(-600) }`, 502);
  }

  const stamp = (copy.match(/(\d{10,})/) || [])[1] || String(Date.now());
  const url = `${ extensionProxyPath(name) }/${ PUBLISHED_DIR }/${ built }/${ built }.umd.min.js?t=${ stamp }`;

  await upsertUiPlugin(cred, plugin, version, url, annotations);

  return {
    plugin, version, url, log: log.slice(-4000),
  };
}

/**
 * Read the configured GitHub token inside the pod, with the pod's own identity.
 *
 * Never through this service and never in a command's arguments: the pod asks the apiserver for
 * the Secret using the ServiceAccount token mounted into it, and hands the result to git in the
 * environment. So the credential is not in this process, not in the answer, and not in the
 * pod's process list.
 */
function tokenReaderJs() {
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

/** Anything token-shaped, out of a log that is about to be returned. */
function scrubTokens(text) {
  return String(text || '').replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '<redacted>')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '<redacted>');
}

const BRANCH_RE = /^[A-Za-z0-9][\w./-]*$/;
const REPO_RE = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;

/**
 * Commit the package as it stands and push it to a branch.
 *
 * Source rather than a built bundle, deliberately: a chart repository is built by the receiving
 * repository's own workflow from a version it can see, and a bundle committed by hand is the
 * same artifact with no provenance.
 *
 * The branch is required and may not be the repository's default. Pushing straight to the
 * branch everyone else builds from is a distribution, and a distribution is the one thing in
 * this product that is supposed to be reviewed - so this pushes somewhere a pull request can be
 * opened from, and stops there.
 */
export async function publishToGithub(cred, pod, name, repo, branch, message) {
  if (!REPO_RE.test(String(repo || ''))) {
    throw new ApiError('Send {"repo": "owner/name"}.', 400);
  }
  if (!BRANCH_RE.test(String(branch || ''))) {
    throw new ApiError('Send {"branch": "a-branch-name"}: a branch to push to, which may not be the repository\'s default. Opening a pull request from it is how a change is offered.', 400);
  }

  const subject = String(message || `Publish ${ name }`).replace(/\s+/g, ' ').trim().slice(0, 200);
  const out = await inPackage(cred, pod, name, [
    'set -e',
    'git rev-parse --git-dir >/dev/null 2>&1 || { git init -q && git add -A && git -c user.email=studio@rancher -c user.name=Studio commit -qm "The tree as it was" ; }',
    'git add -A',
    `git -c user.email=studio@rancher -c user.name=Studio commit -qm ${ shellQuote(subject) } || echo NOTHING-TO-COMMIT`,
    `BARN_GH_TOKEN=$(node -e ${ shellQuote(tokenReaderJs()) }) || { echo "NO-TOKEN:$?" ; exit 0 ; }`,
    'BARN_GH_HEADER="AUTHORIZATION: basic $(printf %s "x-access-token:$BARN_GH_TOKEN" | base64 -w0)"',
    'export BARN_GH_HEADER',
    `git --config-env=http.extraheader=BARN_GH_HEADER push ${ shellQuote(`https://github.com/${ repo }.git`) } HEAD:refs/heads/${ branch } 2>&1`,
    'echo PUSHED',
  ].join('\n'), 300000);
  const log = scrubTokens(out);

  if (log.includes('NO-TOKEN:')) {
    throw new ApiError(
      `no GitHub token is configured for the Studio, so ${ name } cannot be pushed. It is the "gh_token" key of the "${ SETTINGS_SECRET }" Secret in ${ EXT_NS }, and the Studio's settings screen writes it.`,
      412,
    );
  }

  if (!log.includes('PUSHED')) {
    throw new ApiError(`could not push ${ name } to ${ repo }: ${ log.slice(-1200) }`, 502);
  }

  return {
    repo,
    branch,
    committed: !log.includes('NOTHING-TO-COMMIT'),
    pullRequest: `https://github.com/${ repo }/pull/new/${ branch }`,
    log: log.slice(-4000),
  };
}
