# How to work the todo list

You are given a set of features on one screen that a verifier drove and found wanting. Your job
is to make them do what the design promises, and to leave the rest of the product exactly as you
found it.

Read `BRIEFING.md` first. It has the environment, the rebuild loop, the house rules, and the two
CSS traps.

## Get your work

```bash
cd /workspace/magic-closet/barn/scripts/feature-audit
node todo.mjs <your-screen-key>
node todo.mjs <your-screen-key> --json     # full detail: promise, howToVerify, defect, evidence
```

Each entry carries the verifier's `defect` and `evidence`. Read both. The evidence tells you what
they actually observed, which is usually more precise than the defect summary, and occasionally
tells you the defect is misdiagnosed.

## The order to work in

1. **`not-implemented` first, but read before you build.** The control may exist under a different
   name, or the product may solve the same need a different way. Grep for the concept, not just
   the label. Building a second way to do something the product already does is worse than
   leaving the gap.
2. **`fail` next.** Most of these are small: a handler that was never wired, a sort comparing
   rendered strings, a route name that resolves to `undefined`.
3. **`blocked` last, and often not at all.** A blocked verdict usually means an environment fault,
   not a defect. Fix it only if the block is in the product.

## What "implemented perfectly" has to mean here

The verifier who checks your work will not accept "the control exists". They will drive it and
look for the promised effect, then reload and look again. So:

- **Wire it to something real.** This product's whole discipline is that it does not fake. If the
  data cannot be had, say so plainly in the UI rather than shipping a control that lies. Three
  claims were deleted on exactly this ground and that was the right call. If you conclude a
  feature cannot be honestly backed, do not implement a fake: record why in your return message
  and leave it.
- **Make it survive a reload.** State that lives only in a component is state the user loses.
  Where the design implies persistence, persist it (the pod's git config, a Secret, a file in the
  extension, `sessionStorage` only where the loss is genuinely fine).
- **Make it addressable.** Put a `data-testid` on the real control, not on a wrapper component
  that may not forward attributes. The publish button was untestable for exactly this reason.
- **Match the surrounding code.** Options API, scoped SCSS, the `S`-prefixed primitives in
  `components/ui/`, tokens from `design/studio.css` rather than literal colours. Reuse a
  primitive before writing a component.

## Before you hand back

```bash
cd /workspace/magic-closet/barn
yarn --ignore-engines build-pkg barn
cd scripts/design-check
node install-barn.mjs 0.5.22 https://172.19.0.5:8446/barn-0.5.22/barn-0.5.22.umd.min.js
node measure.mjs spec.json "" measured.json && node check.mjs spec.json measured.json
node probe-errors.mjs
node verify-corruption.mjs
```

Expected: `0 defects`, `ALL CLEAN`, `ALL PASS`. **A change that leaves any of those worse than it
found them is not finished**, and the verifier will bounce it back. If `build-pkg` bumps the
version, use the new number in the install command and say so in your return message.

Then drive your own change in the browser once, yourself. Do not hand back work you have not
seen run. The last round produced a fix that shipped with the import in the wrong block, threw
synchronously past the `.catch`, and blanked four screens; it measured clean, because measuring
never loads the page the way a user does.

## Do not

- Do not touch features outside your screen. Another implementer is working next to you.
- Do not "improve" things nobody asked about. Scope creep in a parallel fan-out produces conflicts
  that are hard to attribute.
- Do not edit `features.json` or anything under `verdicts/`. Those belong to the verifiers.
- Do not commit. The orchestrator commits, once, when a screen is signed off.

## When you finish

Return:
1. The feature ids you fixed, one line each, saying what you changed.
2. The ids you deliberately did NOT fix, with the reason. "Cannot be honestly backed" is a
   legitimate and useful answer; say what data was missing.
3. The result of the three checks above.
4. Anything you noticed that is wrong but outside your scope, so it can be routed properly.

---

# Wave mode: you are one of six implementers running at once

The loop runs in waves. Six implementers edit source concurrently, the orchestrator builds ONCE,
then six verifiers drive the result. Two rules follow from there and they override the build
instructions above.

## 1. Do not build, and do not install

There is one bundle and one Rancher. If you run `build-pkg` or `install-barn.mjs` while five other
implementers are mid-edit, you ship everybody's half-finished work into the running instance and
every verification after that describes a build nobody wrote. **The orchestrator builds when the
wave completes.**

You can still check your work without building:
- `yarn type-check` from `/workspace/magic-closet/barn` (slow, whole repo, but it is read-only)
- Unit-test any pure logic you add by lifting it into a scratch `.mjs` and running it against real
  data. The two fixes that opened this loop were both caught this way: the brief parser looked
  right and returned an empty criteria array against the real file.
- Read the pod's real state with `kubectl -n barn exec deploy/barn-base-extension -- sh -c '...'`
  to confirm your assumptions about what the data looks like.

If your change is pure logic, a scratch test against real data is worth more than a browser pass.
If it is a rendering change, say so in your return message so the verifier knows to look.

## 2. You own your files. Do not touch anyone else's

Your prompt names the files you own. The other five own theirs. Overlap is how a wave turns into a
merge conflict nobody asked for.

`pkg/barn/extensions.ts` is shared by everyone. Editing it is allowed and often necessary, but:
- **Add a new function rather than changing an existing one** where you have the choice. Another
  implementer may be depending on the current behaviour of what you are about to change.
- If you must change an existing exported function, **say so prominently in your return message**,
  naming the function and what changed, so the orchestrator can tell whether it broke somebody.
- Never reformat, reorder or "tidy" that file. A whitespace change across a file five other agents
  are editing produces conflicts out of nothing.

The same goes for `design/studio.css` and anything in `components/ui/`: additive changes only, and
report them.

## 3. What the verifier will do to your work

After the build, a verifier drives every feature you were given, against the running app, and holds
it to the bar in `VERIFYING.md`: the promised effect has to happen and be observable, and state that
should persist has to survive a reload. It will not accept "the control exists".

If it bounces an item back, you get the item again with fresh evidence, and the loop continues until
it passes or until you establish that it cannot be honestly backed. **"Cannot be honestly backed" is
a legitimate end state** - say what data was missing and what you would need. It is a better outcome
than a control that lies, and three such claims were deleted from this product for exactly that
reason.
