# The review system: where the state lives

A design for the twelve failing and three not-implemented cross-screen rules, which are one
missing subsystem rather than twelve missing controls. Written before any of it is built, so that
four screens do not each invent their own answer.

Read with `INTENT.md` section 5 (the cross-screen rules) and the verifier evidence in
`node todo.mjs 00-cross-screen --json`.

---

## The model, in one paragraph

Everything a reviewer reads about *the code* lives in the pod's git repository, because that is
the only store that already moves with the code, already survives a pod restart on the hostPath,
and already leaves the cluster when the extension is pushed. Everything about *people and their
decisions* lives in one Kubernetes ConfigMap per extension, `barn-review-<extension>` in namespace
`barn`, because sign-offs must be readable by the queue without an exec into every pod, must
outlive the pod that happens to be serving the extension today, and must be attributable to a
Rancher principal that the pod knows nothing about. The two halves meet at one object, the
**packet**: a git ref, `refs/barn/packets/<n>`, created at the push, carrying a collapsed diff
against `refs/barn/published/oci`, a git note holding the prompt provenance for the lines in it,
and the brief that was in the tree when it was made. The packet number is what the review record
signs, what the queue lists, and what the `:change` route parameter already has a slot for. The
gate is one boundary with two halves at the same function call: entering it (the push) assembles
the packet and produces the pull request, and leaving it (the distribution to OCI) is refused by
`assertGateOpen()` until two different principals have signed the two different questions against
that packet number.

---

## Where each kind of state lives

`<pkg>` is the package directory the pod resolves as `PACKAGE_DIR` (`ls -d /app/pkg/*/ | head -1`).
"hostPath" means `/app` on the node, `hostCachePath(name)`, which survives a pod restart and dies
with the node. "etcd" means a real Kubernetes object and survives everything short of the cluster.

| state | where it lives | written by | read by | survives what |
|---|---|---|---|---|
| The brief, its non-goals, its acceptance criteria | `BRIEF.md` in `<pkg>`, git-tracked | `brief.vue` `agree()` via `writeExtensionFile()` | `review-change.vue`, `verification.vue`, `assemblePacket()` | pod restart, commits, the GitHub push. Dies with the node |
| Who asked for the change (new front-matter field in the brief) | `BRIEF.md`, `## Who asked` holding a principal id | `new-extension.vue` submit and `brief.vue` | `signOutcome()`, screen 13 | as above |
| The prompt log: one record per assistant turn and per file the turn's tools touched | `/app/.barn/provenance.jsonl` in the pod, deliberately outside the repo | claude hooks `UserPromptSubmit` and `PostToolUse` (new `/seed/barn-provenance.mjs`) | `assemblePacket()` | pod restart. Never appears in `git status`, so it cannot pollute a diff |
| The current turn marker, so a tool call can be joined to the prompt that caused it | `/app/.barn/turn/<claude session id>` | the `UserPromptSubmit` hook | the `PostToolUse` hook | the turn. Deleted by the `Stop` hook |
| Where a prompt came from (which screen, which Rancher principal) | `/app/.barn/origin`, consumed once | `askAssistant()` immediately before the `tmux send-keys` | the `UserPromptSubmit` hook | one prompt |
| Turn to code attribution | commits on the branch carrying `Barn-Turn:`, `Barn-Session:`, `Barn-Origin:` and `Barn-Principal:` trailers, one per assistant turn | the `Stop` hook, in the pod | `git blame` at packet assembly | everything git survives, including the push to GitHub |
| The resolved per-hunk provenance index for one packet | git note in `refs/notes/barn-provenance` on the packet commit | `assemblePacket()` | `review-change.vue` | git. Pushed only if asked for, so it does not bloat every fetch |
| The last version other people could install | `refs/barn/published/oci` | `distributeExtension()` | `baselineRef()`, which every diff call routes through | git, per clone. Recreated on the next distribution if lost |
| The last version this Rancher loads | `refs/barn/published/local` | `publishExtension()` after `upsertUiPlugin()` succeeds | `baselineRef()` when there is no OCI baseline, and screen 01 | as above |
| The packet: the thing handed over | `refs/barn/packets/<n>` plus branch `barn/<extension>/<n>` | `assemblePacket()` | queue, screen 12, screen 07, the PR | git, and GitHub once pushed |
| Both sign-offs, their verdicts, notes, timestamps and signer principals | ConfigMap `barn-review-<extension>`, key `review.json`, `signoffs.code` and `signoffs.outcome` | `signCodeReview()` from screen 12, `signOutcome()` from screen 13 | `gateState()`, screen 07, the queue, the PR mirror | pod deletion, extension re-creation, node loss. etcd |
| Per-reviewer "since your last look" | the same document, `looks[<principal hash>] = { packet, sha, at }` | `markLook()` when a reviewer opens a packet | the queue banner and the screen 12 filter | etcd |
| Reviewer comments, and whether each was sent to the assistant | the same document, `comments[]` with `{ id, packet, file, hunk, text, principal, at, sentAt }` | screen 12 | `editor.vue` via `?comment=<id>`, `askAssistant()`, the PR mirror | etcd |
| Deferral ("I am not deciding today") | the same document, `looks[<principal hash>].deferred` | `deferReview()` after step 7 | the queue | etcd. Migrated once out of the existing `git config --local barn.review.deferred` |
| The pull request, the durable external record | GitHub, plus `packets[n].pr` in the review document | `assemblePacket()` | screen 12's existing chip via `findOpenPullRequest()`, screen 07 | the cluster. This is the only store here that does |
| GitHub token and per-extension repository (existing, unchanged) | Secret `barn-settings`, keys `gh_token` and `gh_repo.<extension>` | `saveSettings()` | `readToken()`, `publishExtensionToGithub()` | etcd |
| Snapshots (existing, unchanged) | `refs/tags/barn-snap/<ms>` | `createSnapshot()` | `listSnapshots()`, `restoreSnapshot()` | pod restart |
| The last publish failure (existing, unchanged) | `sessionStorage['barn.publish.failure']` | `recordFailure()` | `build-failed.vue` | one tab, deliberately. No review state may go here |

