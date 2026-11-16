# ADR 0006 — At-least-once delivery, schedules, and idempotency as a modelling obligation

- **Status:** proposed, 2026-10-09
- **Decides:** what the infrastructure under a model is assumed to do, and what that demands
  of the model
- **Amends:** ADR 0004 §1 (edge-triggered quantifiers), design.md §2 (the turn loop),
  requirements R15 (determinism). **Resolves:** Q12.

## Context

Iteration 1's engine delivers each message exactly once, in FIFO order, with policies
evaluated in declaration order. That is a comfortable fiction. The infrastructure these
models describe is **at-least-once with no guaranteed global order**: a message may arrive
twice, messages may arrive in an order nobody intended, and aggregates are expected to cope.

A model validated against the fiction is not validated. Two probes against the reference
model, before this ADR:

```
FAIL  the same part payment delivered twice → Order.paid should be 40 but is 80
FAIL  both lines ship before payment        → Order stranded in `shipping`, both lines final
```

The first is an idempotency failure in the model. The second is a *kernel* failure: edges
computed while the parent was elsewhere were lost, and nothing re-checked.

## The principle underneath both: derive, don't accumulate

`assign: { paid: paid + command.amount }` reads the field it writes. That is an
**accumulator**, and it is the one shape a redelivery corrupts — each delivery moves the
state further.

Everything that survived the probes is a **derivation**:

- the child tally is computed from the children's current states rather than incremented, so
  a duplicated `LineShipped` yields `before == after` and no edge at all;
- `OrderLine#${event.orderId}-${item}` derives the child's identity from the event payload,
  so a duplicated `OrderPlaced` addresses the same lines instead of creating a second set. A
  generated or sequential id would have silently doubled them.

This is the same lesson as "prefer a derived deadline over a latch", arriving from a
different direction. Under at-least-once it stops being taste and becomes correctness.

## Decision

### 1. Determinism is parameterised, not abandoned

A run is reproducible given a **schedule**: model + scenario + schedule ⇒ byte-identical
trace. The schedule becomes an input you vary, rather than an accident you inherit. R15 is
rewritten accordingly.

### 2. The minimum useful scheduler

- **`fifo`** — the default, and the one readable story. A workshop needs a narrative.
- **`random(seed)`** — arbitrary interleaving, reported with its seed so any failure
  reproduces exactly.
- **`duplicate`** — every command and every event delivery happens twice.

Messages are reordered and duplicated, **never lost**: that is what at-least-once means, and
it usefully bounds the search.

Deliberately *not* built: adversarial search, failure-case shrinking, and holding messages
in flight across a clock advance. Those are real model-checker territory; this is the
minimum that catches the two failure classes above.

### 3. Idempotency: declared keys, with natural idempotency still first-class

A transition may declare `idempotency: <expression>`. The instance records
`<command>:<identity>` and applies it at most once. Omit it when the transition is
*naturally* idempotent — when a repeat lands in a state where nothing handles it, which is
true of most lifecycle commands (`Ship` twice: the second finds `shipped`).

Two rules that matter more than the mechanism:

- **The kernel never dedups silently.** A recognised repeat is written to the log as its own
  entry kind. An infrastructure-level "exactly once" layer would hide the modelling
  obligation, which is the opposite of what this tool is for.
- **The identity is a domain fact.** `command.paymentId` is a payment's identity, not a
  message id. Dedup belongs in the model, where it can be read and argued about.

Policies take keys on the same terms, because a redelivered event otherwise makes a policy
reissue its command.

### 4. Quantifiers split into predicates and edges — and this resolves Q12

ADR 0004 put two different things under one roof and gave them one mechanism. Under
reordering the difference becomes load-bearing:

- **Predicates** — `all_final`, `any(s)`, `none(s)` — depend only on the children's current
  states. Reorder, duplicate, delay: the truth is the same once things settle. They are
  evaluated **on entry to their state and on every tally change**, fire **once per
  occupancy**, and **re-arm on re-entry** — exactly like a timer (ADR 0005 §5).
- **Edges** — `first_entering(s)`, `last_leaving(s)` — are moments in history. Whether one is
  *observed* depends on where the parent happened to be at that instant, so under reordering
  an edge may simply never be seen. That is honest for a notification and fatal for a state
  change.

So the stranded-order bug is fixed by making `all_final` mean what it looks like it means,
and the `allow_empty` flag becomes meaningful at last — before this it could only ever
suppress a firing, never enable one, because an edge needs `!pred(before) && pred(after)`
and the flag makes `pred(empty)` true.

A dropped edge is now a **warning**, not an `info`: a `first_entering` nobody heard means a
notification the business expected never happened.

### 5. Two lints the loader emits

Legal but suspect, given §1–§4:

- an `assign:` whose expression reads the field it writes, with no `idempotency:` declared —
  *"accumulates; a redelivery would apply it twice"*;
- an edge trigger with a `target:` — *"a moment, not a condition; under reordering it may
  never be observed, and driving a state change from it can strand the instance"*.

Warnings, not errors. The modeller may know better; the tool should still say it.

### 6. Interleaving is per instance

Commands to one instance are serialised — that is what the consistency boundary buys, and it
is why an aggregate is the unit. Interleaving happens *between* instances. Whether to also
model optimistic-concurrency conflicts (two concurrent writers, one rejected on a stale
version) is left open; it needs its own ADR.

## Consequences

- **The default run is still the comfortable lie.** `fifo` by design, because a stakeholder
  needs one story that reads cleanly. The second pass is deliberate: once a model behaves,
  run it under `--schedules` and find out whether it survives reality. All nine reference
  scenarios now pass under all seven schedules — 63 runs.
- **The board must show messages in flight.** A message in flight is part of the world, and
  a picture that shows only states is incomplete. Snapshots already capture the queue.
- **`applied` grows without bound.** Real systems bound their dedup window; this does not.
  Fine for a simulation, wrong as advice, and worth a note wherever the export lands.
- **In-flight messages do not survive a clock advance.** The clock still only moves at
  quiescence, so "the message that arrived three days late" is not yet expressible. A known
  limitation of the minimum, not a decision against it.
- The idempotency sweep is the natural next mechanical check: deliver everything twice and
  assert the model's observable outcome is unchanged. `duplicate` is that check, run per
  scenario; making it a property over all scenarios is cheap from here.
