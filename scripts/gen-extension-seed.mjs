// Bakes the DevExtension source into the barn extension as a seed.
//
// The extension has to be able to bring a working dev server up from nothing - it creates
// the pod when it loads, before anything has ever been copied into the cluster - so the
// source has to travel with the extension bundle. Generating it from the real tree keeps one
// source of truth: the alternative is a hand-copied duplicate that silently rots.
//
// Run after editing anything under extension-skeleton/ or base-extension/:
//   node scripts/gen-extension-seed.mjs
// The generated file is committed, so normal builds and CI never run this.
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

// Let this script import the extension's own TypeScript.
//
// It is here for one check: the objects the pod's service creates have to be the objects the
// browser creates, and the only way to know that is to render both and compare them. Node
// strips the types off a .ts file by itself; what it will not do is guess the extension on
// `./install`, which is how every import in this codebase is written. Appending it on a failed
// resolve is the whole of the bridge, and it is scoped to this process.
// The extension's package.json has no `type`, because it is built as a UMD bundle and adding
// one would change what webpack produces. Node therefore warns, at five lines, every time this
// script imports a .ts file - which is noise about a thing nobody is going to change.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.code !== 'MODULE_TYPELESS_PACKAGE_JSON') {
    console.warn(warning);
  }
});

registerHooks({
  resolve(specifier, context, nextResolve) {
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

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(here, '..', 'pkg', 'extension-studio', 'extension-skeleton');
const OWNER = path.join(here, '..', 'pkg', 'extension-studio', 'extensions.ts');
const OUT = path.join(here, '..', 'pkg', 'extension-studio', 'extension-seed.generated.ts');

// The app skeleton the dev server needs. There is no lockfile: the pod installs from
// package.json, and pinning the shell to a resolution recorded on somebody's laptop is the
// opposite of what a dev server for extension work wants.
const ROOT_FILES = ['package.json', 'babel.config.js', 'tsconfig.json'];

/**
 * The packages a new extension can be seeded from.
 *
 * One: the stock extension - one product, one page - which is what
 * `yarn create @rancher/extension` gives you and what you want when starting something new.
 *
 * There were two. The other was this product's own extension, vendored here so that barn could
 * bake it into its bundle, because a seed was once the only way a pod could be given a tree.
 * It is not any more: barn imports from a repository, so the Dev extension lives in one -
 * codyrancher/dev-extension - and arrives the same way anybody else's would.
 *
 * A real directory rather than strings built here, so it is linted, type-checked and editable
 * like any other source.
 */
const PACKAGES = { base: { app: 'base-extension', pkg: 'pkg/base' } };

// Files that run *in* the pod rather than being part of the extension. Real files rather
// than strings built here: they are long enough to deserve linting and a syntax highlighter,
// and one of them is a shell script, whose escaping is exactly the kind of thing that breaks
// when a second place has to reproduce it.
const POD_DIR = 'pod';

function walk(root, dir, acc = []) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    // node_modules and dot directories are never part of the seed. One `yarn install` inside the
    // package would otherwise bake tens of thousands of files into the extension bundle, which is
    // the same hazard the sync script had and the same fix.
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
      continue;
    }

    const rel = path.posix.join(dir, entry.name);

    if (entry.isDirectory()) {
      walk(root, rel, acc);
    } else {
      acc.push(rel);
    }
  }

  return acc;
}

/**
 * Read `export const NAME = 'value';` out of a TypeScript source file.
 *
 * Deliberately only handles that one shape, so it either works or throws. The point is that
 * boot.sh un-flattens the ConfigMap keys with the same separator the extension flattened
 * them with, and neither side gets to hold its own copy of it.
 */
function tsConstant(file, name) {
  const src = fs.readFileSync(file, 'utf8');
  const match = src.match(new RegExp(`export const ${ name } = '([^']*)';`));

  if (!match) {
    throw new Error(`could not find "export const ${ name }" in ${ path.basename(file) }`);
  }

  return match[1];
}

const SEPARATOR = tsConstant(OWNER, 'PATH_SEPARATOR');
const SUBSTITUTIONS = { __PATH_SEPARATOR__: SEPARATOR };

