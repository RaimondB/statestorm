---
name: capture-drawing
description: Turn a business drawing (swimlane flow, status diagram, scenario slide) into statestorm data — drawings/<drawing>.yaml in the domain folder with lanes, legend paths, colours and a decision per arrow — and record every drawing/model difference in issues.yaml for the stakeholders. Use when the user shares a diagram or asks whether the model matches one.
---

# Capturing a drawing

A drawing is the business's own statement of the process. Captured as data, the model check can
say which of its arrows the scenarios walk, and every place the two disagree becomes an issue the
stakeholders can confirm — a clean list of drawing changes after a series of sessions.

## Read it properly

- Images drop out of context: capture a drawing **as soon as it is shared**. If it is gone, find
  it again (the session transcript keeps the images) rather than working from memory.
- **Zoom in.** Line colours and arrowheads are only legible enlarged — crop regions at 2× before
  reading. Colours carry meaning: the legend names paths (a cancellation, a refusal, an
  exception route), and the same arrow can be on two paths.
- Note what is not a status: triggers on the page (a parallelogram for an external request, a
  circle for a flow that joins here), legend boxes, "End" markers.

## The file

`drawings/<drawing>.yaml`, in the domain folder:

```yaml
drawing: <the drawing's title>
source: <who shared it, when>
scenarios: [<scenario file prefixes that walk this drawing>]
lanes:                                   # every box, in the drawing's words, in its lane
  <Lane>: [<Box>, <Box @ Lane>]          # `@ Lane` only for a box drawn in two lanes
outside: [<trigger>, ...]                # on the page, not a status
names: { <drawing's word>: <ModelEvent> }  # only where the words differ
paths:
  main: { colour: black }
  <path>: { colour: <colour>, meaning: <legend text>, later: <why>, scenarios: [<prefix>] }
arrows:
  - A -> B                               # no decision: in the model
  - A -> B: { path: <path> }
  - A -> B: { later: <why> }             # deferred scope
  - A -> B: { open: <question id> }      # not decided
  - A -> B: { no: <why> }                # the model does it differently
unmodelled: { <box>: <why> }             # a status the model does not have (yet); its arrows need a decision
customer:                                # boxes the drawing marks as telling the customer
  notice: <the event the model raises when it tells the customer>
  boxes: [<box>, ...]
```

- `scenarios:` absent means every scenario; `[]` means none walks this drawing yet.

- Use the drawing's own words; `names:` maps them once. A name that maps to no status is an
  import error — fix the map or raise the question, don't drop the arrow.
- Every arrow gets a decision. A path's decision covers its arrows.
- `scenarios:` ties the drawing (and a path) to the runs that walk it; the check compares it with
  those only — the same arrow shown in another flow does not count for this one.

## Every difference is an issue

When the drawing and the agreed model differ — a slip, a shorthand, a sequence the owner
corrected, a colour that says the wrong thing, a name used differently — add an entry to
`drawings/issues.yaml` **in the same commit as the decision**:

```yaml
- id: D-NN
  drawings: [<drawing file stems>, or all]
  says: <what the drawing shows>
  should: <what was agreed>
  why: <the decision behind it, by id, e.g. Q-3 — the check traces the ids it names>
  status: to confirm        # open | to confirm | confirmed | done
```

`--issues` on the check CLI prints the list as Markdown for the stakeholders.

## Then

Run the check (skill `model-check`): the drawing must import with no errors; its drawn arrows
that no scenario shows are the next scenarios to write (skill `scenario-loop`) or decisions to
take back to the owner (skill `domain-session`).