### Why the split falls there

The queue (screen 11) has to answer "what is waiting on you" for every extension in the cluster.
Today it does that with `listExtensions` plus `countChanges` plus `readExtensionFile` per row,
which is three execs into three pods to render three rows, and it produces the wrong answer
anyway: an author with a dirty working tree is already in somebody's queue. Sign-off state in a
ConfigMap is one list call for the whole namespace and needs no pod to be running at all.

The pod is disposable and the extension is not. `deploymentBody()` mounts `/app` from a hostPath
and uses `strategy: Recreate`; the review record has to outlive somebody deleting a Deployment to
fix a wedged dev server.

Git config was the right home for the deferral (`barn.review.deferred`, and the comment above it
in `extensions.ts` gives three good reasons). It is the wrong home for a sign-off, for a fourth
reason the deferral does not have: git config has no idea who set a value, and there is exactly
one pod, so two people using the same Studio would overwrite each other silently.

### Two stores this design does not use, and why

- **The extension's `package.json`.** It is read by `packageIdentity()` and its `rancher.annotations`
  are copied verbatim into the UIPlugin by `upsertUiPlugin()`. Anything written there travels into
  every published bundle, and it is a file the assistant edits.
- **UIPlugin annotations.** `upsertUiPlugin()` PUTs `spec` wholesale on every republish, so an
  annotation written there is destroyed by the next publish, and the object only exists after a
  local publish, which is precisely the ungated half of the flow.

---

## Provenance

### What the tmux boundary can honestly give us

Nothing useful. `askAssistant()` is `tmux send-keys` into the `mc-editor` session, or a write to
`/app/.queue/editor` when no session is attached. It is write-only. The product can record what it
sent and when it sent it, and that is the whole of it: it cannot see what claude then did, and the
pane's output is a character stream that `AssistantPanel.vue` already declines to parse ("claude's
output is a character stream, not a sequence of typed events, and turning one into the other is a
parser nobody has written"). Building provenance on top of send-keys would mean writing that
parser and trusting it, which is the fabrication this product does not do.

