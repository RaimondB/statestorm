# ADR 0039 — A unit in the overview's side lane says its label and takes its colour

- **Status:** proposed, 2026-11-25
- **Decides:** what a unit in the overview's side lane shows besides its id and its state
- **Revises:** ADR 0023, for the side lane only: `label:` and `color:` were a box's and not a side
  unit's
- **Forced by:** a journey whose units change on the way. A plan is made for a unit that is only an
  estimate, and other units with their own ids take its place later. The side lane showed every
  unit alike, as an id and a state. A reader could not tell a unit still only planned from one that exists, or
  see which unit took whose place. The model knew both, and the overview's `label:` and `color:`
  could already say them on a box.

## Context

In `lab`, the side lane lists the samples a request is about: `S1, tracked · analysed`. A model
whose side lane holds two kinds of unit, such as a sample planned for a request before it is drawn
and the tubes actually drawn for it, showed them in the same green, with no word on what each one
is or stands for. A box in the journey says its `label:` (`to LAB1`) and takes its type's `color:`.
A unit in the side lane took neither.

## Decision

1. **A side unit says its type's `label:`**, under its id and state, filled from its data as a
   box's is (the most specific type's template wins). A label that comes out empty says nothing,
   so a template on a field only some units fill names only those.
2. **A side unit takes its type's `color:`** when the model names one, a family's darkest tint as a
   root box takes it. A type the model does not colour keeps the side lane's own green.
3. `lab` labels its samples with their request (`for ${request}`).

## Consequences

- A model can tell units still only planned from actual ones in the side lane, and say what each stands for,
  with configuration it already writes for boxes. Nothing is inferred: without a `label:` or
  `color:` for the type, the side lane is as before.
- The test proves the label, the colour, and that an empty label says nothing.
- **Rejected:**
  - **A heading per type in the side lane.** It would split units that belong together, such as a
    sample still only planned and the tubes that took its place, and the order would no longer be the order they
    came into being.
  - **A `side`-only label key.** One `label:` per type is enough: a type is either in the side lane
    or a box.
