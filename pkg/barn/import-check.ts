// Looking at a repository before importing it.
//
// The import dialog's step 3 draws a panel that says whether the chosen repository looks like a
// Rancher extension, which marker files it found, and how the Rancher it was built against
// compares with this one. Everything in that sentence is a fact about a repository nobody has
// cloned yet, so something has to go and look.
//
// It looks from a pod, for the reason `githubFiles` gives for cloning from one: the browser
// cannot `git clone`, the GitHub API costs a request per blob, and there is a container in this
// cluster that has git in it. What is different here is the shape of the answer - a verdict and
// four filenames rather than a tree - and the size of the fetch, which is a blob-less shallow
// clone plus two `git show`s rather than the whole repository.
//
// What this does NOT have is the token. `readSettings` never hands one back to a page, by
// design, so this check speaks to GitHub anonymously. A public repository answers; a private
// one does not, and the panel says exactly that rather than pretending the repository is
// broken. The import itself runs through `extensions.ts`, which does have the token, so a
// private repository that this check cannot read may still import perfectly well.
import { rancherFetch } from './api';
import { listExtensions, extensionPod, podExecOnce } from './extensions';

/** What one look at a repository found. */
export interface RepoCheck {
  repo: string;
  /** The branch that was actually inspected, which is the default when none was asked for. */
  branch: string;
  /** Whether GitHub answered at all. False for a private repository, and for a typo. */
  reachable: boolean;
  /** Every branch head, default first. The branch control's list. */
  branches: string[];
  defaultBranch: string;
  /** Marker files and shapes that are there, and the ones that are not, in the design's words. */
  found: string[];
  missing: string[];
  /** Where the package that would be imported lives, and what its package.json calls it. */
  packagePath: string;
  packageName: string;
  /** `catalog.cattle.io/rancher-version`, as written. Empty when the repository declares none. */
  declaredRancher: string;
  /** The verdict the panel leads with. */
  extension: boolean;
  /** Git's own words when it could not get that far. Empty on success. */
  error: string;
}

/**
 * The inspection, as it runs in the pod.
 *
 * Blob-less and unchecked-out on purpose: the whole point is to read four paths and two
 * package.json files, and a full clone of something the size of rancher/dashboard to answer
 * that would take longer than the import it is meant to save.
 *
 * The package is located the same way `IMPORT_SCRIPT` locates it - the first directory under
 * `pkg/`, falling back to the root - so the panel describes the very thing an import would
 * take, rather than a second opinion about the repository.
 */
const CHECK_SCRIPT = `
const { execFileSync } = require('child_process');

const repo = process.env.BARN_CHECK_REPO || '';
const wanted = process.env.BARN_CHECK_BRANCH || '';
const dir = process.env.BARN_CHECK_DIR;
const url = 'https://github.com/' + repo + '.git';
// No terminal and no askpass: without these git blocks forever on a private repository,
// waiting at a credential prompt nobody can see.
const env = Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/true' });
const git = (args, cwd) => execFileSync('git', args, {
  cwd: cwd, env: env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 120000, maxBuffer: 32 * 1024 * 1024
});

const out = {
  repo: repo, branch: wanted, reachable: false, branches: [], defaultBranch: '',
  found: [], missing: [], packagePath: '', packageName: '', declaredRancher: '',
  extension: false, error: ''
};

function say() { console.log('BARN-CHECK:' + JSON.stringify(out)); process.exit(0); }

function fail(e) {
  const text = String((e && (e.stderr || e.message)) || e).trim();
  out.error = text.split('\\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' ').slice(0, 300);
  say();
}

try {
  const refs = git(['ls-remote', '--symref', url, 'HEAD', 'refs/heads/*']);
  out.reachable = true;
  for (const line of refs.split('\\n')) {
    const sym = /^ref:\\s+refs\\/heads\\/(\\S+)\\s+HEAD$/.exec(line.trim());
    if (sym) { out.defaultBranch = sym[1]; continue; }
    const head = /\\srefs\\/heads\\/(\\S+)$/.exec(line);
    if (head) out.branches.push(head[1]);
  }
  out.branches.sort();
  const at = out.branches.indexOf(out.defaultBranch);
  if (at > 0) out.branches.splice(0, 0, out.branches.splice(at, 1)[0]);
} catch (e) { fail(e); }

const branch = wanted || out.defaultBranch;
out.branch = branch;

if (wanted && out.branches.length && out.branches.indexOf(wanted) === -1) {
  out.error = 'there is no branch called ' + wanted;
  say();
}

const tree = (path) => {
  try {
    return git(['ls-tree', '--name-only', 'HEAD'].concat(path ? [path] : []), dir)
      .split('\\n').filter(Boolean).map((f) => f.replace(/\\/$/, ''));
  } catch (e) { return []; }
};

let root = [];

try {
  execFileSync('rm', ['-rf', dir]);
  const args = ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout'];
  if (branch) args.push('--branch', branch);
  git(args.concat([url, dir]));
  root = tree('');
} catch (e) { fail(e); }

// Two layouts, and both are ones this product produces: the package under pkg/<name>/ with the
// dashboard skeleton around it, or the package alone at the root.
let base = '';
let inside = root;
const packages = root.indexOf('pkg') >= 0 ? tree('pkg/') : [];

if (packages.length) {
  base = packages[0] + '/';
  inside = tree(base);
}

const read = (path) => { try { return git(['show', 'HEAD:' + path], dir); } catch (e) { return ''; } };
const has = (name) => inside.indexOf(base + name) >= 0;

out.packagePath = has('package.json') ? base + 'package.json' : '';

let pkg = null;

if (out.packagePath) { try { pkg = JSON.parse(read(out.packagePath)); } catch (e) { pkg = null; } }

const entry = ['index.ts', 'index.js', 'index.vue'].filter(has)[0] || '';
const ann = (pkg && pkg.rancher && pkg.rancher.annotations) || null;
const deps = Object.assign({}, (pkg && pkg.dependencies) || {}, (pkg && pkg.devDependencies) || {});
let rootDeps = {};

if (base) {
  try {
    const r = JSON.parse(read('package.json'));
    rootDeps = Object.assign({}, r.dependencies, r.devDependencies);
  } catch (e) {}
}

const usesShell = !!(deps['@rancher/shell'] || rootDeps['@rancher/shell']);

out.packageName = (pkg && pkg.name) || '';
out.declaredRancher = (ann && ann['catalog.cattle.io/rancher-version']) || '';

const marker = (label, ok) => (ok ? out.found : out.missing).push(label);

marker(out.packagePath || 'package.json', !!pkg);
marker(base + (entry || 'index.ts'), !!entry);
marker('a pkg/ directory', packages.length > 0);
marker('the rancher annotations block', !!ann);

out.extension = !!pkg && (!!ann || (packages.length > 0 && !!entry) || usesShell);

say();
`;