/**
 * The rules the pod and the browser both apply, kept in step by being checked here.
 *
 * A pod is seeded with text and run by node against nothing else on disk: it cannot import
 * pkg/extension-studio, and pkg/extension-studio cannot import it either - `barn-provenance.mjs` opens with node:fs
 * and node:child_process, which no browser bundle can hold. So two pieces of this product are
 * written twice on purpose, and the honest thing is to say which and to make drift fail:
 *
 *   - which attributes of a changed line are worth turning into a selector, in the pod's
 *     `marksFor` and in the browser's `selectorsInDiff`;
 *   - how much of a viewport a highlight is allowed to cover, and how many highlights there
 *     may be, in the pod's capture and in the browser's `tightest`.
 *
 * Both halves outline the same change set, so a number that differs between them is two panes
 * disagreeing about where a change landed - which is the bug this check exists to stop coming
 * back. Compared as source text rather than by evaluating either side, because this script
 * cannot run a .ts file and a regex is only equal to another one if it is spelled the same.
 */
function sourceOf(file, pattern, what) {
  const match = fs.readFileSync(file, 'utf8').match(pattern);

  if (!match) {
    throw new Error(`could not find ${ what } in ${ path.basename(file) }`);
  }

  return normalise(match[1]);
}

/**
 * A captured value with the parts that are allowed to differ taken out.
 *
 * Two of the constants below are arrays spread over several lines, and the browser's copy
 * carries paragraphs of comment inside the array that the pod's copy has no room for. Comparing
 * the text verbatim would report drift on every one of those sentences. What actually has to
 * agree is the shell that comes out the other end, so whole-line comments go and runs of
 * whitespace collapse. For a single-line value this does nothing.
 *
 * The collapse is the blind spot, and it is here rather than in a bug because no guarded value
 * has repeated whitespace that means anything yet: a doubled space inside a quoted string - a
 * `sed` pattern, say, or a printf format - reads the same to this as a single one, so the two
 * copies could drift there and be called equal. Guard a value like that by comparing it
 * verbatim instead of through here.
 */
