# Designer's intent

What the Figma commentary frames say, as opposed to what the screens draw. Extracted from the
cover (`30:1202` / `29:2`), the flow map (`43:2`), the rationale table (`27:2`, continued at
`44:2` and `65:1083`) and the 14 per-screen caption blocks.

File: `Xm3Q6WVin7U3cwMeOdGV6z`, "Rancher Extension Studio - AI Authoring (Concept)".
Author line on the cover: `Ken Wimer · Product Design Lead, SUSE` / `Concept · August 2026 · Rancher Prime v2.15`.

The cover's own framing of the work (`29:8`):

> A usability and UX pass over the AI extension authoring tool the dashboard team built — same
> capability, made safe to hand to someone who does not read Vue, and reviewable by the people who
> have to sign it off.

And its reading order (`29:40`, `29:41`):

> **Start with Screens 03 and 12**
> Screen 03 carries the authoring argument: readable activity, live preview, an explicit line
> between preview and published. Screen 12 carries the review one: intent, ranked diff and rendered
> result in a single view.

---

## 1. The three-point summary from the cover

> 1. Keeps everything the current build does: CLI, files, GitHub import, publish, settings.
>    *(`29:13`)*
> 2. Adds a way in, a way to see what changed, a way to choose where it goes, and a way back when
>    it breaks. *(`29:17`)*
> 3. Adds the enterprise half: a brief that turns a technical ticket into a stated need, a real
>    review surface for developers, and a separate outcome sign-off by the person who asked.
>    *(`29:21`)*

Point 1 is a no-regression clause: the redesign is not allowed to drop a capability the current
build has. Points 2 and 3 are the two additions, and point 3 is the one that introduces people
other than the author.

---

## 2. The flow map, written out as a sequence

Frame `43:2`, "Flow map — the redesigned journey". Title (`43:3`):

> From an idea to a shipped extension, and who signs what

Legend (`43:4`):

> The top lane is the author. The bottom lane is everyone who has to agree. Green is the path most
> people take, blue is a side route, amber is recovery — and every recovery route leads back into
> the same workspace rather than out of the product.

Colour is load-bearing here, so the stage colours are recorded below. Green boxes are
`#EEF5EF` on `#3E8C4F`, blue (side route or New) `#EAF4FB` on `#3D98D3`, amber (recovery)
`#FDF6E3` on `#C9A227`, and the terminal state is neutral grey `#F7F8FA` on `#B4B5BE`.

### Top lane: the author (y = 250)

| # | Stage | Node | Colour | Caption | Screen |
|---|---|---|---|---|---|
| 1 | Studio home | `43:5` | green | "Everything you have, and its state" | 01 |
| 2 | Describe what you want | `43:8` | green | "Plain language, plus the outcome" | 02 |
| 3 | Agree the brief **[New]** | `43:11` | blue | "The need, the open questions, the criteria" | 10 |
| 4 | Build it and watch it | `43:16` | green | "Readable activity, live preview, and no gates at all" | 03 |
| 5 | Check it yourself, if you want | `43:19` | green | "Optional. Diff plus a plain-language explanation" | 04 |
| 6 | Push to an OCI repository **[The gate]** | `43:22` | blue | "The one hard gate. Everything before it is yours alone" | 07 |

Arrows 1 -> 2 -> 3 -> 4 -> 5 -> 6 are all green, so the brief (stage 3) sits on the main path
between describing the extension and building it, not off to the side. Stage 5 is explicitly
optional. Nobody signs anything in the top lane and nothing in stages 1 to 5 asks permission.

### The amber recovery loop inside the top lane

- **Out:** an amber arrow (`43:62`) runs **up** from "Build it and watch it" to **"It breaks"**
  (`43:25`, x 880-1120, directly above the workspace box), labelled `when a build fails` (`43:88`).
  Caption: "Cause in words, a one-click fix, a snapshot · Screen 08".
- **Back:** a second amber arrow (`43:65`) runs **down** from "It breaks" into the *same*
  "Build it and watch it" box, labelled `after the fix` (`43:89`).