### What the honest boundary is

claude's own hook interface, inside the pod. Verified in the running `base` pod:

- `claude --version` is `2.1.239`, at `/usr/local/bin/claude`.
- The binary contains the hook event names `UserPromptSubmit` (86 occurrences), `PostToolUse`
  (208), `PreToolUse`, `Stop`, `SessionStart`, `SessionEnd`, and the payload field names
  `hook_event_name`, `tool_input`, `tool_response`, `transcript_path`, `session_id`.
- Hooks are already load-bearing in this product: `pod/claude-defaults.mjs` writes a `Stop` hook
  into `$HOME/.claude/settings.json` that pushes refreshed credentials back to the Secret, and the
  live pod's `settings.json` has it. The merge pattern there (match on the command string so it
  cannot accumulate copies) is the pattern the new hooks follow.
- `HOME` is `/app/.home`, on the hostPath, so hook state persists across restarts.

So three hooks, one new script `pod/barn-provenance.mjs` seeded to `/seed`:

1. `UserPromptSubmit` mints a turn id, writes `/app/.barn/turn/<session_id>`, appends a `prompt`
   record with the prompt text, the session, the timestamp, and the origin stamp left by
   `askAssistant()` if there is one.
2. `PostToolUse`, matcher `Edit|Write|MultiEdit|NotebookEdit`, appends a `touch` record with the
   turn id and `tool_input.file_path`.
3. `Stop` commits the working tree if it is dirty, with the turn id in a `Barn-Turn:` trailer, and
   clears the turn marker.

### The verdict on granularity

**Per hunk, one prompt, is not honestly achievable and this design does not claim it. What is
achievable is per turn, resolved to per line by `git blame`, and therefore answerable per hunk as
"the turns that produced these lines" rather than "the prompt that produced this hunk".**

The reasoning, in the order the losses happen:

- A `PostToolUse` hook on `Edit` knows the file and the exact `old_string` it replaced, so at the
  instant of the edit the line range is knowable. By the time a reviewer sees the collapsed diff
  the file has been edited many more times and those line numbers have moved. Tracking a range
  through subsequent edits is what `git blame` does correctly and what a bespoke tracker would do
  approximately.
- A `Write` rewrites a whole file and has no sub-file granularity at all.
- The assistant frequently changes files through `Bash` (a `sed`, a codemod, a script it wrote).
  No file-editing hook fires. Those lines have a turn but no tool record.
- A person typing in the pane, in the workspace's Terminal tab, changes files that no hook sees at
  all.

The commit-per-turn is what converts a coarse honest signal into a precise one: because every turn
ends in a commit carrying its own id, `git blame --porcelain -L a,b -- <file>` at the packet tip
gives every line in a hunk a commit, and every commit gives a turn, and every turn gives a prompt.
That is exact, it is checkable by hand with git, and it degrades honestly: a line whose commit has
no `Barn-Turn:` trailer, or which predates the hooks, renders as **"changed in the pod, no prompt
recorded"** and never as the nearest prompt.

Two further honesty rules that fall out of this and must be in the UI, not just here:

- **A turn is attributed to a person only when the product sent the prompt.** `askAssistant()` can
  stamp `/app/.barn/origin` with the calling screen and the Rancher principal before it types.
  A prompt typed directly into the pane has no principal available anywhere in the pod, so it
  records the pod's conversation and no name.
- **Files the turn's commit contains but whose paths appear in no `touch` record** are labelled as
  swept into that turn rather than caused by it.

The design deliberately does **not** read claude's own transcript
(`/app/.home/.claude/projects/-app-pkg-base/<session>.jsonl`), even though it exists, is richer
than the hooks, and already contains `promptId`, `uuid`, per-message `timestamp`, `cwd`,
`gitBranch` and `file-history-snapshot` records with `trackedFileBackups`. It is an internal
format with no compatibility promise, and a provenance system that silently stops recording when
claude updates is worse than one that records less.

### Consequences of the commit-per-turn that have to be handled in the same step