function normalise(value) {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function checkInStep() {
  const barn = path.join(here, '..', 'pkg', 'extension-studio');
  const pod = path.join(barn, 'extension-skeleton', 'pod');
  const capture = path.join(pod, 'skills', 'barn-screenshot', 'screenshot.mjs');
  const regions = path.join(barn, 'change-regions.ts');
  // The service creates the same objects the browser creates, from a pod, which is a third
  // place this product is written twice - see pod/service/names.mjs. Only constants have to
  // agree, and every one of them is here, because the way they fail is silent: a Deployment
  // naming a container the browser does not expect installs, runs, and cannot be exec'd into.
  const names = path.join(pod, 'service', 'names.mjs');
  // The review reads are a third copy of this product's git knowledge, and the dangerous half of
  // it is the ref names: `refs/barn/approved` is written only by the browser (approveUpTo) and
  // read only by the pod (approvalScript), so a rename on one side is silent. Nothing fails,
  // nothing logs, and every change set stays pending for ever.
  const changes = path.join(pod, 'service', 'changes.mjs');
  const registry = path.join(pod, 'service', 'registry.mjs');
  const pairs = [
    [
      // Two readers of one registry, and the label is the whole of how they find it. A label
      // written on one side and selected on the other is a registry that looks empty.
      'the label a registry entry carries',
      [registry, /^const API_REGISTRY_LABEL = (.+);$/m],
      [path.join(barn, 'api-registry.ts'), /^export const API_REGISTRY_LABEL = (.+);$/m],
    ],
    [
      'the ref recording how far review has got',
      [changes, /^const APPROVED_REF = (.+);$/m],
      [OWNER, /^export const APPROVED_REF = (.+);$/m],
    ],
    [
      'the ref naming the last version published to a registry',
      [changes, /^const BASELINE_OCI_REF = (.+);$/m],
      [OWNER, /^export const BASELINE_OCI_REF = (.+);$/m],
    ],
    [
      'the ref naming the last version this Rancher loads',
      [changes, /^const BASELINE_LOCAL_REF = (.+);$/m],
      [OWNER, /^export const BASELINE_LOCAL_REF = (.+);$/m],
    ],
    [
      'the rule resolving the point a change is measured from',
      [changes, /^const BASELINE_SH = \[([\s\S]+?)\]\.join\(' '\);$/m],
      [OWNER, /^const BASELINE_SH = \[([\s\S]+?)\]\.join\(' '\);$/m],
    ],
    [
      'telling git that the untracked files are coming',
      [changes, /^const INTENT_SH = (.+);$/m],
      [OWNER, /^const INTENT_SH = (.+);$/m],
    ],
    [
      'the namespace extensions live in',
      [names, /^export const EXT_NS = (.+);$/m],
      [OWNER, /^export const EXT_NS = (.+);$/m],
    ],
    [
      'the account extension pods run as',
      [names, /^export const EXT_ACCOUNT = (.+);$/m],
      [OWNER, /^export const EXT_ACCOUNT = (.+);$/m],
    ],
    [
      'the binding that grants it',
      [names, /^export const EXT_ROLE_BINDING = (.+);$/m],
      [OWNER, /^export const EXT_ROLE_BINDING = (.+);$/m],
    ],
    [
      'the container a terminal execs into',
      [names, /^const EXT_CONTAINER = (.+);$/m],
      [OWNER, /^const EXT_CONTAINER = (.+);$/m],
    ],
    [
      'the image an extension pod runs',
      [names, /^const EXT_IMAGE = (.+);$/m],
      [OWNER, /^export const EXT_IMAGE = (.+);$/m],
    ],
    [
      'the port a dev server serves on',
      [names, /^const EXT_PORT = (.+);$/m],
      [OWNER, /^const EXT_PORT = (.+);$/m],
    ],
    [
      'the browser every extension is looked at in',
      [names, /^export const BROWSER_OBJECT = (.+);$/m],
      [OWNER, /^export const BROWSER_OBJECT = (.+);$/m],
    ],
    [
      'the port that browser answers CDP on',
      [names, /^const BROWSER_CDP_PORT = (.+);$/m],
      [OWNER, /^const BROWSER_CDP_PORT = (.+);$/m],
    ],
    [
      'the separator a tree path is flattened into a ConfigMap key with',
      [names, /^const PATH_SEPARATOR = (.+);$/m],
      [OWNER, /^export const PATH_SEPARATOR = (.+);$/m],
    ],
    [
      'the attributes a changed line can be found by',
      [path.join(pod, 'barn-provenance.mjs'), /^const SELECTABLE = (.+);$/m],
      [OWNER, /^const SELECTABLE_ATTR = (.+);$/m],
    ],
    [
      'the share of a viewport a highlight may cover',
      [capture, /^const MAX_REGION_SHARE = (.+);$/m],
      [regions, /^export const MAX_REGION_SHARE = (.+);$/m],
    ],
    [
      'how many highlights one page may carry',
      [capture, /^const MAX_REGIONS = (.+);$/m],
      [regions, /^const MAX_KEPT = (.+);$/m],
    ],
    [
      // The capture stamps this beside every set of rectangles it records; the evidence pane
      // compares what it reads against its own copy and re-measures anything older. If the two
      // drift apart, either every change set is re-measured for no reason or none of the stale
      // ones ever is - and both failures are silent, which is what this exists to prevent.
      'the geometry that rectangles beside a picture are measured in',
      [capture, /^const GEOMETRY_VERSION = (.+);$/m],
      [path.join(barn, 'components', 'studio', 'ChangeEvidence.vue'), /^const GEOMETRY_VERSION = (.+);$/m],
    ],
  ];

  for (const [what, [aFile, aPattern], [bFile, bPattern]] of pairs) {
    const a = sourceOf(aFile, aPattern, what);
    const b = sourceOf(bFile, bPattern, what);

    if (a !== b) {
      throw new Error(
        `${ what } has drifted: ${ path.basename(aFile) } says ${ a }, ${ path.basename(bFile) } says ${ b }`,
      );
    }
  }
}

/**
 * The objects, rendered by both sides and compared.
 *
 * Comparing the constants was not enough, and saying why is the point of this function. The
 * service builds an extension's Deployment from a pod, and the browser builds the same
 * Deployment from a page: two files, three hundred lines apart, agreeing field for field on
 * probes, the Recreate strategy, NODE_OPTIONS and a hostPath volume. A field added to one of
 * them produces a pod the other side would never have made, and the way that shows up is not a
 * failure - it is an extension that installs, runs, and behaves differently depending on which
 * half of the product created it.
 *
 * Both sides are pure functions of a name, so there is nothing to mock and nothing to arrange:
 * render them, and compare the JSON. A difference fails the seed generation, which is the
 * moment a person is already editing these files.
 */
async function checkBodiesInStep() {
  const barn = path.join(here, '..', 'pkg', 'extension-studio');
  const service = path.join(barn, 'extension-skeleton', 'pod', 'service');
  const browser = await import(path.join(barn, 'extensions.ts'));
  const browserInstall = await import(path.join(barn, 'install.ts'));
  const browserRegistry = await import(path.join(barn, 'api-registry.ts'));
  const pod = await import(path.join(service, 'bodies.mjs'));
  const podInstall = await import(path.join(service, 'install.mjs'));
  const podRegistry = await import(path.join(service, 'registry.mjs'));

  // A name that is obviously not real, so anything that leaks it into a cluster is findable.
  const NAME = 'drift-check';
  const object = browser.extensionObject(NAME);
  const pairs = [
    ['the Namespace', browser.namespaceBody(), pod.namespaceBody()],
    ['the ServiceAccount', browser.serviceAccountBody(), pod.serviceAccountBody()],
    ['the ClusterRoleBinding', browser.clusterRoleBindingBody(), pod.clusterRoleBindingBody()],
    ['an extension Service', browser.serviceBody(object, browser.EXT_PORTS), pod.serviceBody(object, pod.EXT_PORTS)],
    ['an extension Deployment', browser.deploymentBody(NAME), pod.deploymentBody(NAME)],
    // The registry has a writer on one side and a reader on the other, and they have to agree
    // about the object's name and about how an entry's two URL halves are joined.
    ['a registry object name', browserRegistry.apiRegistryObject(NAME), podRegistry.apiRegistryObject(NAME)],
    [
      'how an entry\'s url and docs are joined',
      browserRegistry.apiDocsUrl({ url: '/proxy/', docs: '/openapi.json' }),
      podRegistry.apiDocsUrl({ url: '/proxy/', docs: '/openapi.json' }),
    ],
  ];

  for (const [what, a, b] of pairs) {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      throw new Error(
        `${ what } has drifted between extensions.ts and pod/service/bodies.mjs:\n` +
        `  extensions.ts: ${ JSON.stringify(a) }\n` +
        `  bodies.mjs:    ${ JSON.stringify(b) }`,
      );
    }
  }

  // And that the two install lists agree about what each step is. The browser's list is longer -
  // it also makes the browser pod and this service - so every step the pod knows about has to
  // appear in it, addressing the same object.
  const wanted = new Map(browserInstall.installSteps(NAME).map((step) => [step.id, step]));

  for (const step of podInstall.installSteps(NAME)) {
    const other = wanted.get(step.id);

    if (!other) {
      throw new Error(`pod/service/install.mjs has a step "${ step.id }" that install.ts does not`);
    }

    const mine = JSON.stringify([step.type, step.namespace || null, step.name]);
    const theirs = JSON.stringify([other.type, other.namespace || null, other.name]);

    if (mine !== theirs) {
      throw new Error(`the "${ step.id }" step has drifted: install.ts says ${ theirs }, install.mjs says ${ mine }`);
    }
  }
}

