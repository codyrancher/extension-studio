# Working on the Extension Studio: what you need before you start

Read this once. It is the environment, not the task. Your task comes separately.

## What the thing is

A Rancher UI extension called **barn** ("Extension Studio"), built to a Figma file
(`Xm3Q6WVin7U3cwMeOdGV6z`, "Rancher Extension Studio - AI Authoring (Concept)"). It lets someone
describe an extension in words, watch an AI agent build it in a pod, review the diff, and publish
it into the running Rancher.

Source: `/workspace/magic-closet/barn/pkg/barn`
Pages: `pages/*.vue` - one per Figma screen. Primitives: `components/ui/` (S-prefixed).
Pod/API layer: `extensions.ts`. Tokens: `design/studio.css`.

## Reaching the running app

Rancher: `https://magic-closet-rancher`, user `admin`.

**The password contains `&` and `*`.** Do not `source /workspace/.env` - the `&` backgrounds the
line and you get an empty password and a confusing failure. Read it literally:

```bash
export RANCHER_PASS=$(grep '^RANCHER_ADMIN_PASS=' /workspace/.env | cut -d= -f2-)
export NODE_TLS_REJECT_UNAUTHORIZED=0 CLAUDE_BROWSER_CDP=http://localhost:9222
```

**Never write the password into a file, a commit, a log line or a script default.** The committed
scripts read `RANCHER_PASS` from the environment and exit if it is absent. Keep it that way.

Sidecars may be down. `bash -ic 'wait-for-sidecars'` (interactive shell - the env vars only exist
there). Then drive the browser over CDP with `playwright-core`:

```js
import { chromium } from 'playwright-core';
import { login, RANCHER } from '/workspace/magic-closet/barn/scripts/design-check/login.mjs';
const browser = await chromium.connectOverCDP(process.env.CLAUDE_BROWSER_CDP);
const page = await browser.contexts()[0].newPage();   // ALWAYS a new page, never steal the user's tab
await page.setViewportSize({ width: 1440, height: 900 });
await login(page);
await page.goto(`${RANCHER}/dashboard/barn/extensions`, { waitUntil: 'domcontentloaded' });
// ... your work ...
await page.close();                                    // ALWAYS close it
```

## The screens and their routes

Prefix every route with `https://magic-closet-rancher/dashboard`.

| screen | route | ready selector |
|---|---|---|
| 01 home | `/barn/extensions` | `.studio-home__table` |
| 02 new | `/barn/extensions/new` | `.new-ext__card` |
| 03 workspace | `/barn/editor` | `.mc-editor` |
| 04 review | `/barn/extensions/base/review` | `.review__body` |
| 05 files | `/barn/extensions/base/files` | `.files__body` |
| 08 build failed | `/barn/extensions/base/build-failed` | `.failed__body` |
| 10 brief | `/barn/extensions/base/brief` | `.brief__columns` |
| 11 review queue | `/barn/review` | `.queue__list` |
| 12 review change | `/barn/review/base/working` | `.rc__body` |
| 13 verification | `/barn/extensions/base/verification` | `.verify__body` |

Screen 08 renders nothing without a recorded failure; seed
`sessionStorage['barn.publish.failure']` first (see `design-check/measure.mjs`).

`base` is the default extension, backed by a real pod in namespace `barn`. `kubectl` works.

## Rebuilding after a code change

```bash
cd /workspace/magic-closet/barn
yarn --ignore-engines build-pkg barn          # engines say node>=24, we have 20; the flag is required
cd scripts/design-check
node install-barn.mjs 0.5.22 https://172.19.0.5:8446/barn-0.5.22/barn-0.5.22.umd.min.js
```

The second command re-points the UIPlugin with a fresh cache-buster. **Skipping it means you
verify against the previous bundle** - webpack reuses chunk ids across builds, so a rebuilt
component goes on behaving like the old one. A static file server already runs on 8446 serving
`dist-pkg` from disk, so you do not need to restart it. If `build-pkg` bumps the version, use the
new number in both places.

After a reinstall the browser must reload the page for the new bundle to load.

## Checking your work

```bash
cd /workspace/magic-closet/barn/scripts/design-check
node measure.mjs spec.json "" measured.json && node check.mjs spec.json measured.json
# expect: 0 defects, 0 selectors missing, 450 properties checked
node probe-errors.mjs        # runtime console errors on all ten screens; expect ALL CLEAN
node verify-corruption.mjs   # data-integrity regression for screen 13; expect ALL PASS
```

A change that leaves any of those worse than it found them is not finished.

## House rules

- **No em dashes** anywhere: code, comments, commit messages, chat. Use a regular dash,
  parentheses, or split the sentence. This is a project rule and it is enforced.
- Match the surrounding code: Options API, scoped SCSS, `s-`/`S`-prefixed primitives, tokens from
  `design/studio.css` rather than literal colours.
- Reuse the primitives in `components/ui/` before writing a new component.
- Do not fake a feature. If the data cannot be had, say so plainly in the UI rather than showing
  a control that lies. Three claims were deleted this way already and that was the right call.

## Two traps that have already cost hours