The failure route is a round trip out of and back into the one workspace. It never becomes its own
branch of the flow, and it never leaves the product. This is the concrete case of the legend's
"every recovery route leads back into the same workspace".

### The hand-off (the gate)

A green connector leaves the bottom of "Push to an OCI repository" (`43:68`, x=1560), runs the full
width of the map right to left at y=425 (`43:69`), and drops into the bottom lane at x=170
(`43:70`, arrowhead `43:71`). Its label (`43:90`):

> hand-off · the PR is the record

So: the push to OCI is what hands the work to the reviewers, and the PR is the artefact that
carries the record of that hand-off.

### Bottom lane: everyone who has to agree (y = 500)

| # | Stage | Node | Colour | Caption | Screen |
|---|---|---|---|---|---|
| 7 | Code review **[New]** | `43:28` | blue | "A developer: ranked files, prompt provenance, visual diff" | 11 and 12 |
| 8 | Outcome sign-off **[New]** | `43:33` | blue | "The person who asked: walk the criteria against the running build" | 13 |
| 9 | Choose where it goes | `43:38` | green | "Both sign-offs attached" | 07 |
| 10 | Live | `43:41` | grey | "Reversible from the extension list" | (screen 01) |

Green arrows run 7 -> 8 -> 9 -> 10. Two different people sign, in order: a **developer** signs the
code review, and **the person who asked** signs the outcome. Stage 9 says "Both sign-offs
attached", and the caption sitting in that band (`43:91`) states the rule outright:

> nothing published until both are green

The end state is "Live", and it is marked reversible from the extension list, so publishing is not
a one-way door.

### The amber recovery route out of the bottom lane

Two amber arrows drop from stage 7 (`43:82`, x=150) and stage 8 (`43:85`, x=450) into one shared
box, **"Changes requested"** (`43:44`, spanning both stages), captioned (`43:46`):

> Goes straight back to the workspace with the comment already loaded into the assistant — the
> reviewer never writes the fix themselves

Either reviewer can reject, both rejections land in the same place, and that place is the author's
workspace (stage 4) with the reviewer's comment already staged as an instruction for the assistant.
There is no separate "fix requested changes" surface, and the reviewer is explicitly not expected
to edit code.

### Where the one hard gate sits

Guardrail note (`43:92` / `43:93`), the frame's closing statement:

> The gate sits at the distribution boundary, not on every change. A developer can build, run,
> break and rebuild all day with nobody watching — the review packet accumulates quietly in the
> background. It is only assembled and handed to a reviewer at the push to a repository, collapsed
> into one diff against the last published version.

Three separable requirements are packed into that paragraph: the gate is at the distribution
boundary only; the review packet is accumulated continuously in the background while the author
works; and what a reviewer receives is one collapsed diff against the last published version, not
the change-by-change history.

---

## 3. Per-screen captions

Each caption block is a heading line and a provenance line ("Replaces:" or "New:"). Both are quoted
in full.

### Screen 01 - Extensions, Studio home (`23:893`)

> **Studio home — every extension, its state and where it runs**
> Replaces: the "base" dropdown that was the only way to switch extensions

**What this demands beyond the picture:** the table has to be the *only* extension switcher and it
has to reach *every* extension, because it is replacing a dropdown, not sitting beside one. Its
three payload columns (state, where it runs, last change) are live values about running things, not
static row text. A screenshot shows a table; it cannot show that the old switcher is gone or that
the state column tracks reality.

### Screen 02 - New extension, describe it (`23:896`)

> **New extension — plain language in, working code out**
> New: there was no creation flow at all

**What this demands beyond the picture:** the promise is a whole route, not a form. Plain language
typed here has to come out the far end as working code, so this screen has to actually start the
build (flow stage 2 -> 3 -> 4), and it is new ground with no existing behaviour to lean on. A
screenshot of the form says nothing about whether submitting it produces anything.

### Screen 03 - Workspace, Assistant + live preview (`23:899`)

> **The workspace — what the assistant did, and the result, side by side**
> Replaces: the CLI tab and the separate browser window

**What this demands beyond the picture:** the two panes must be the same live session, so the
preview reflects what the assistant just did, and the separate browser window must no longer be
needed for anything. "Replaces" means the CLI tab stops being a required surface. A screenshot
shows two panes; it cannot show that they are wired to each other or that nothing else is required.

