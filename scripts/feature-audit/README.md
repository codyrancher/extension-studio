# Auditing the Studio against every feature its design promises

The `design-check/` harness next door answers "is this box the right size". It cannot answer
"does this button do anything", and that turned out to be the more important question: recording
a video found four bugs that six rounds of measuring never did, because measuring never clicked
anything.

This directory is the answer to the second question. It enumerates every feature the Figma file
promises, drives each one against the running Rancher, and records a verdict.

## The pipeline

```
Figma frames  ->  raw/*.json  ->  features.json  ->  verdicts/*.json  ->  features.json
                  (extract)       (merge.mjs)        (verify)            (apply-verdicts.mjs)
                                                                                |
                                                                          todo.mjs
```

| file | what it is |
|---|---|
| `BRIEFING.md` | the environment: how to reach the app, rebuild it, and check your work. Every agent reads this first. |
| `raw/*.json` | one file per extraction agent, listing the features one or more Figma frames promise. |
| `merge.mjs` | folds `raw/` into `features.json`, dedupes ids, preserves verdicts already recorded. |
| `features.json` | the list. One entry per feature, carrying its Figma node, what the design promises, how to verify it, and its current status. |
| `verdicts/*.json` | one file per verification agent. Verifiers never write `features.json`. |
| `apply-verdicts.mjs` | the only writer of verdicts into `features.json`. |
| `todo.mjs` | prints everything that is not `pass`, worst first. `--json` for machines. |

## Why the fan-in is one writer

A dozen agents writing one JSON file is a lost-update bug with extra steps. Each agent owns
exactly one file that nobody else touches, and a single script folds them together. That also
means any stage can be re-run alone: re-extracting one screen cannot clobber another screen's
work, and re-merging preserves every verdict already recorded, matched by feature id.

## Statuses

- `unverified` - nobody has driven it yet
- `pass` - driven against the running app and it did what the design promises
- `fail` - driven, and it did not
- `not-implemented` - the control the design draws does not exist in the product at all
- `blocked` - could not be verified, with the reason in `defect` (a missing prerequisite, an
  environment problem). Blocked is not a pass and it is not a quiet failure; it means the
  question is still open.

## What counts as a pass

Not "the button exists" and not "clicking it does not throw". A pass means the thing the design
promises actually happened and can be seen to have happened: the row really filtered, the file
really wrote into the pod, the mark really survived a reload. A verifier that cannot demonstrate
the effect records `fail` or `blocked` and says which.

The bar is deliberately higher than "looks right", because "looks right" is exactly what the
measuring harness already certified while the publish button was unaddressable, every new
extension kept its seed's name, and four screens were reading from a git repository that did not
exist.