- `workingDiff()`, `changedFiles()`, `fileDiff()` and `countChanges()` all measure against `HEAD`.
  With a commit per turn, HEAD moves constantly and those screens go blank. They must route
  through `baselineRef(name)` instead, which is the `collapsed-diff` fix anyway, so this is one
  change that closes two rules.
- `undoLastChange()` restores one file from HEAD and would stop being able to undo a committed
  turn. Its replacement is `git reset --keep` to the previous turn commit, which is a better undo
  and is now available.
- `createSnapshot()` and `discardChanges()` are unaffected: both already work against the working
  tree, and the comments explaining their `add -N` handling remain accurate.

---

## Identity

### What the product can actually read

Two sources, both verified against the running Rancher at `https://magic-closet-rancher`:

1. **The Vuex store, client side.** `auth/principalId` gives `local://user-btc48`;
   `auth/user` / `auth/selfUser` give a display name when the store has fetched one.
   `AssistantPanel.vue:167` and `verification.vue:368` already read exactly these, with a fallback
   that splits the scheme off the principal id. This is convenient and it is what the page already
   trusts to render "Connected as".
2. **The apiserver, server attested.** `POST /k8s/clusters/local/apis/authentication.k8s.io/v1/selfsubjectreviews`
   with an empty `SelfSubjectReview` body returns, live:

   ```json
   { "status": { "userInfo": {
       "username": "user-btc48",
       "groups": ["system:authenticated", "system:cattle:authenticated"],
       "extra": { "principalid": ["local://user-btc48"], "username": ["admin"],
                  "requesttokenid": ["token-rpkns"], "requesthost": ["magic-closet-rancher"] } } } }
   ```

   This is what the cluster believes about the caller, not what the page believes about itself.
   `rancherFetch()` already adds the CSRF header on non-GET, so it needs no new plumbing.
   `/v3/users?me=true` gives the same identity in Rancher's own terms (`user-btc48`, `admin`,
   `Default Admin`, `principalIds: ["local://user-btc48"]`) and is the better source for a
   readable display name.

`currentSigner()` uses both: the SelfSubjectReview for the identity that goes into the record, and
the store or `/v3/users?me=true` for the name that goes on the screen.

### Is "two different people" enforceable?

**Enforceable in the product, auditable in Kubernetes, not cryptographically attested. Say so on
the screen rather than implying more.**

- The gate compares `signoffs.code.principal` with `signoffs.outcome.principal` and refuses when
  they are equal. That stops the case the design is actually worried about, which is one person
  ticking both boxes, and it stops it in the one place every distribution path goes through.
- It does not stop a determined person with `kubectl` writing both entries with different names,
  because this extension has no server of its own: every write in it is a browser write with the
  user's session, and there is nothing between the page and etcd that could sign anything.
- What does exist is tamper evidence rather than tamper resistance. Every write to
  `barn-review-<extension>` goes through the apiserver as an authenticated user and lands in the
  Kubernetes audit log, and every packet is a git object. A forged record is detectable after the
  fact and cannot be made to look like it came from the person it names.

### Roles, as opposed to identities

Rancher tells us a principal and its groups. It does not tell us that this person is "the person
who asked". That has to be recorded when it is known and left unclaimed when it is not:

- The brief gains a `## Who asked` line holding a principal id, captured on screen 02 or 10.
- When it is filled, `signOutcome()` refuses a signer who is not that principal and the screen
  says who it is waiting for.
- When it is empty, the outcome sign-off records whoever signed it and the packet and the PR both
  say **"the requester was never recorded"**. It does not silently accept anyone as the requester.

"A developer" for the code review is not checkable at all from Rancher's data and this design does
not pretend to check it. The code-review sign-off records who signed. The one structural rule that
is enforced is that the two signers differ.

### The RBAC consequence, which has to ship with step 1

Signing writes a ConfigMap in namespace `barn`. Today everything in that namespace is admin
territory in practice. `ensureShared()` should create a Role `barn-reviewer` granting
`get,list,create,update,patch` on `configmaps` in `barn`, and binding it is an admin decision, not
something the extension does for them. Until a reviewer is bound, `readReview()` succeeds and the
sign-off buttons must be disabled with the real reason shown, never enabled into a 403.