### Screen 04 - Review changes before publishing (`23:902`)

> **Review changes — see and understand every edit before it ships**
> New: files were read-only with no diff

**What this demands beyond the picture:** "every edit" makes the diff exhaustive, and "before it
ships" places this screen ahead of the publish step in the sequence. "Understand" adds the
plain-language explanation as a requirement, not a nicety. A screenshot of a diff panel cannot show
whether anything was left out of it.

### Screen 05 - Files, history, tree and a readable editor (`23:905`)

> **Files — history, tree, and where each file surfaces in the UI**
> Replaces: the read-only Files tab

**What this demands beyond the picture:** the file view stops being read-only, it carries history,
and every file is annotated with the place in the UI it produces. That last one is derived data
(file -> rendered surface) that has to be computed from somewhere. A screenshot shows a tree; it
does not tell you the file-to-UI mapping is a required output.

### Screen 06 - Import from GitHub (`23:908`)

> **Import from GitHub — connection happens inside the dialog**
> Replaces: the dead-end warning that sent you to a second modal

**What this demands beyond the picture:** the connection must be completable without leaving the
dialog and without losing the import you started. The thing being removed is a navigation, so the
test is behavioural: nothing here may send the user to settings and back. A screenshot of a
connect step cannot prove the dead end is gone.

### Screen 06a - Import, first run, connect without leaving the dialog (`23:920`)

> **First run — no token yet, still no dead end**
> The state the old warning banner produced

**What this demands beyond the picture:** the zero-credential state of the same dialog is a
designed state, not an error path, and it is explicitly the condition that used to produce the
warning banner. So the implementation has to be exercised with *no* stored token and still complete
the import. A screenshot of the happy path never reaches this state.

### Screen 07 - Publish, choose where it goes (`23:911`)

> **Publish — every destination is an explicit, separate choice**
> Replaces: the single "Publish locally" split button

**What this demands beyond the picture:** the destinations are independently selectable (not one
default with a menu), and none may be implied. The split button is being removed, so a default
destination pre-chosen for the user would break the intent. A screenshot showing checkboxes does not
show whether one is silently pre-selected or whether the set is exhaustive.

### Screen 08 - Build failed, explained, with a way back (`23:914`)

> **When it breaks — plain-language cause, one-click fix, guaranteed way back**
> New: failures only appeared as terminal output

**What this demands beyond the picture:** three things have to hold at once, and "guaranteed" is
the strong word: a way back has to exist for *every* failure, which means a snapshot taken before
the change, not an error message with a retry. A screenshot of one failure card cannot show the
guarantee.

### Screen 09 - Studio settings (`23:917`)

> **Studio settings — connection, permissions, access and data in one place**
> Replaces: the bare "GitHub token" modal

**What this demands beyond the picture:** "in one place" makes this the single home for all four
concerns, so the token modal must be gone and the states shown elsewhere (the connection strip on
screen 03, the permission mode) must resolve here. A screenshot shows four sections; it cannot show
that no fifth surface still edits the same settings.

### Screen 10 - The brief, what are we actually trying to do? (`45:1196`)

> **The brief — a ticket becomes a stated need**
> New: how a developer works out what they are actually trying to do

**What this demands beyond the picture:** the screen has to *transform* its input (a ticket in,
a need out), and its three outputs (the need, the open questions, the acceptance criteria) have to
persist, because screens 12 and 13 consume them. A screenshot shows a two-column layout; it cannot
show that the criteria written here are the same objects walked on screen 13.

### Screen 11 - Review queue, what is waiting on you (`45:1199`)

> **Review queue — led by purpose, not by file count**
> New: there was no review step at all

**What this demands beyond the picture:** the row's leading text is the *purpose* of the change,
and file count is deliberately demoted, so a queue sorted or headlined by size contradicts the
caption. "There was no review step at all" means the queue, its state model and its routing are all
new. A screenshot cannot show what the rows are ordered by.

### Screen 12 - Review a change, intent, diff and rendered result together (`45:1202`)

