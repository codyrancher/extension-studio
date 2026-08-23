# How to verify a screen

You are given one screen. Every feature on it is listed in `features.json`. Your job is to find
out, by driving the real application, which of them actually do what the design promises.

Read `BRIEFING.md` first. It has the URLs, the login, the password trap, and how to rebuild.

## Get your slice of the list

```bash
cd /workspace/magic-closet/barn/scripts/feature-audit
node -e "
const d=require('./features.json');
for (const f of d.features.filter(f=>f.screen===process.argv[1]))
  console.log(JSON.stringify({id:f.id,name:f.name,kind:f.kind,promise:f.promise,howToVerify:f.howToVerify}));
" <your-screen-key>
```

## Drive it

One browser session, one login, all your features. Always `ctx.newPage()`, never steal the user's
tab, and always `page.close()` when you are done.

Write yourself a script under
`/tmp/claude-1000/-workspace/ac9b64f7-2a05-49e6-a23f-840e9655eaa0/scratchpad/verify-<screen>.mjs`
and iterate on it. A script you can re-run is worth far more than a sequence of one-off `eval`
calls, because you will want to re-run it after somebody fixes something.

## The bar for a pass

**A pass means the promised effect happened and you saw it happen.**

Not "the element exists". Not "clicking it did not throw". Those were both true of the publish
button that could not be addressed, of the extensions that all silently published under the
wrong name, and of four screens reading a git repository that did not exist. The measuring
harness certified all of it as clean.

So for each feature, ask what would be observably different if it worked, and then look for that:

| kind | what to actually check |
|---|---|
| input / textarea | type into it, then confirm the thing it filters or saves really changed. Reload and confirm what should persist did. |
| button | click it, then confirm the effect: a route change, a request, a file written in the pod, a row gone. |
| checkbox / toggle / radio | set it, confirm the effect, unset it, confirm the effect reverses. |
| sort | click the header, read the column values out of the DOM, confirm they are ordered - and that clicking again reverses. Confirm it sorts on the real value, not the rendered string ("10 minutes ago" sorts before "2 hours ago" only if it is sorting on a timestamp). |
| filter / search | confirm rows that should match survive AND rows that should not are gone. A filter that never removes anything passes a careless check. |
| menu | open it, confirm every item is present, click each one, confirm each does its thing. |
| tab | switch to it, confirm the content actually changed and the selected state moved. |
| navigation | click it, confirm the URL and the rendered screen. A `$router.push` with an undefined route name fails silently and looks like nothing happened. |
| select | change it, confirm the dependent content changed. |
| keyboard | send the real key to the real focused element. |
| display | confirm it shows the true value, not a placeholder. Cross-check against the pod or the API where you can. |

**Where the truth lives.** Much of this screen is backed by a real pod in namespace `barn`. If a
feature claims to write a file, commit, snapshot or publish, go and look:
`kubectl -n barn exec deploy/barn-base-extension -- sh -c '...'`. The UI saying it worked is not
evidence that it worked.

## Recording a verdict

Write `verdicts/<your-screen-key>.json`. Nothing else writes it; do not touch `features.json`.

```json
{
  "screen": "01-home",
  "verdicts": [
    {
      "id": "01-home-search",
      "status": "pass",
      "evidence": "Typed 'node' into the search field: 4 rows before, 1 after, and the surviving row was nodehealth. Cleared it and all 4 came back.",
      "defect": null
    },
    {
      "id": "01-home-sort-changed",
      "status": "fail",
      "evidence": "Clicked the 'Last changed' header. Row order did not change. Read data-sort attributes: all absent.",
      "defect": "The column header is not clickable at all - no @click and no sort state. The design draws a sort affordance on it."
    }
  ]
}
```

`status` is one of:

- **`pass`** - you saw the promised effect.
- **`fail`** - you drove it and the promise did not hold. `defect` says what actually happened,
  precisely enough that someone can fix it without re-deriving your work.
- **`not-implemented`** - the control the design draws is not in the product at all. Say what you
  searched for (selector, and the grep you ran over `pkg/barn`) so the next person does not
  repeat it.
- **`blocked`** - you could not find out. Say why. Blocked is not a soft pass; it means the
  question is still open. Use it for a missing prerequisite or an environment fault (see the
  `barn-browser` note in the briefing), never for "I ran out of time".

**`evidence` is required on every verdict, including passes.** One or two sentences of what you
did and what you observed. A pass with no evidence is indistinguishable from a guess, and this
list is going to drive somebody's work.

## Do not fix anything

You are verifying, not implementing. If you find a one-line fix, record it in `defect` and leave
the code alone. Somebody else is going to work through the todo list, and a verifier that also
edits makes it impossible to tell which verdicts were about the code as it stood.

## When you finish

Return ONLY: the path you wrote, and a count by status. Nothing else.

## You are not alone on this machine

Several verifiers run at once, against one Rancher, one browser and one `base` extension pod.
Nothing about the environment is yours exclusively. Three rules follow, and ignoring them
produces verdicts that are wrong rather than merely late:

**1. Key every effect to yourself.** When a feature writes something, make what it writes unique
to you: a file named `verify-<your-screen-key>.txt`, a commit message containing your screen key,
a search term that only matches a row you created. Then "the file appeared" is evidence about
your click and not about somebody else's. Never verify by counting rows and expecting the count
to hold still - another agent may add one between your two reads.

**2. Put back what you disturb.** Before you touch the working tree, record where it was:

```bash
kubectl -n barn exec deploy/barn-base-extension -- sh -c 'cd /app/pkg/*/ && git rev-parse HEAD && git status --porcelain | head -40'
```

Afterwards, restore anything you added that a later verifier would trip over. Leave the tree
roughly as you found it. If you cannot restore it, say so in your return message so it can be
fixed before the next wave.

**3. Do not run the destructive ones casually.** "Discard all changes", "Roll back to the last
working build", "Publish", and anything that deletes an extension will pull the ground out from
under every other agent. For those: read the code to establish what the control is wired to,
drive it only if you can do it against something you created yourself, and if you cannot verify
it safely record `blocked` with the reason. A `blocked` on a destructive action is a better
outcome than a `pass` bought by wrecking four other verifications.

**One page, opened once and reused.** `ctx.newPage()` at the start of your script, `page.close()`
in a `finally` at the end, and `page.goto()` between checks. Do not use `contexts()[0].pages()[0]` -
that is somebody's live tab, possibly a human's.

Reuse matters more than closing. "Close what you open" is easy to agree with and easy to lose to an
exception, and a page per check adds up fast: with five agents running, 35 pages were open at once,
which is around six each. The browser sidecar has already become unresponsive once in this project
with a number like that, and when it goes it takes every agent's run with it, not just the one that
leaked.

So write your script as one page driven through many navigations:

```js
const page = await ctx.newPage();

try {
  for (const [name, route, ready] of CHECKS) {
    await page.goto(`${ RANCHER }/dashboard${ route }`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(ready, { timeout: 45000 }).catch(() => {});
    // ... assert ...
  }
} finally {
  await page.close();
}
```

If you genuinely need a second page (comparing two screens side by side, or a popup), take it and
close it as soon as the comparison is done, rather than at the end of the run.
