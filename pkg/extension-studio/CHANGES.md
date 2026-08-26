# The Extension Studio

Fourteen screens built to the Figma concept ("Rancher Extension Studio - AI Authoring",
`Xm3Q6WVin7U3cwMeOdGV6z`), on a design system taken from its Foundations page, verified against
the running product rather than against the source.

## How to check it still matches

`scripts/design-check/` holds the harness and its README. Three things, in order of how much
they catch:

1. `probe-errors.mjs` - loads every screen, fails on any uncaught runtime error.
2. `verify-corruption.mjs` and `probe-defer.mjs` - behavioural regression tests.
3. `measure.mjs` + `check.mjs` - 450 computed properties against Figma node values.

The order is deliberate. Everything that actually mattered in building this was found by the
first two; the third finds padding.

## What is real, and what is not

Every control does something. There are no placeholder toasts left, and `toastNotYet` has been
deleted so that adding one takes a deliberate act.

Three things the design asks for were **removed** rather than built, because the product cannot
honestly back them:

- **Send questions to the requester.** There is no requester: no ticket, no reporter, no
  messaging. Every substitute was a different feature wearing this one's label.
- **Waiting on others.** A review filter that can never match, with a hardcoded zero beside two
  live counts. What it was really saying is a property of the whole screen, so it moved to the
  lede.
- **Ask before each file edit.** The chip claimed edits were gated. The pod runs claude with
  `--dangerously-skip-permissions`, so this was the opposite of the truth with no switch behind
  it. It now says edits apply without asking.

Two the design draws that are **still gaps**, and they are not the same size.

The **activity stream** on screen 03 is the real one. The design shows the assistant's work as
turns with steps and durations; what runs in the pod is claude in a terminal, and its output is
a stream of ANSI, not a structure. `ActivityTurn` is built and the panel renders it the moment
it is handed turns, so the missing piece is precisely a parser for the CLI's output. Until that
exists the tab says so and offers the terminal, which is the thing that actually works. This is
the one surface in the extension whose data never arrives.

The **scope-drift card** is the small one: it exists and computes one honest thing - terms from
the brief's own "what we are deliberately not doing", looked for in the lines the diff adds -
where the frame draws a richer form.

Two gaps listed here in an earlier draft have since been closed and the note was left stale:
screen 12 groups files by directory with a per-group count, and screen 04 shows per-file line
counts. Both are in the code and in the videos.

## Where this departs from the frame, deliberately

- **Status fills take `#0E0E12`, not white.** All five failed WCAG AA for normal text at white,
  the worst at 2.78:1, and 12px/600 is normal text. Not extended to primary and danger buttons:
  those are host chrome, Rancher ships white-on-green, and dark ink there would read as broken.
- **Screen 13 has a fourth verdict state** the frame never draws, because none of its four
  sample criteria uses it. The rule was legible from the three that are answered.
- **The border and text tiers are derived, not borrowed.** Rancher Prime lends one `#dcdee7`
  where the design has three border tiers and one `#6f6f8b` where it has two greys, so the
  tiers are mixed off the shell's own variables with `color-mix()`. The design's relationships
  survive a retheme; its literals would not.

Each is recorded in `spec.json`'s `unexpressible` block with its reasoning, so a clean run does
not quietly mean "we gave up on that one".
