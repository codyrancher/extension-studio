# Defects found by more than one verifier

These were reported independently from different screens, which is the strongest signal the audit
produces: two agents driving different parts of the product arrived at the same root cause. They
are also the ones that fall between the per-screen implementers, so the orchestrator owns them.

## 1. Navigation pushes Rancher's home route instead of the extension list

Reported from `01-home-breadcrumb-extensions` and `07-publish-back`.

`pages/extensions.vue:511` and the masthead back binding in `pages/editor.vue` both push
`{ name: 'home' }`, which is Rancher's home page.

**Correction.** This entry originally said both should push `STUDIO_ROUTE`, and that was wrong for
half of it. The two are not the same defect:

- The **masthead back arrow** in `editor.vue` is on `/barn/editor` and should return to the
  extension list, so `STUDIO_ROUTE` is right.
- The **breadcrumb** in `extensions.vue` sits ON `/barn/extensions` and reads "Extensions > Studio",
  so `STUDIO_ROUTE` would navigate to the page you are already standing on. It should go up to
  Rancher's own Extensions page, `c-cluster-uiplugins`, which is what the feature's `promise`, its
  `howToVerify` and the verifier's `defect` all say.

Merging them into one entry here is what produced the wrong instruction. The implementer who owned
`extensions.vue` noticed, did the right thing instead of what it was told, and said so.

This is the same class of bug as the eleven dead navigation buttons found earlier: a route name
that does not mean what the code assumes, failing quietly.

## 2. The nav rail loses its selected state on every barn route but one

Reported from `11-queue-nav-rail` and `07-publish-nav-extensions`.

The product's nav entry is an exact router-link to `STUDIO_ROUTE`, so the rail item highlights on
`/barn/extensions` and nowhere else. Every other barn screen renders with no section marked
current.

## 3. The preview viewport chip does nothing

Reported from `07-publish-preview-viewport`.

`PreviewPanel`'s `frameStyle` sets an inline width for Desktop/Tablet/Mobile, but
`.preview-panel__frame` also carries `flex: 1 1 auto`, so flex-grow expands the frame back to the
full canvas and the width is ignored. Measured 970px in all three states. Needs `flex-grow: 0`
when a fixed width is applied.

Only one verifier reached this one, but it is included here because it is a whole control that
appears to work and does not.

## 4. The brief screen silently destroys the brief

Found by the screen 13 verifier, confirmed by reading `pages/brief.vue`. This is the worst defect
the audit has turned up, because it is silent data loss of a document three other screens depend
on.

`brief.vue` never reads `BRIEF.md`. Its `mounted()` prefills the form from the route query - what
screen 02 collected at creation time - and nothing else:

```js
this.problem = this.outcome || this.handed;
this.changes = this.handed;
```

`agree()` then writes the whole form over the file:

```js
await writeExtensionFile(this.extension, 'BRIEF.md', this.briefMarkdown());
```

So opening the brief for an extension that already has one shows a form that does not contain it,
and agreeing replaces the real document with that form. What is destroyed is not just prose: the
acceptance criteria under `## How we will know it worked` are the same objects screen 12 renders
and screen 13 walks and records verdicts against, so one click of Agree drops the criteria, every
recorded verdict, and the review packet's link to what was promised.

The screen 13 verifier reached this from the other direction: "Open the brief" from the
verification screen lands on a blank authoring form.

The fix is to read `BRIEF.md` on mount and parse it back into the form, falling back to the query
prefill only when the file does not exist. Until that lands, agreeing a brief a second time is
destructive, so it is the first thing the implementation loop does.

## 5. Query parameters handed over and read by nothing

A class, not a bug. Three screens push a route with a query parameter carrying an instruction, and
no screen reads it. The navigation happens, so each control looks like it worked.

| from | parameter | what it was meant to carry |
|---|---|---|
| `pages/brief.vue` | `?brief=1` | the workspace picking the brief up and giving it to the assistant as the session's first instruction |
| `pages/review.vue` | `?publish=local` | publishing after the review |
| `pages/build-failed.vue` | `?publish=local` | "Try the publish again" |

Two verifiers found two of these independently from different screens, which is what made it a
pattern rather than three separate oversights. The build-failed one is the sharpest: "Try the
publish again" retries nothing, it lands you on the workspace having cleared the failure record,
so the failure is gone from the UI and the build was never re-run.

`tests/dead-handoffs.mjs` now guards the class. It collects every key written into a `query:` on a
router push and every key read from `$route.query`, and fails on any key written and never read.
No browser, about a second. The `ALLOWED` map at the top is deliberately empty: a handoff nobody
reads is nearly always a feature that was never finished, so the bar for adding an exemption is a
written reason.

## Rule while the audit is running

**Do not rebuild or reinstall the bundle while verifiers are driving the app.** Reinstalling
re-points the UIPlugin and busts the cache, so a verifier mid-run would be reading a different
build than the one it started against, and its verdicts would describe neither. Fixes wait for
the wave to finish.