checkInStep();

// The skeleton and the pod scripts, which every seed shares. Taken from the dev extension's
// directory because there is only one of each and it has to live somewhere.
const shared = {};

for (const f of ROOT_FILES) {
  shared[f] = fs.readFileSync(path.join(here, '..', 'pkg', 'extension-studio', 'extension-skeleton', f), 'utf8');
}

// The pod's files land at the root of the tree: boot.sh is the container's command and is
// read straight out of /seed, vue.config.js is seeded to /app alongside package.json.
const POD = path.join(here, '..', 'pkg', 'extension-studio', 'extension-skeleton', POD_DIR);

// The Studio's own API service, which lives under pod/ because it is a pod-side program like
// any other, and does NOT belong in an extension's seed.
//
// It was in it, briefly, and the cost was measurable: 77.5 KiB of every extension's ConfigMap
// and of this bundle, for source that boot.sh then refused to write, in every extension, for
// ever. It has one pod of its own and one ConfigMap of its own (pkg/extension-studio/service.ts),
// so it is emitted as its own file set and the extension seeds never see it.
const SERVICE_DIR = 'service';

/** Read one pod-side file, with the tokens this generator owns substituted into it. */
function podFile(clean) {
  let contents = fs.readFileSync(path.join(POD, clean), 'utf8');

  for (const [token, value] of Object.entries(SUBSTITUTIONS)) {
    contents = contents.split(token).join(value);
  }

  const leftover = contents.match(/__[A-Z_]+__/);

  if (leftover) {
    throw new Error(`${ clean } still has an unsubstituted token: ${ leftover[0] }`);
  }

  return contents;
}

