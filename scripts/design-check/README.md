# Checking the Studio against its Figma file

The Extension Studio screens are built to a Figma document ("Rancher Extension Studio — AI
Authoring (Concept)", file key `Xm3Q6WVin7U3cwMeOdGV6z`). This directory is how you find out
whether they still match it.

## Why it is not screenshots

A screenshot tells you something looks wrong. It cannot tell you a gap is 10px where the design
says 12, and that is most of what drifts. So this measures: it loads each screen in a real
browser, reads the computed box off named elements, and diffs the numbers against expectations
taken from the Figma nodes.

## The three pieces

| file | what it is |
|---|---|
| `spec.json` | the expectations. One entry per selector per screen, each carrying a `from` field naming the Figma node it came from. |
| `measure.mjs` | loads every screen, dumps padding, gap, font, colour, border, radius, size, flex direction and alignment into `measured.json`. |
| `check.mjs` | diffs the two and prints one line per disagreement. |

```
export RANCHER_URL=https://your-rancher      # defaults to https://magic-closet-rancher
export RANCHER_PASS=...                      # no default; the scripts refuse to run without it
export NODE_TLS_REJECT_UNAUTHORIZED=0        # Rancher's certificate is self-signed
export CLAUDE_BROWSER_CDP=http://localhost:9222

node measure.mjs spec.json "" measured.json
node check.mjs spec.json measured.json
```

`install-barn.mjs` and `serve-pkg.mjs` are how the built bundle gets into a Rancher to be
measured: serve `dist-pkg` over HTTPS, then register it as a `UIPlugin` pointing at that URL.
The UIPlugin needs the `catalog.cattle.io/ui-extensions-version` annotation from the package's
own `rancher.annotations` — without it the dashboard installs the plugin, reports it Ready, and
silently never loads it.

## Reading the output

Each line names the screen, the selector, the property, expected versus measured, and the Figma
node behind the expectation — so a disagreement can be settled at the source rather than argued
about.

`spec.json` also has an `unexpressible` block at the top. That is for things deliberately not
checked, each with a reason: a value the harness cannot see, or one where the design has been
knowingly departed from. An expectation that can never pass is noise, and noise is how a real
defect gets missed.

## Things this harness has been wrong about

Worth reading before you trust a clean run.

- **It matched sizes with a ±1px tolerance.** That made every 1px expectation a no-op, and it
  reported a clean run while a segmented control was 2px too wide, overflowing into a scroll
  container and clipping itself on click. Tolerance removed; sizes now compare on the rounded
  pixel.
- **It measured whatever theme the browser was last left in.** The dark-mode probe persists
  `theme: dark` in a shared profile, so a run after it read dark colours against a light-mode
  spec and invented three colour defects. Both `measure.mjs` and `capture-real.mjs` now pin the
  theme before reading.
- **Its expectations have been wrong.** Four were wrong in one pass: a padding invented from
  nothing that the app then matched, a masthead padding wrong in both spec and app so nothing
  flagged it, and two citations pointing at the wrong node. Check the `from` node when a
  disagreement looks surprising; the spec is not the design.

## The runtime error sweep

`probe-errors.mjs` loads every screen and fails on any uncaught error. It exists because of a
specific failure this project hit twice: a control wired to a symbol that is not there at
runtime. An import that lands in the wrong block gives you `X is not a function`, thrown
*synchronously* - so it goes around any `.catch` and aborts the whole load. The screen still
renders, still measures clean, and is empty. Neither the measuring harness nor a static pass
found it; watching the browser console did.

Run it after any change that touches imports or adds a control:

```
node probe-errors.mjs      # ALL CLEAN, or one line per screen with the error
```

`verify-corruption.mjs` and `probe-defer.mjs` are the two behavioural regression tests: the
first plants decoy checkboxes in a brief and proves the verification screen writes verdicts to
the right lines, the second drives a review deferral end to end. Both restore what they touch.

## What it cannot do

It measures boxes. It cannot tell you a control is a reset button when it should be a verdict,
that a save writes to the wrong lines of a file, or that a label claims somebody looked at
something nobody looked at. Every one of those was found by driving the UI and reading the
result, not by measuring it. A clean run means "clean against what we currently know to look
at" — not "correct".
