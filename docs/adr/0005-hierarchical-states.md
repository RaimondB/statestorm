# ADR 0005 — Hierarchical states; the active state is a configuration

- **Status:** proposed, 2026-10-09
- **Decides:** nested states, and what "the state of an aggregate" even is (answers Q5)
- **Supersedes:** the "flat states in v1" lean in design.md §3

## Context

The v1 lean was flat states, to keep the kernel small. That is overturned: nesting is a
requirement, and a child aggregate's state is independent of its parent's (ADR 0004).

Flat loses on three concrete things, not on elegance:

- **Shared handlers.** `Cancel` applies from every substate of `Fulfilling`. Flat means
  repeating that transition on each one, and silently omitting it from the one added later.
- **Scoped deadlines.** "The whole of fulfilment must finish within 30 days" is a timer on
  the composite that survives substate churn. Flat cannot express it; you get a timer per
  substate, each restarting the clock.
- **Readability.** Phases × sub-phases as a flat product (`fulfilling_awaiting_payment`,
  `fulfilling_awaiting_stock`, …) explodes, and the explosion lands on the statechart view
  and the board, where the business owner is looking.

## Decision

### 1. The active state is an ordered configuration, not a scalar

A root-to-leaf path: `[Fulfilling, AwaitingPayment]`. Both are active simultaneously —
that is what nesting means, and it is what makes a parent state's handlers and timers apply
while a substate is running.

The configuration is stored as a **set of paths**, even though v1 always produces exactly
one. Parallel regions are deferred (§Deferred), and this is what keeps that deferral cheap:
adding them later extends the kernel instead of re-representing its central type.

### 2. Transition resolution is innermost-first, with bubbling

The deepest active state with a matching transition whose guard passes wins. If no
transition at that level fires, the event bubbles outward to the ancestor. A **guard failure
does not stop the search** — it continues outward, so an outer handler can be the fallback
for an inner refusal.

### 3. R21 therefore reports a rejection chain, not a rejection

When a command changes nothing, the tool lists every candidate it considered: which state
offered it, which guard was evaluated, what values that guard saw, and why the search moved
outward. Hierarchy makes the "why nothing happened" answer *better* than flat, which is a
pleasant inversion of the usual trade.

### 4. Entry and exit order is defined by the least common ancestor

Exit from the innermost active state outward, up to but excluding the LCA of source and
target; then enter from just below the LCA inward, down to the target's initial leaf. Exit
emissions fire innermost-first, entry emissions outermost-first. Log order is fully
determined and reads as a walk down the path.

### 5. Timers are scoped to the state that declares them

Armed on entry to that state, cancelled on exit. A timer on a composite therefore survives
transitions between its substates — the behaviour flat states cannot express.

### 6. Finality: `done` signals, and one unambiguous meaning for ADR 0004

- A `final` substate completes its **composite** and raises an internal **`done.<State>`
  signal** that the composite's own parent may transition on. This is the clean way to say
  "when the payment sub-process finishes, move on".
- An aggregate is **final** when the active state in its *root* region is final.
- **`lines.all_final` in ADR 0004 means root-level final**, with no ambiguity. A final leaf
  inside a still-running composite does not make a child done, and therefore does not count
  toward a parent's completion.

`done.<State>` is an **internal signal, not a domain event**. It is not a business fact, it
is not raised by an aggregate as part of its public behaviour, and it must be rendered
distinctly from orange stickies. R4 stays intact.

### 7. Expressions and assertions get two forms

- `state == Fulfilling.AwaitingPayment` — exact match on the active leaf, by full path.
- `in_state(Fulfilling)` — true when the configuration contains that state at any depth.

Scenario assertions (R30) use the same two forms, so dotted paths are in the assertion
language from the first scenario file and nothing needs migrating later.

Transition **targets** are dotted paths from the root as well — `fulfilling.shipping`, or a
bare `cancelled` for a root-level state. No relative addressing (`../`), no nearest-match
resolution. A target then means exactly one state, and it is greppable.

### 8. Every composite declares an initial substate

No defaulting to "the first one listed". An omitted `initial` is a schema error, not a guess.

### Deferred, but accommodated

- **Parallel / orthogonal regions** — several substates of one composite active at once
  ("shipping *and* invoicing"). The set-of-paths representation already holds it; resolution,
  fork/join and per-region finality do not. Its own ADR when an example demands it.
- **History states** (`shallow` / `deep`) — cheap once configurations exist, so there is no
  reason to design for them now.

## Consequences

- The configuration is the kernel's central type, and every signature takes it. This is the
  up-front cost of the decision, paid in week one rather than as a rewrite in month three.
- The statechart view needs compound-node layout from the start (ELK handles it); the board's
  stickies show the leaf, with the full path in the inspector.
- A command can be handled at two levels. The UI must show **which level won**, the same way
  it warns about policy declaration order — an inner handler quietly shadowing an outer one
  is a modelling bug that looks like nothing at all.
- `done.<State>` is a third thing in the log alongside commands and domain events. Three
  kinds is still few enough to teach.
- Rejected alternative: flat states plus a naming convention. It is the same model with the
  hierarchy moved into strings, where neither the kernel nor the diagram can use it.
