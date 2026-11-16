# ADR 0004 — Parent/child relations with a derived tally and quantifier rules

- **Status:** proposed, 2026-10-09; §1 amended by ADR 0006 §4
- **Decides:** "first child reaches X ⇒ parent goes to Y" and "all children final ⇒ parent
  completed" (answers Q1, second half)

## Context

Two rules that any real model wants:

- **existential** — the first line ships, so the order becomes *partially shipped*
- **universal** — every line is finished, so the order is *completed*

Both are quantifiers over the states of *other* aggregates. That collides directly with R6:
a guard reads only the aggregate's own state and data. The collision is not an accident —
it is the aggregate boundary doing its job — so the resolution has to be deliberate.

## Options

**A. Let the parent's guard read its children's states.** `guard: all(children.state == final)`.
Obvious, and it is what everyone reaches for.

Rejected. It is a synchronous read across a consistency boundary, which is a lie in every
system this tool is meant to describe: it makes the parent's invariant depend on state the
parent does not own, it reintroduces "what if a child changes mid-evaluation", and it
renders the eventual-consistency gap invisible. Making that gap visible is the point of the
tool. Shipping the convenient lie as the headline feature would be self-defeating.

**B. Hand-written policy plus counters in the parent.** The by-the-book answer: a policy
reacts to `LineCompleted`, issues `Order.NoteLineCompleted`, the parent increments
`completed`, and a guard compares `completed` to `line_count`.

Honest, and it is what real code looks like. But every model re-types it, the off-by-one is
the modeller's problem, and the interesting rule — "all lines done" — ends up buried in
arithmetic. Poor for teaching, and poor for a workshop where the business owner needs to
read the rule off the screen.

**C. Declare the relation; let the kernel derive a tally; write the quantifier.**

## Decision

**Option C.** The relation is declared, the tally is derived from the log, the rule is
written as a quantifier, and delivery stays asynchronous.

```yaml
aggregates:
  Order:
    children:
      lines: { type: OrderLine, via: command.orderId }
    states:
      fulfilling:
        on_children:
          lines.first_entering(shipped):
            target: partially_shipped
            emit: [ OrderPartiallyShipped ]
          lines.all_final:
            target: completed
            emit: [ OrderCompleted ]
```

Semantics, each chosen on purpose:

1. **Edge-triggered, not continuously evaluated.** An `on_children` rule fires on a *change*
   to the tally — `first_entering(shipped)` is the change where `count(shipped)` crosses
   0→1; `all_final` is the change after which the predicate holds and did not before. No
   re-firing, no polling.

   > **Amended by ADR 0006 §4.** This was wrong for half the vocabulary. Under at-least-once
   > delivery with no guaranteed order, `all_final` / `any` / `none` are *conditions* and must
   > also be evaluated on entry to their state — edge-only triggering stranded a parent whose
   > children finished before it was listening. Only `first_entering` and `last_leaving`
   > remain edges.

2. **Still asynchronous, still one instance per transition.** A child's transition updates
   the derived tally, which enqueues a command to the parent, which transitions in a later
   step of the same cascade. The trace shows child → tally → parent, so the gap the parent
   lives with is on screen rather than hidden behind a convenient guard.

3. **Universal quantifiers are false on an empty collection.** `lines.all_final` on an order
   with no lines is vacuously true in logic and a bug in practice — an order would complete
   the instant it was created. `all_*` therefore yields false when the collection is empty,
   and a modeller who means the vacuous reading opts in with `allow_empty: true`. A safe
   default beats a required incantation.

4. **"Final" means root-level final.** Now that states nest (ADR 0005), a child counts
   toward `all_final` only when the active state in its *root* region is final. A final leaf
   inside a still-running composite does not make the child done. A child aggregate's state
   is otherwise entirely independent of its parent's — the two lifecycles are unrelated, and
   the tally is the only coupling.

5. **A child is a separate aggregate, not an entity inside the parent.** If something must
   change in the same breath as the parent, it is the parent's *data*, not a child. The tool
   should say this out loud when someone reaches for a child to hold a field.

6. **Children are created explicitly** — by a command, or by `for_each` fan-out in a policy
   (`for_each: event.items → command: OrderLine.Create`). That fan-out is the single place
   the expression language touches collections, which keeps Q4 otherwise scalar.

7. **A child arriving after the parent is final is a modelling error**, reported as a finding
   (R22), not quietly accepted.

8. **Depth is allowed.** A child may be a parent in turn; tallies propagate one level per
   step of the cascade, which the trace makes visible.

9. **v1 vocabulary:** `all_final`, `first_entering(s)`, `last_leaving(s)`, `any(s)`,
   `none(s)`, plus `<rel>.count` and `<rel>.finals` as values a guard can read.
   *(Implementation note: the argument is positional — `any(shipped)`, not `any(in: shipped)` —
   because a YAML mapping key cannot contain `: `.)*

## Consequences

- **The sugar is a teaching device, not a shortcut.** The inspector can expand an
  `on_children` rule into exactly the option-B machinery it stands for — generated policy,
  counter, guard — so a learner sees what the convenience costs in real code, and an
  engineer gets a blueprint for implementing it.
- The tally is derived from the log like everything else, so time travel and forking keep
  working with no special case.
- The wiring view gains parent/child edges, distinct from policy edges; the board needs a
  stacked sticky to show a collection without drawing a hundred lines.
- Rejecting option A means someone will eventually ask for it. The answer is the expanded
  form in the inspector — and if it keeps being asked, that is evidence, not noise.
