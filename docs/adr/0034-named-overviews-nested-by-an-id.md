# ADR 0034 — Named overviews: a second picture of a run, nested by an id

- **Status:** proposed, 2026-11-18
- **Decides:** how a model offers more than one overview of a run — rooted elsewhere, nesting
  aggregates that name each other by an id, and naming each unit with the main overview's root it
  belongs to
- **Forced by:** a reader who wants a run seen from what carries the units rather than from what
  ordered them: each carrier with the containers booked onto it, each container with the units of
  several orders in it, every unit named with its order — compact, without the orders' steps and
  tasks. The carrier and the container are aggregates that name each other by an id, not parent and
  child; and a container exists before any carrier is booked to it.

## Context

The overview (design §8, ADR 0023) is one configuration: its roots, what folds, what is a sequence.
It nests an instance under its parent — an aggregate's own entities (ADR 0004, ADR 0012) — so two
aggregates that only name each other by an id stand side by side, flat, in the side lane or among
the roots.

`lab` shows the shape once it has cool boxes (scenario 12): a `CoolBox` is packed at a clinic for one
lane, with the samples of two requests in it — a `BoxSlot` per sample, pointing at it — and a
`VanRun` is booked to the box later. A reader wants each van run with its boxes under it, and a box
not booked yet on its own; under each box its samples, each with the request it belongs to. The
request overview cannot say this: there, the request is the root and its steps fill the page.

Making the run own its boxes was not an option: the box is planned before any run exists, and each
is told things on its own — two aggregates, by the model's own decision.

## Decision

1. **`overview.views`: further overviews, by name.** Each is a block with the overview's own keys —
   `roots`, `hide`, `omit`, `side`, `label`, `color`, `events`, `attributes`, … — read as an overview
   of its own: nothing is inherited from the main one. A view has no `views`, `flow` or `journey`.

   ```yaml
   overview:
     roots: [Request]
     views:
       Vans:
         roots: [VanRun, CoolBox]
         under:
           CoolBox: { parent: VanRun, by: run }    # the box's field `run` names the van run
         hide: [BoxSlot]
         badges: roots
         label:
           VanRun: "${origin} → ${destination} · ${departs}"
           CoolBox: "${origin} → ${destination}"
   ```

2. **`under: { Type: { parent: Type, by: field } }`** — an instance of the type that has no parent of
   its own is drawn under the instance of `parent` (or a subtype) whose id its field holds, as if it
   were its child: in a row, its own children folded or drawn as anywhere else. **While the field
   names nothing that exists** — empty, or not created yet — it is parentless as before: a root if its
   type is one, else in the side lane or among the others. The nesting is read at each frame, so the
   box moves under its van run the moment it is booked. An entity, which has its parent, is never
   moved. The loader refuses a type or parent that is not an aggregate, a field neither declares
   (`overview.views.Vans.under.CoolBox: CoolBox has no field \`rn\``), and a nesting that loops.

3. **`badges: roots`** — on a folded child's badge, and on an event's, the unit it names is followed
   by the roots of the *main* overview that carry it (`S1 · R1`): the request a sample belongs to, seen
   from the van. A unit no main root carries keeps its bare badge.

4. **The workbench** offers the main overview and each view by name in the overview's header; the
   choice travels in the link (`overview=Vans`). Selecting, scrubbing and the events' switch are the
   same in every view. The Journey and the flow board read the main overview only.

## Consequences

- A model can draw the same run for two readers — what was ordered, and what carries it — without
  folding one of its aggregates into another to please a picture.
- `under:` is a picture's nesting, not the model's: references, routing, roll-ups and the check do not
  see it. A count across it (how many boxes on a van) is the reader's, not a state.
- Rejected: inheriting the main overview's keys in a view (two configurations that change together
  are harder to read than one that repeats a label); nesting by a reference (fixed at creation, so a
  box booked later could not move); a Journey per view (left for when a reader asks for it).
