# ADR 0011 — Classified relations: counts per class of child

- **Status:** proposed, 2026-10-10
- **Decides:** how a parent rule distinguishes kinds of children within one relation
- **Builds on:** ADR 0010 (per-state counts)
- **Forced by:** a domain modelled line by line with its owner, where a step fails when the
  latest task it reached failed, and a step can have several start and several final tasks

## Context

ADR 0010 let a roll-up count children by state. That rule needs more: *which* tasks failed. A transfer
whose pickup worked and whose delivery failed is **failed** — the delivery is what it was for —
while one whose pickup was partly refused and whose delivery then completed is **partially
completed**. Counting failed tasks cannot tell those apart; knowing each task's place in the
step can.

Naming "the first task" and "the last task" per step type was the obvious way, and wrong:
a route collects at several clinics — several start tasks — and a site visit's storage
task is optional.

## Decision

1. A relation can **classify** its children by one of their data fields:
   `tasks: { type: Task, via: …, classify: { by: stage, values: [start, middle, final] } }`.
2. Rules read counts per class as they read counts per state (ADR 0010):
   `tasks.stage.final.in.failed`, `tasks.stage.middle.count`, `tasks.stage.start.finals`.
   Every declared class is **zero-filled**, so a step without a middle stage has
   `tasks.stage.middle.count == 0` rather than a missing reference.
3. A child whose field holds a class the relation does not declare is counted in the totals
   and **reported once** as a warning — never quietly counted nowhere. An empty value means
   "not classified yet" (the creating command has not set it) and is not reported.
4. The loader refuses a classifier naming a field the child type does not have, or one that
   would collide with the tally's own names (`count`, `finals`, `in`).

## Consequences

- The rule is written once, on the abstract Step, in the domain owner's words: a stage is
  *reached* when some task in it was not "not needed"; the step fails when every reached
  task of the latest stage reached failed; completes when every task completed; is partially
  completed otherwise. Several final tasks with mixed outcomes is partial, as it should be.
- It needs tasks that are never reached to *end*: a task whose every sample stopped upstream ends
  **not needed**, and a step whose every task is not needed ends not needed — "later
  steps do not start", made visible. That is an addition to the task and step
  lifecycle, raised with the domain owner as such.
- Classes are counted at the top-level state of each child, like ADR 0010; classifying by
  more than one field at once is not supported.