---

## The gate

### The choke point

There are exactly two functions in the product that make an extension exist anywhere other than
its own pod, and both are in `extensions.ts`:

- `publishExtension(name, onProgress)` at line 2363. Builds in the pod, copies into `/app/public`,
  upserts a UIPlugin. This is dev preview and developer load. **It stays ungated forever**, and it
  gets a comment saying that, because rule 2 is as load bearing as rule 1.
- `publishExtensionToGithub(name, repo, onProgress)` at line 2456. Commits and runs
  `git push <remote> HEAD:refs/heads/main`. This is the **entry** to the gate.

`editor.vue` `publishTo(target, repo)` at line 547 is the only caller of both, and its sole
precondition today is `if (this.publishing) { return; }`. It is where the UI reacts, but the check
must not live there: the load-bearing check goes in `extensions.ts` so that no screen, and no
future screen, can route around it.

### The two halves of one boundary

The flow map puts the gate at stage 6 (the push) and "both sign-offs attached" at stage 9 (choose
where it goes). Those are the two halves of the same boundary and they need different checks.

**Entering the gate** is `publishExtensionToGithub()`, reworked:

```
assemblePacket(name)   // refuses when BRIEF.md is missing: rule 14
  -> refs/barn/packets/<n> at the current tip
  -> git note on it: the provenance index, blame-resolved
  -> push branch barn/<extension>/<n>, not HEAD:refs/heads/main
  -> create the PR through the pod, the same node + token pattern as findOpenPullRequest()
  -> review.json: packets[n] = { ref, sha, base, pr, at, by }
```

It requires a brief and it requires something to hand over. It does not require a sign-off, which
is the point: pushing is how you *ask* for one.

**Leaving the gate** is a new `distributeExtension(name, destination)`, whose first line is:

```ts
await assertGateOpen(name);
```

`gateState(name)` in the new `pkg/barn/review.ts` returns a discriminated state read from
`review.json` plus the packet refs:

| state | meaning |
|---|---|
| `no-brief` | nothing to compare a change against, so nothing can be handed over |
| `no-packet` | never pushed. Nobody has been asked |
| `stale-packet` | the tip has moved past the signed packet, so the sign-offs are for a different change |
| `awaiting-code` | outcome signed, code review is not |
| `awaiting-outcome` | code signed, outcome is not |
| `changes-requested` | either signer said no, and the comment is the way back |
| `same-signer` | both sign-offs carry the same principal |
| `open` | two distinct principals, both `approved`, both against the current packet |

`assertGateOpen()` throws a `GateError` carrying the state, the packet number and who it is
waiting on, in the same shape as the existing `PublishError` (which already carries `stage` and
`log` so that a failure is diagnosable). Screen 07 and `PublishGithubModal.vue` read `gateState()`
directly to disable the OCI and catalog destinations, and they render the state as a sentence
naming who it is waiting for with a link to the packet. **A disabled control with no reason is not
acceptable here**, and neither is an enabled one that throws: the state is known before the button
is drawn.

`stale-packet` deserves a note because it is the case that will actually happen. A sign-off is
against a packet number, never against "the extension". Push again and the sign-offs are still on
record, still visible, and no longer sufficient. That is also exactly the data the "since your
last look" banner needs, so the two rules share one field.

### What must stay true

`tests/dead-handoffs.mjs` must stay green. This design adds one new query parameter,
`?comment=<id>` from screen 12 to `editor.vue`, and it is read at the other end in the same step
that introduces it.

---

## The build sequence

Nine steps. Each one is a change somebody can see working on its own, and each one leaves the
product honest if the next one never lands.