> **Review a change — intent, diff and result in one place**
> New: prompt provenance per hunk, and comments that route back to the assistant

**What this demands beyond the picture:** per-hunk prompt provenance means data captured during
authoring (screen 03) has to survive all the way into review, attached at hunk granularity. And a
comment is not a comment: it is an instruction that has to route back into the author's assistant.
Both are cross-screen data paths a screenshot of the review pane cannot show.

### Screen 13 - Verification, does it actually do the job? (`45:1205`)

> **Verification — the criteria walked against the running build**
> New: how we ensure what was built fills the requirement

**What this demands beyond the picture:** the criteria are the ones written in the brief (screen
10), not re-entered here, and they are walked against the **running** build rather than read off a
list. A screenshot of a checklist cannot show where the items came from or that anything was
actually exercised.

---

## 4. What changed and why

Frame `27:2`. Header note (`27:5`):

> Read against the four screenshots of the current build. Everything below is achievable with
> components that already exist in the Rancher dashboard — SortableTable, LabeledInput, Banner,
> Card, Tabbed, AsyncButton — so none of this asks the team to invent new UI primitives.

All 20 rows, in file order.

| What the current build does | What this concept does instead | Why it matters | Where to look |
|---|---|---|---|
| A raw Claude Code terminal is the primary surface — redacted blocks, "[17/19]", "bypass permissions on (shift+tab to cycle)". | An activity stream of named steps with durations and status. Raw output is still there, one click away, and still the source of truth — it is just no longer the interface. | A product designer or SE can follow what happened without knowing what vue-cli-service is. Nothing is hidden; it is ranked. | Screen 03 |
| "Not logged in · Run /login" appears as terminal text you have to notice and act on. | Connection state is a persistent strip in the panel: a dot, the account, and the permission mode as a real control. | Auth state and permission scope are the two things people most need to know and the two most easily missed in a log. | Screens 03, 09 |
| Permission mode is a keyboard-cycled terminal footer. | A named radio group with three plainly worded options and an admin-only warning on the loosest one. | How much autonomy you have granted an AI is a governance decision, not a hotkey. | Screen 09 |
| Files are read-only. There is no diff. You cannot see what the AI changed. | A Changes tab with a file list, a real diff, and a plain-language explanation of each change alongside it. | This is the single biggest trust gap. Without it "review before you publish" is not a thing anyone can actually do. | Screen 04 |
| The extension runs live in the pane next to you — every save is already in the shell. | The same live preview, plus an explicit boundary: preview is yours alone, snapshotted per build, and publishing is a separate deliberate act. | Turns "it is already live, hope that was right" into "look, then decide". | Screens 03, 07 |
| "Publish locally" is one split button with no explanation of what local means. | A publish dialog with each destination as a separate checkbox — this Rancher, GitHub PR, the fleet, the catalog — plus version, changelog and pre-flight checks. | People need to know whether they are affecting themselves, their team, or every customer. A split button cannot carry that. | Screen 07 |
| Import shows a warning that a token is missing and tells you to go to settings, then come back. | Connection is step one of the import dialog itself, with OAuth first and a token field inline behind a disclosure. | The current design breaks the task in half and asks the person to remember where they were. Nobody should be sent away mid-flow. | Screens 06, 06a |
| Editor settings is a bare modal with one unexplained field labelled ghp_... | A real settings page: connection with scopes and expiry, assistant permissions, preview target, who may use Studio, and what is sent to the model. | These are the questions a platform team asks before allowing this anywhere near production. Answering them in the UI is cheaper than answering them in a review meeting. | Screen 09 |
| A "base" dropdown in the corner is the only way to tell which extension you are editing. | A Studio home list built on the same SortableTable pattern as the Clusters page: state, name, source, where it runs, last change. | Rancher users already know how to read this table. Reusing the pattern removes an entire thing to learn. | Screen 01 |
| Failures surface only as terminal output; a wrongly parented route renders a blank white page with no explanation. | A failure card naming the cause in plain words, the one-line fix as a diff, an Apply button, and a snapshot to roll back to. | The parent-route trap is the documented number-one beginner mistake. The product should catch it rather than the person. | Screen 08 |
| No way in for someone who has not been handed the extension already. | A creation flow that asks what you want and where it should appear, with the parent-route decision made in plain language up front. | The hardest thing to fix later is asked at the only moment it is cheap to answer. | Screen 02 |

