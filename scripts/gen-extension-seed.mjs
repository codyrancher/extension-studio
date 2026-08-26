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
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(here, '..', 'pkg', 'barn', 'extension-skeleton');
const OWNER = path.join(here, '..', 'pkg', 'barn', 'extensions.ts');
const OUT = path.join(here, '..', 'pkg', 'barn', 'extension-seed.generated.ts');

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
 * pkg/barn, and pkg/barn cannot import it either - `barn-provenance.mjs` opens with node:fs
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

  return match[1].trim();
}

function checkInStep() {
  const barn = path.join(here, '..', 'pkg', 'barn');
  const pod = path.join(barn, 'extension-skeleton', 'pod');
  const capture = path.join(pod, 'skills', 'barn-screenshot', 'screenshot.mjs');
  const regions = path.join(barn, 'change-regions.ts');
  const pairs = [
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

checkInStep();

// The skeleton and the pod scripts, which every seed shares. Taken from the dev extension's
// directory because there is only one of each and it has to live somewhere.
const shared = {};

for (const f of ROOT_FILES) {
  shared[f] = fs.readFileSync(path.join(here, '..', 'pkg', 'barn', 'extension-skeleton', f), 'utf8');
}

// The pod's files land at the root of the tree: boot.sh is the container's command and is
// read straight out of /seed, vue.config.js is seeded to /app alongside package.json.
const POD = path.join(here, '..', 'pkg', 'barn', 'extension-skeleton', POD_DIR);

// Recursive, because the pod directory is no longer flat: pod/skills/<name>/ holds
// the skills the pod's assistant is given. A ConfigMap key cannot contain a slash,
// so a nested path is flattened with the same separator the tree uses and boot.sh
// un-flattens it back under /seed - see the skills loop there.
for (const rel of walk(POD, '.')) {
  const clean = rel.replace(/^\.\//, '');
  let contents = fs.readFileSync(path.join(POD, clean), 'utf8');

  for (const [token, value] of Object.entries(SUBSTITUTIONS)) {
    contents = contents.split(token).join(value);
  }

  const leftover = contents.match(/__[A-Z_]+__/);

  if (leftover) {
    throw new Error(`${ clean } still has an unsubstituted token: ${ leftover[0] }`);
  }

  shared[clean.split('/').join(SEPARATOR)] = contents;
}

// One file set per package: the shared skeleton plus that package's own source.
const seeds = {};

for (const [id, spec] of Object.entries(PACKAGES)) {
  const root = path.join(here, '..', 'pkg', 'barn', spec.app);
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
// Source of truth is pkg/barn/extension-skeleton/ and pkg/barn/base-extension/. Regenerate with:
//   node scripts/gen-extension-seed.mjs

export const SEEDS: Record<string, Record<string, string>> = `;

const footer = `
/** What a new extension is seeded from unless something else is asked for. */
export const SEED_FILES = SEEDS.dev;
`;

fs.writeFileSync(OUT, `${ header }${ JSON.stringify(seeds, null, 2) };\n${ footer }`);


for (const [id, set] of Object.entries(seeds)) {
  console.log(`seed ${ id }: ${ Object.keys(set).length } files, ${ (Buffer.byteLength(JSON.stringify(set)) / 1024).toFixed(1) } KiB`);
}

console.log(`-> ${ path.relative(path.join(here, '..'), OUT) }`);

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