/** Single-quote for `sh`. The copy in extensions.ts is not exported; this is two lines. */
function shellQuote(value: string): string {
  return `'${ value.split("'").join(`'\\''`) }'`;
}

/**
 * As uid 1000, with a HOME, the way extensions.ts runs everything in these pods.
 *
 * Duplicated rather than imported because `asPodUser` is private to that module. Running as
 * root instead would work today and leave root-owned directories in a /tmp that the import's
 * own clone then writes into as uid 1000, which is a failure nobody would connect to this.
 */
function asPodUser(script: string): string[] {
  const withHome = `export HOME=/app/.home; ${ script }`;

  return ['/bin/sh', '-c', `setpriv --reuid=1000 --regid=1000 --init-groups /bin/sh -c ${ shellQuote(withHome) }`];
}

/**
 * A pod to look from.
 *
 * The same borrowing `githubFiles` does, and for the same reason: the extension being imported
 * does not exist yet, so it uses somebody else's container. Nothing of that extension is
 * touched - the clone lands in /tmp and is deleted afterwards.
 */
async function borrowPod(): Promise<string | null> {
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

/**
 * Look at a repository. Throws only when the look could not happen at all.
 *
 * A repository that is unreachable, or that turns out not to be an extension, is a successful
 * check with an unwelcome answer, and comes back in the result. A throw here means there was
 * no pod to look from, or the pod said something unreadable - the difference matters, because
 * the panel has to say "could not check" rather than "this is not an extension".
 */
export async function inspectRepository(repo: string, branch = ''): Promise<RepoCheck> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(`"${ repo }" is not owner/name`);
  }

  const pod = await borrowPod();

  if (!pod) {
    throw new Error('checking needs one extension already running, because the look happens in its pod');
  }

  // A directory of its own per look, because two of these can overlap: the second one's
  // `rm -rf` would delete the first one's clone out from under it, and the first one's tidy-up
  // would then delete the second one's.
  const id = Math.random().toString(36).slice(2, 10);
  const dir = `/tmp/barn-check-${ id }`;
  const script = `${ dir }.js`;

  await podExecOnce(pod, asPodUser(`echo ${ btoa(CHECK_SCRIPT) } | base64 -d > ${ script }`));

  const out = await podExecOnce(pod, asPodUser(
    `BARN_CHECK_DIR=${ shellQuote(dir) } BARN_CHECK_REPO=${ shellQuote(repo) } ` +
    `BARN_CHECK_BRANCH=${ shellQuote(branch) } node ${ script } 2>&1`
  ));

  // The clone is somebody else's /tmp. Not awaited into the answer, but not left behind either.
  podExecOnce(pod, asPodUser(`rm -rf ${ dir } ${ script }`)).catch(() => null);

  const found = /BARN-CHECK:(.*)/.exec(out);

  if (!found) {
    throw new Error(`could not look at ${ repo }: ${ out.trim().slice(0, 200) || 'no output' }`);
  }

  try {
    return JSON.parse(found[1]) as RepoCheck;
  } catch {
    throw new Error(`the check on ${ repo } answered with something unreadable`);
  }
}

/**
 * This Rancher's version, as Rancher itself reports it.
 *
 * `server-version` on a released build is `v2.15.1`; on a dev build it is
 * `v2.15-<sha>-head`, which is why only the first two numbers are ever trusted below.
 */
export async function rancherVersion(): Promise<string> {
  const setting = await rancherFetch('/v1/management.cattle.io.settings/server-version');

  return setting?.value || setting?.default || '';
}

function parseVersion(value: string): number[] | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(value || '');

  return match ? [+match[1], +match[2], +(match[3] || 0)] : null;
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }

  return 0;
}

export interface Skew {
  state: 'ok' | 'outside' | 'unknown';
  text:  string;
}

/**
 * Whether this Rancher is inside the range the repository asks for.
 *
 * Enough semver to read the ranges extensions actually write - `>= 2.10.0`,
 * `>= 2.11.0-0 < 3.0.0` - and no more. A range with a shape this does not understand is
 * reported as unknown rather than guessed at, because a wrong "compatible" is worse than an
 * honest "cannot tell".
 *
 * Prereleases are dropped from both sides. A dev build of Rancher reports `v2.15-<sha>-head`
 * and an extension writes `>= 2.11.0-0` to mean "including prereleases of 2.11", and comparing
 * those two as full semver says something nobody meant.
 */
export function versionSkew(declared: string, running: string): Skew {
  const here = parseVersion(running);
  const shown = here ? `${ here[0] }.${ here[1] }` : running;

  if (!declared.trim()) {
    return {
      state: 'unknown',
      text:  `It does not say which Rancher it was built against, so Studio cannot tell you what has moved since. This Rancher is ${ shown }.`,
    };
  }

  if (!here) {
    return { state: 'unknown', text: `It asks for Rancher ${ declared }. Studio could not read this Rancher's version to compare.` };
  }

  const terms = declared.trim().split(/[\s,]+/);
  const comparators: { op: string; version: number[] }[] = [];

  for (let i = 0; i < terms.length; i++) {
    const inline = /^(>=|<=|>|<|=|\^|~)?\s*v?(\d.*)$/.exec(terms[i]);

    if (/^(>=|<=|>|<|=)$/.test(terms[i])) {
      const version = parseVersion(terms[i + 1] || '');

      if (!version) {
        return { state: 'unknown', text: `It asks for Rancher ${ declared }, which Studio cannot read. This Rancher is ${ shown }.` };
      }

      comparators.push({ op: terms[i], version });
      i++;
      continue;
    }

    if (!inline) {
      return { state: 'unknown', text: `It asks for Rancher ${ declared }, which Studio cannot read. This Rancher is ${ shown }.` };
    }

    const version = parseVersion(inline[2]);

    if (!version) {
      return { state: 'unknown', text: `It asks for Rancher ${ declared }, which Studio cannot read. This Rancher is ${ shown }.` };
    }

    // ^ and ~ both mean "this, up to the next one that may break it", which for the purpose of
    // a warning is the same as >= with an upper bound a major or a minor along.
    if (inline[1] === '^' || inline[1] === '~') {
      comparators.push({ op: '>=', version });
      comparators.push({
        op:      '<',
        version: inline[1] === '^' ? [version[0] + 1, 0, 0] : [version[0], version[1] + 1, 0],
      });
      continue;
    }

    comparators.push({ op: inline[1] || '=', version });
  }

  if (!comparators.length) {
    return { state: 'unknown', text: `It asks for Rancher ${ declared }, which Studio cannot read. This Rancher is ${ shown }.` };
  }

  const outside = comparators.filter(({ op, version }) => {
    const order = compare(here, version);

    if (op === '>=') {
      return order < 0;
    }
    if (op === '>') {
      return order <= 0;
    }
    if (op === '<=') {
      return order > 0;
    }
    if (op === '<') {
      return order >= 0;
    }

    return order !== 0;
  });

  if (!outside.length) {
    return { state: 'ok', text: `It asks for Rancher ${ declared }, and this Rancher is ${ shown }.` };
  }

  return {
    state: 'outside',
    text:  `It asks for Rancher ${ declared }, and this Rancher is ${ shown }, which is outside that. The assistant will have to flag anything that has moved.`,
  };
}