// Recursive, because the pod directory is no longer flat: pod/skills/<name>/ holds
// the skills the pod's assistant is given. A ConfigMap key cannot contain a slash,
// so a nested path is flattened with the same separator the tree uses and boot.sh
// un-flattens it back under /seed - see the skills loop there.
const service = {};

for (const rel of walk(POD, '.')) {
  const clean = rel.replace(/^\.\//, '');
  const [head, ...rest] = clean.split('/');

  if (head === SERVICE_DIR) {
    // Flat already: the service's files sit beside each other at /seed and import each other
    // by name, so there is nothing to flatten and nothing to un-flatten.
    service[rest.join('/')] = podFile(clean);
    continue;
  }

  shared[clean.split('/').join(SEPARATOR)] = podFile(clean);
}

// One file set per package: the shared skeleton plus that package's own source.
const seeds = {};

for (const [id, spec] of Object.entries(PACKAGES)) {
  const root = path.join(here, '..', 'pkg', 'extension-studio', spec.app);
  const files = { ...shared };

  for (const f of walk(root, spec.pkg)) {
    files[f] = fs.readFileSync(path.join(root, f), 'utf8');
  }

  seeds[id] = files;
}

// What the extension imports as its default. `dev` stays the shape it was so nothing that
// reads SEED_FILES has to change.
const files = seeds.dev;

const header = `/* eslint-disable */
// GENERATED by scripts/gen-extension-seed.mjs - do not edit.
// Source of truth is pkg/extension-studio/extension-skeleton/ and pkg/extension-studio/base-extension/. Regenerate with:
//   node scripts/gen-extension-seed.mjs

export const SEEDS: Record<string, Record<string, string>> = `;

const footer = `
/** What a new extension is seeded from unless something else is asked for. */
export const SEED_FILES = SEEDS.dev;

/**
 * The Studio's own API service, which is not part of any extension's tree.
 *
 * Its own file set rather than a prefix inside every seed: it is mounted into one pod of its
 * own, so carrying it in each extension's ConfigMap meant every extension paying for source
 * that its boot script then declined to write. Read by pkg/extension-studio/service.ts.
 */
export const SERVICE_FILES: Record<string, string> = ${ JSON.stringify(service, null, 2) };
`;

fs.writeFileSync(OUT, `${ header }${ JSON.stringify(seeds, null, 2) };\n${ footer }`);

console.log(`service: ${ Object.keys(service).length } files, ${ (Buffer.byteLength(JSON.stringify(service)) / 1024).toFixed(1) } KiB`);


for (const [id, set] of Object.entries(seeds)) {
  console.log(`seed ${ id }: ${ Object.keys(set).length } files, ${ (Buffer.byteLength(JSON.stringify(set)) / 1024).toFixed(1) } KiB`);
}

console.log(`-> ${ path.relative(path.join(here, '..'), OUT) }`);

// After the write, not before it: this imports the extension's own TypeScript, and part of that
// tree imports the file this script generates. Checking first would mean a fresh checkout could
// never produce the file it needs in order to be checked.
await checkBodiesInStep();

// A ConfigMap tops out around 1 MiB, and each seed becomes one ConfigMap of its own, so the
// limit is per seed rather than on the total. Source only - node_modules is installed in the
// pod - so this should stay tiny, but fail here rather than when the extension tries to create
// the object in somebody's cluster.
for (const [id, set] of Object.entries(seeds)) {
  if (Buffer.byteLength(JSON.stringify(set)) > 900 * 1024) {
    console.error(`the ${ id } seed is too large for a ConfigMap`);
    process.exit(1);
  }
}