**Section divider (`44:2`): "Review, intent and verification" — "added after the first pass — the enterprise half of the problem"**

| What the current build does | What this concept does instead | Why it matters | Where to look |
|---|---|---|---|
| A reviewer opens a diff and has to reverse-engineer why any of it exists. The prompt that caused it is somewhere in a terminal scrollback. | Every hunk carries the prompt that produced it, and the whole change carries its brief. The conversation is the requirements document, so it is shown as one. | AI-authored code is cheap to produce and expensive to review. Intent is the only thing that makes a large diff reviewable at speed. | Screen 12 |
| Nothing tells the reviewer which parts of a generated change actually deserve their attention. | Files are ranked into "worth your attention", "generated, low risk" and "config", with a one-line reason each. Generated lines can be folded away. | A 400-line AI diff is not 400 lines of decisions. Treating every line as equally important is how real problems get skimmed past. | Screen 12 |
| Re-review starts from scratch every time the author pushes again. | A "since your last look" filter, and a banner on the queue row saying how many changes landed since you approved. | AI-authored branches churn far more than hand-written ones. Without this, reviewers either re-read everything or stop reading. | Screens 11 and 12 |
| A review comment becomes a message the author has to translate back into a prompt. | Comment on a hunk, then "Send to the assistant". The assistant drafts the fix against the reviewer's own words; the author still approves it. | Closes the loop without making the reviewer write code or the author play interpreter. The reviewer's sentence is the instruction. | Screen 12 |
| A technical ticket — "add a column" — goes straight into the tool and comes out as exactly that column. | A brief step that restates the ticket as a problem, names who has it, and says plainly when the request is a solution rather than a need. | This is the whole "technical task that was really a UX need" failure. It is only cheap to catch before the code exists. | Screen 10 |
| The questions nobody can answer surface halfway through the build, or after review. | The assistant lists what it cannot decide — separating blocking from merely useful — and drafts the message to the requester. | The unanswered question is the most valuable output of the first ten minutes. Today it is the thing most likely to go unrecorded. | Screen 10 |
| "Done" means the code merged. Whether it solved the problem is nobody's explicit job. | Acceptance criteria written in the brief become a checklist walked against the running build, with captured evidence and a second, separate sign-off. | Splits "is it safe?" from "does it work?" — two questions, two people, neither able to answer the other's. | Screens 07 and 13 |
| Scope creep is invisible until someone notices it in production. | The build is compared back to its own brief, and anything outside it is flagged during sign-off — accept it into the brief, or take it out. | An AI will happily do more than you asked. Without a brief there is nothing to compare against, so nobody can tell. | Screen 13 |
| Review, if it existed, would land on every change — so it would be turned off inside a week. | Iteration is completely ungated: dev preview and developer load ask nobody. The gate is the push to an OCI repository, where the extension first becomes installable by other people. | A developer fleshing out a feature makes forty changes and wants none of them reviewed. Gating the distribution boundary instead of the edit loop gives them that without giving up the audit trail. | Screens 07 and 09 |

---

## 5. Cross-screen rules

Requirements the commentary states that span more than one screen. These are the ones a
screen-by-screen implementation is most likely to miss, because no single frame contains them.
Each is also encoded in `raw/00-cross-screen.json`.

### The gate

1. **There is exactly one hard gate, and it is the push to an OCI repository.** Not review on every
   change. "The gate sits at the distribution boundary, not on every change" (`43:93`); "The gate is
   the push to an OCI repository, where the extension first becomes installable by other people"
   (`65:1086`). *(flow map, rationale row `65:1083`)*
2. **Everything before that gate is ungated.** "Iteration is completely ungated: dev preview and
   developer load ask nobody" (`65:1086`); "Readable activity, live preview, and no gates at all"
   (`43:18`); "The one hard gate. Everything before it is yours alone" (`43:24`). Creating,
   building, previewing, breaking, rebuilding, developer-loading and reviewing your own diff must
   never require anyone's approval.
