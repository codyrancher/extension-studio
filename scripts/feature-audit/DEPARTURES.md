# Where the product deliberately differs from the design

Not everything unbuilt is a gap, and not everything built to the letter would be right. This
records the places the Studio knowingly differs from the Figma file, with the argument, so nobody
re-opens them as defects and nobody mistakes them for oversights.

Each one was reached by an agent driving the real thing, usually more than once independently.

---

## 1. The Studio uses its own primitives, not Rancher's `SortableTable`

**The design says** every screen is realisable with existing Rancher dashboard primitives, and that
the Studio home is a `SortableTable`.

**The product** draws all fourteen screens with fifteen `S`-prefixed primitives of its own, which
consume Rancher's CSS variables for colour, spacing and type.

**Why that is defensible.** The claim in the rationale table is about *feasibility* - "this can be
built with what Rancher already has" - and the product demonstrates feasibility by existing. It is
not a specification that the code must import those components.

**What it cost, honestly.** By not using `SortableTable`, the Studio inherited none of its sorting,
pagination, keyboard handling or empty states, and had to write them again. This audit found
**sorting implemented wrongly twice**: once comparing rendered strings, so "10 minutes ago" sorted
before "2 hours ago"; once comparing an abbreviated sha to a full one, so every valid sign-off read
as stale. Both are bugs a shared table component does not have.

**Verdict:** deliberate, and the cost is the reason to prefer the shared component next time.

---

## 2. Rancher's own chrome is not the Studio's to fill

**The design draws** an app-collection grid and an overflow kebab in the header, and a docs book in
the nav rail, on most frames.

**The product** adds none of them, with one exception noted below.

**Why.** Capability is not the blocker: an extension *can* register a header action
(`plugin.addAction(ActionLocation.HEADER, …)`). The blocker is that there is nothing honest to point
one at. This Rancher has no app-collection popover and no global overflow menu; the rail is
Rancher's product list and the Studio owns no documentation. A grid icon injected by the
extension-authoring extension, into every page of Rancher, opening something invented, is a control
that lies on every screen at once.

**The exception, and it is instructive twice over.** `header-more` **was** built, because the kebab
is not something barn has to draw: Rancher renders it whenever the mounted page commits
`pageActions`, and every Studio route used a layout that commits none. Four agents had concluded it
was impossible by asking whether barn could draw a header control. The fifth asked whether the
control already existed and was empty. It did.

The second lesson is the orchestrator's. Having learnt "the logo and the app grid are Rancher's", I
generalised it to "the header items are Rancher's" and told a later agent that screens 04 and 05
were settled and not to re-litigate them. That was wrong: their `header-more` is the same
page-actions mechanism four sibling screens already ship, and recording it as chrome would have
written a falsehood into the audit while its siblings shipped the control. The agent implemented it
anyway and said why. **A conclusion that was right about four items is not thereby right about the
fifth**, and an instruction to stop looking is worth resisting when the code says otherwise.

**Verdict:** the remaining chrome items are Rancher's, not gaps in this product. The logo in
particular has been confirmed four times: it is a bare `<img>` in the shell, wrapped in a link only
under `isSingleProduct`, with no slot, prop or action location an extension can reach.

---

## 3. Screen 13 has a state the design never drew

**The design** gives each acceptance criterion three answers: Yes, No, Can't tell.

**The product** has four, because a criterion nobody has answered yet is not the same as one somebody
looked at and could not judge. Grey belongs to "Can't tell", which the design assigns explicitly and
for a reason - it is an absence of judgement, not something needing attention. Unanswered is ours, so
it stops being a fill at all: an answer is a filled badge, no answer is an empty dashed outline.

**Verdict:** the mock is under-specified rather than wrong, and the product is more coherent than the
frame. Keep it.

---

## 4. Claude's transcript is read for its replies, and only for those

**The design's storage model** (`REVIEW-SYSTEM.md`) refuses to read claude's transcript JSONL,
because it is undocumented and a provenance record that silently empties on an upgrade is worse than
a coarser one that does not.

**The product** reads it in exactly one place: `assistantConversation()`, for the text of what the
assistant said.

**Why the refusal still stands where it matters.** The two uses have different failure modes. In the
*attribution* record, an unrecognised shape means lines credited to the wrong prompt - a confident
lie. For a *reply*, it means "no reply recorded" - a visible gap. The recorder itself
(`barn-provenance.mjs`) still refuses, so the guarantee the design cared about is intact, and there
is no other source for the assistant's prose at all.

**Verdict:** a narrow, argued exception, kept out of the record that the refusal exists to protect.

---

## 5. Two controls were removed rather than implemented

- **"Required" on the developer load.** The setting persisted correctly and the publish dialog
  displayed "recorded and not obeyed". Everything worked, and it was still wrong: the product was
  offering a choice it had already decided to ignore, and labelling the lie honestly does not stop it
  being one. The design fixes the developer load as ungated, so no value could change anything.
- **The "Your part" column on the review queue.** The removal stands, but the original argument for
  it was wrong and is worth stating correctly, because an agent checked it against the code rather
  than inheriting it.

  The claim was that the column "printed the same sentence on every row". It did not.
  `review-queue.vue` models four parts and chips three of them: Blocked, Not handed over, and
  Outcome sign-off. Only the ordinary code-review row is bare. The accurate argument is narrower and
  survives: the chip marks the exception, and on an ordinary row a "Code review" pill would say
  exactly what the button beside it already says - `actionLabel()` returns "Open the brief" when
  blocked, "Sign off" when the outcome is outstanding, and "Review" otherwise. Every row does say
  which of the two questions is being asked; it says it in the control rather than in a pill next to
  the control.

  Note the design has the same redundancy, drawing both the pill and the action button on one row.
  So the promise is stale in its literal form and satisfied in substance.

**Verdict:** deleting a control is a legitimate outcome, and this product has now done it five times.