**1. The review record and who is signing.**
New `pkg/barn/review.ts`: the ConfigMap `barn-review-<extension>`, one `review.json` key,
`readReview()` / `updateReview()` with optimistic concurrency (pass the whole existing object back
so a stale write 409s, the way `saveSettings()` already does), `currentSigner()` over
SelfSubjectReview plus `/v3/users?me=true`, and the `barn-reviewer` Role in `ensureShared()`.
*What ships:* screen 12's Approve writes a signed, named, timestamped record that survives a
reload, and the literal sentence "You are the only reviewer on this Studio, so your decision is
the decision" is replaced by the signer's real name and the fact that a second sign-off is
outstanding. First durable review state in the product.

**2. The published baseline.**
`refs/barn/published/local` written by `publishExtension()` after `upsertUiPlugin()` succeeds, and
`baselineRef(name)` routed into `workingDiff()`, `fileDiff()`, `changedFiles()` and
`countChanges()`. When there is no baseline the screens say which point they measured from instead
of implying the last publish.
*What ships:* rule 7. Screens 04 and 12 stop measuring a published extension against a commit that
has nothing to do with what was published.

**3. Provenance capture in the pod.**
`pod/barn-provenance.mjs`, the three hooks registered in `claude-defaults.mjs` beside the existing
`Stop` hook, `/app/.barn/provenance.jsonl`, the commit-per-turn with its trailers, the
`undoLastChange()` replacement, then `node scripts/gen-extension-seed.mjs` and
`node scripts/apply-extension-seed.mjs`.
*What ships:* the workspace's activity stream stops being the placeholder that currently reads
"This view will show each turn as steps with durations once the CLI's output is parsed into
events" and lists real turns with real durations, read from the log rather than from a parser
nobody wrote. Useful on screen 03 with no review system at all.
*Spike first:* prove one hook fires in one pod and writes one line before building the rest.
Everything downstream depends on it.

**4. Provenance at review.**
`provenanceFor(name, packet)`: blame the hunks of the collapsed diff at the packet tip, resolve
`Barn-Turn:` to prompts, render per hunk on screen 12 with "changed in the pod, no prompt
recorded" wherever there is nothing.
*What ships:* rule 8's prompt half. Screen 12 gains the column the caption promises.

**5. The packet and the PR.**
`assemblePacket()`, `refs/barn/packets/<n>`, the note, the branch, the PR.
`publishExtensionToGithub()` becomes the gate entry and stops pushing to `main`. The queue is
rebuilt on packets rather than on dirty working trees.
*What ships:* rules 6 and 5 of the gate list. An author who has not pushed leaves the queue, which
is a visible and deliberate removal of a wrong behaviour, and crossing the boundary produces a PR
that the existing `findOpenPullRequest()` chip can finally find.

**6. Both sign-offs, two signers, the exit gate.**
`gateState()`, `assertGateOpen()`, `distributeExtension(name, destination)` with the OCI push,
screen 13 signing the outcome against the same packet, screen 07 rendering both sign-offs and
refusing with a reason.
*What ships:* the three gate rules that are currently `not-implemented`.

**7. Since your last look.**
`looks[<principal hash>]`, marked on opening a packet; the queue banner counting what landed since
the reviewer's last look; the screen 12 filter. The existing `barn.review.deferred` git config
value is read once, migrated into the record, and unset.
*What ships:* rule 9, and the deferral becomes per reviewer instead of per extension.

**8. Comments that route back.**
`comments[]`, the per-hunk comment control on screen 12, "Send to the assistant" calling the
existing `askAssistant()`, `?comment=<id>` read by `editor.vue` at the other end, and a best
effort mirror into the PR when a token is configured (with the UI saying when the mirror failed
rather than implying it worked).
*What ships:* rule 11. The reviewer's sentence becomes the instruction and the reviewer never
writes the fix.

**9. The brief on the main path, and scope resolutions.**
Remove `skip()` from `brief.vue`; `assemblePacket()` refuses without a brief so the requirement is
structural rather than a missing button; screen 13's scope card gets its two resolutions, where
"accept it into the brief" edits `BRIEF.md` and records the edit on the packet, and "take it out"
is an assistant instruction through the step 8 path.
*What ships:* rules 14 and 16. The brief round trip fix (`CROSS-CUTTING.md` item 4) has already
landed, so this is the rest of it.