3. **Nothing is published until both sign-offs are green** (`43:91`), and the publish step carries
   them: "Both sign-offs attached" (`43:40`). Publishing with one sign-off, or none, must not be
   possible.
4. **The two sign-offs are two different roles answering two different questions.** Code review is
   done by "A developer: ranked files, prompt provenance, visual diff" (`43:32`); outcome sign-off
   is done by "The person who asked: walk the criteria against the running build" (`43:37`); the
   rationale calls it splitting "is it safe?" from "does it work?": "two questions, two people,
   neither able to answer the other's" (`44:64`). One person ticking both boxes defeats the design.
5. **The hand-off record is the PR** (`43:90`). Crossing the gate produces the PR, and the PR is
   what carries the review.

### What the reviewer receives

6. **The review packet accumulates in the background while the author works, and is only assembled
   at the push** (`43:93`). It is not built on demand at review time and it is not a per-change
   stream.
7. **What is handed over is one diff collapsed against the last published version** (`43:93`), not
   the sequence of intermediate changes.
8. **Every hunk carries the prompt that produced it, and the whole change carries its brief**
   (`44:8`). Provenance is captured during authoring on screen 03 and the brief on screen 10, and
   both have to survive into screen 12.
9. **Re-review is incremental**: a "since your last look" filter on the change, and a banner on the
   queue row saying how many changes landed since you approved (`44:26`). This requires per-reviewer
   state that persists across visits and across screens 11 and 12.

### Recovery

10. **Every recovery route leads back into the same workspace rather than out of the product**
    (`43:4`). Both amber routes on the map obey it: the build failure goes up to screen 08 and back
    down into the same workspace box, and "Changes requested" goes back to the workspace.
11. **A rejection from either reviewer lands in the same place**: "Changes requested" spans both the
    code review and the outcome sign-off stages, and "Goes straight back to the workspace with the
    comment already loaded into the assistant — the reviewer never writes the fix themselves"
    (`43:46`). The comment arrives as an assistant instruction, and "the author still approves it"
    (`44:35`).
12. **A build failure has a guaranteed way back**: a snapshot to roll back to (`23:915`, `27:100`),
    and the return arrow re-enters the same workspace (`43:89`).
13. **Live is reversible from the extension list** (`43:43`). Publishing is undoable from screen 01.

### The brief as the spine

14. **The brief sits on the main path between describing the extension and building it** (flow
    stages 2 -> 3 -> 4, all green). It is not an optional detour, unlike "Check it yourself"
    (`43:21`), which is marked optional.
15. **Acceptance criteria written in the brief become the checklist walked against the running
    build on screen 13** (`44:62`, `45:1206`), with captured evidence. The criteria are authored
    once, on screen 10.
16. **The build is compared back to its own brief, and anything outside it is flagged during
    sign-off**: "accept it into the brief, or take it out" (`44:71`). Scope-creep detection needs
    the brief to still be attached at sign-off time.

### State that has to survive between screens

17. **Preview and published are different things, and the line between them is explicit**: "preview
    is yours alone, snapshotted per build, and publishing is a separate deliberate act" (`27:55`,
    screens 03 and 07). Working in the preview must never publish anything.
18. **Connection state and permission mode are the same state in two places**: a persistent strip in
    the workspace panel with the account and the permission mode as a real control (`27:28`, screens
    03 and 09), and a settings page that is the one home for connection, permissions, access and
    data (`23:918`). Changing it in one place must be true in the other, and no third surface may
    edit it.

### Constraints on the whole redesign

19. **No capability of the current build may be lost**: "Keeps everything the current build does:
    CLI, files, GitHub import, publish, settings" (`29:13`). The raw terminal output in particular
    stays: "still there, one click away, and still the source of truth — it is just no longer the
    interface" (`27:19`).
20. **Nothing here needs a new UI primitive**: everything is achievable with SortableTable,
    LabeledInput, Banner, Card, Tabbed and AsyncButton, components that already exist in the Rancher
    dashboard (`27:5`). Screen 01 in particular is "the same SortableTable pattern as the Clusters
    page" (`27:91`).
