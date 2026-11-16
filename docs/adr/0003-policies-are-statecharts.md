# ADR 0003 — A policy is a correlated statechart, not a one-liner

- **Status:** proposed, 2026-10-09
- **Decides:** how a rule remembers things (answers Q1, first half)

## Context

`on OrderPaid do Shipment.Request` carries no memory, and the rules that matter usually do:

- "ship once paid **and** stock reserved" — wait for two events in either order
- "only the first time" — react once per correlated subject
- "cancel unless confirmed within ten minutes" — a deadline that an event can defuse

All three need a rule instance with state and a deadline. The question is where that state
lives.

## Options

**A. Keep policies stateless; push the memory into an aggregate.** Invent a
`ShippingDecision` aggregate that collects the two events. Sometimes this is exactly right —
if the waiting *is* a domain concept, it deserves a name. Often it is ceremony that invents
a noun nobody in the business uses, and it buries the rule.

**B. Policies with an ad-hoc data bag.** Give a policy variables and let expressions update
them (`seen_paid = true`). Cheap to build, but it is a second, informal execution model
sitting next to the statechart one: no states to show on screen, nothing to assert against,
nothing to draw.

**C. A policy is a statechart with a correlation key.** The same kernel as an aggregate,
mirrored: an aggregate consumes commands and raises events; a policy consumes events and
issues commands.

## Decision

**Option C.** One execution model for everything.

```yaml
policies:
  ship_when_ready:
    correlate: event.orderId          # which instance of this policy
    initial: waiting
    states:
      waiting:
        on:
          OrderPaid:        { target: paid_only }
          StockReserved:    { target: stock_only }
      paid_only:
        on: { StockReserved: { target: ready } }
      stock_only:
        on: { OrderPaid:     { target: ready } }
      ready:
        on_entry: { command: "Shipment#${correlation}.Request" }
        final: true
```

- **`correlate` is mandatory and explicit.** The most common saga bug is a wrong correlation
  key, and it is invisible in most frameworks. Here it is one declared line, and the UI lists
  the live instances keyed by it.
- **Policies issue commands; they never raise events.** Events are facts raised by an
  aggregate as part of a transition (R4). Keeping that one-way preserves the grammar the
  board is built on.
- **A stateless policy is a single-state policy.** The short `on: X / command: Y` form from
  §3 of the design stays as sugar over this, so there is one concept, not two.
- **Timers work as they do in aggregates** (`after:`), which is what makes the
  cancel-unless-confirmed shape fall out for free.

## Consequences

- Policy instances are first-class on screen: a purple sticky with a current state, visible
  in the trace, assertable in scenarios (`state: { ship_when_ready#A1: paid_only }`).
- A policy that reaches no final state is a leak; coverage (R33) should flag instances left
  hanging at the end of a scenario.
- The kernel grows no new machinery — policies reuse the aggregate interpreter with the
  input and output sides swapped.
- Two rules with memory can now disagree about the same subject. That contradiction is a
  finding to surface (R22), and arguably the most valuable thing a workshop can discover.