---

## What this design refuses to do

- **Claim one prompt per hunk.** Per turn, blame-resolved to per line. A hunk answers with the set
  of turns that produced its lines. See the verdict above for the four places where finer
  attribution would have to be invented.
- **Attribute a line nobody watched.** Edits made through `Bash`, by a person in the Terminal tab,
  or before the hooks existed, render as "changed in the pod, no prompt recorded". They are never
  attributed to the nearest turn.
- **Name a person for a prompt typed into the pane.** The pod has one shared conversation and no
  idea which Rancher user is looking at it. Only prompts the product itself sent through
  `askAssistant()` carry a principal.
- **Read claude's transcript JSONL.** It is richer and it is undocumented. A provenance record that
  silently empties on a claude update is worse than a coarser one that does not.
- **Cryptographically attest a sign-off.** The extension has no server. Sign-offs are recorded,
  compared and audited; they are not signed. The UI must not use language that implies otherwise.
- **Prevent a determined person from forging both sign-offs.** The gate refuses the ordinary case,
  which is the one the flow map is about. Below the gate there is the Kubernetes audit log and
  nothing else, and this design says so instead of implying a guarantee it cannot keep.
- **Check that the code reviewer is "a developer".** Rancher gives a principal and its groups, not
  a role in this change. The enforced rule is that the two signers differ. The requester is checked
  only when the brief recorded who asked, and is reported as unrecorded when it did not.
- **Gate the local publish or developer load.** Rule 2 is as strong as rule 1 and is much easier to
  break by accident. `publishExtension()` gets a comment saying it is deliberately ungated so that
  a future reader does not "fix" it.
- **Promise a rollback to the running bundle.** `refs/barn/published/local` records the tree that
  was built, which is the source and not the artifact. The bundle lives in `/app/public` in the
  pod and dies with the node. The screen should offer a rebuild from the recorded tree, not a
  restore of the bundle.
- **Make the preview "yours alone" (rule 17's first qualifier).** There is one pod per extension at
  one cluster URL and everyone with the Studio sees the same one. Per-author preview means a pod
  per author per extension. That is a real gap, it belongs to the workspace and not to the review
  system, and this design does not paper over it.
- **Keep listing an author's uncommitted working tree as something waiting on a reviewer.** Step 5
  removes it. It is the current behaviour and it is the direct contradiction of rule 6.
- **Backfill provenance or a baseline for extensions that already exist.** They arrive as
  `no-packet` with a brief and no history. Their first push is their first packet, their first
  distribution writes their first `refs/barn/published/oci`, and everything before that is labelled
  "authored before provenance was recorded" rather than being reconstructed from commit messages.

---

## Migration

Extensions that exist today have a `BRIEF.md`, a git repo whose HEAD is whatever was last
committed by hand, no packet, no baseline, no hooks and no review record.

1. `readReview()` treats a missing ConfigMap as an empty record. Nothing has to be created ahead of
   time, and an extension nobody has reviewed costs one 404.
2. `gateState()` returns `no-packet` for all of them. The queue shows them as never handed off,
   which is true, rather than as waiting on somebody, which is what it says today.
3. The hooks reach a pod when the seed ConfigMap syncs, which the kubelet does within about a
   minute, and take effect in **new tmux sessions only**. An open workspace pane keeps the scripts
   it started with. `apply-extension-seed.mjs` already says this; the release note has to repeat it,
   because the first turn after an upgrade will silently not be recorded in an already-open pane.
4. `refs/barn/published/local` is written at the next local publish and not guessed. Until then the
   review diff says which point it measured from.
5. The deferral migrates in step 7: read `git config --local barn.review.deferred`, write it into
   `looks[<the reader's principal>]`, unset the config key. It attributes an old deferral to
   whoever first opens the queue after the upgrade, which is a guess, so the record marks it
   `migrated: true` and the UI says "deferred before this Studio recorded who defers".
6. Nothing in this design deletes or rewrites `BRIEF.md`, the snapshot tags, `barn-settings` or the
   UIPlugin objects.