- **CSS custom properties are substituted in the scope they are declared in.** The Studio's tokens
  live on `body`, not `:root`, because Rancher declares `--body-bg` and friends on `body`. Move
  them and dark mode silently freezes at the light fallback.
- **`data-testid` on a component falls through to its root element**, which may be a wrapper that
  does not forward attributes. Put test ids on the real control.

## Known environment condition: the preview browser pod is not Ready

`kubectl -n barn get pods` shows `barn-browser` as `0/1 Running`. Its readiness probe asks
`http://<pod>:9222/json/version` and gets EOF; it has failed roughly 6600 times over 17 hours.
The container itself is alive and streaming (its log shows an active H264 stream and audio
pipeline), so this is the CDP port not answering rather than a dead pod.

This predates the current work. If a feature you are verifying depends on the in-cluster preview
browser and you cannot get it to respond, that is very likely why: record `blocked`, say it was
this pod, and move on. Do not record `fail` for it - a broken probe in the environment is not a
defect in the Studio, and mixing the two makes the todo list lie.

## Use the dev server to iterate, the build to integrate

There are two loops and using the wrong one wastes most of your time.

**The fast loop, for changing something and looking at it.** One dev server runs for the whole
session at `http://localhost:8005`, serving a dashboard that proxies to the real Rancher. It
compiles incrementally and hot reloads, so an edit to a template or a computed shows up in seconds.

```bash
scripts/design-check/dev-server.sh status   # is it up, and how much memory
scripts/design-check/dev-server.sh start    # idempotent; refuses to start a second one
scripts/design-check/dev-server.sh log      # last 40 lines, including compile errors
```

Use it for everything iterative: does this render, does this handler fire, is the wiring right,
does my selector match. A compile error appears in the log within seconds, which is far faster
than finding it in a `build-pkg` five minutes later.

**The slow loop, for integration.** `build-pkg` plus `install-barn.mjs` produces the bundle a user
actually loads, and only that path exercises UIPlugin loading, the cache-buster and the
`direct: true` endpoint. Some defects only exist there - a `data-testid` that falls through to a
wrapper, a chunk id reused across builds, a route whose meta is stamped after the product
registers. **The orchestrator runs this**, once per wave, and verification happens against it.

So: iterate on `:8005`, and do not claim a feature works until it has been driven against the
installed bundle. Both statements matter. A change that works in the dev server and not in the
bundle is a real defect, and it has happened in this project more than once.

## Do not start your own dev server

**Run `dev-server.sh start`, never `yarn dev` directly.** The script exists because three raw dev
servers ran at once earlier in this project and took the container to 700MB free of 64GB, with swap
exhausted. Two of them were kept alive by `while true; do yarn dev; done` scripts, so killing the
server just spawned another - four rounds of that before the keeper itself was found.

The script starts exactly one, refuses if another is already running, caps the heap at 3GB, and has
no restart loop: if it dies it stays dead and you read the log. If you find a `vue-cli-service` it
does not own, say so rather than adding another.

## The nodehealth extension collides with base in the preview

`nodehealth` was created during an early demo, before screen 02 learned to write the extension's own
name into `product.ts`, so its source declared `PRODUCT_NAME = 'base'`. It therefore registers as the
`base` product and **hijacks `/base/c/*` in every live preview**: the page you see on that route may
be nodehealth's, not base's.

Its source in the pod is fixed. **The installed UIPlugin still carries the old bundle**, because
republishing means a multi-minute production build in a shared pod, so the collision persists at
runtime until somebody publishes it again.

What that means for you:

- Do not verify a live-preview feature on `/base/c/_/home`. Use a route of your own, or another
  extension. One verifier lost time to this before spotting it.
- If a preview shows content you did not expect, check whether you are looking at nodehealth.
- It is also a good demonstration of why the placement fix mattered: two extensions from one seed
  used to collide silently, and this is what that looks like from the outside.

## Undo is scoped to the most recently changed file

`undoLastChange` picks the most recently modified file in the working tree. In a pod with one author
that is the file you just changed. **In this pod, with several agents working at once, it is
whoever wrote last** - a verifier clicked Undo and removed another verifier's file.

That is correct behaviour for the product and a hazard for us. Before clicking Undo, check whose
file is at the top of the working tree, and prefer undoing something you can name.

## Read the verdict files with a JSON parser, not with grep

`verdicts/*.json` and `features.json` are large single-line-ish JSON documents. A `grep -o` or
`ugrep -o` with a loosely bounded pattern across all of them at once will try to materialise an
enormous match set: one such search reached **5.3GB of resident memory in 70 seconds** and took the
container from 4GB free to 569MB before it was killed.

Use a parser. It is faster, it cannot explode, and it gives you fields rather than fragments:

```bash
# every open item on one screen, with the verifier's reasoning
node -e "const d=require('./features.json');
  for (const f of d.features.filter(f => f.screen==='09-settings' && f.status!=='pass'))
    console.log(f.status.padEnd(16), f.id, '\n   ', f.defect || '')"

# what one verdict file said about one feature
node -e "const v=require('./verdicts/w4-review.json');
  console.log(v.verdicts.find(x => x.id==='12-change-pr-link'))"
```

`node todo.mjs <screen> --json` already does the common case. Reach for grep only on the source
tree, where the files are small and line-oriented.
