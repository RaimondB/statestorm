# ADR 0007 — References, and routing an event to everything that points at its source

- **Status:** proposed, 2026-10-10
- **Decides:** how an aggregate points at another without either calling it or being known
  by it, and how an event reaches every aggregate that points at the one that raised it
- **Forced by:** a domain modelled line by line with its owner, where one scan of a thing that
  moves must reach every step planned for it, without the thing or the scan knowing those steps

## Context

A sample is scanned: "PickedUp, at CLINIC1". That one scan completes the clinic visit's
outbound *and* the courier run's pickup, and means nothing to the lab's site visit the same
sample is planned through later. Three constraints, all stated by the domain owner:

- the **sample must not know** which steps or tasks it is on;
- the **scan does not carry the step** — the scanner does not know it;
- the steps and tasks **point at the samples** they handle.

None of the existing mechanisms can route that scan:

| Option | Why not |
|---|---|
| The sample keeps a "current step" pointer | Rejected by the domain owner, and a single pointer cannot hold "outbound here *and* pickup there" |
| The scan carries the step id | The scanner does not know it |
| A routing policy holds a sample → tasks table | Policy data is flat scalars; a table is a list, and appending to it is the accumulator ADR 0006 warns about |
| Aggregates subscribe to events | Breaks ADR 0003: policies are the only wiring, aggregates take commands |
| A set-valued reference on each task (`samples: [S1, S2]`) | Answers routing, but leaves nowhere for the per-sample outcome that "partially completed" needs, and appending is again an accumulator |

## Decision

1. **A reference is a declared, scalar pointer** to another aggregate instance, by id:
   `references: { sample: { type: Sample, via: command.sample } }`. It is set once, from the
   creating command — the same shape as a parent's `via:` — and never changes. It is
   readable in expressions by its name (the id).
2. **A many-to-many is an aggregate of its own**, holding one reference: one *handling* per
   sample per task. That is where the per-sample outcome lives, which is the real reason — not a
   workaround. A task rolls its handlings up with the ordinary child quantifiers.
3. **The kernel keeps the reverse index** — instance → everything pointing at it — derived at
   creation, exactly as the child tally is derived rather than stored. The instance pointed at
   holds nothing.
4. **A policy can fan out to referrers of the event's source:**
   `for_each_referrer: VisitHandling.sample` issues the command to every `VisitHandling` whose `sample`
   points at the aggregate that raised the event, in creation order. `${item}` is the
   referrer's key and `${eventName}` the event's name, so `command: "${item}.${eventName}"`
   hands each one the scan under its own name.
5. **Such a command is a broadcast.** Most referrers have no answer — the lab's inbound has
   nothing to say about a scan at the clinic. A referrer with no answer, or whose guards all
   fail, logs **`ignored`** (with the rejection chain, when there was one) instead of
   `unhandled` or `rejected`: recorded, inspectable, but not a fault. The trace folds them away
   unless asked.
6. **Reaching no one is a warning** — when *nothing at all* points at the raiser, once per
   event. An empty fan-out for one kind of referrer is normal when several policies each
   route to one kind (site and transfer handlings, routed separately at first).
7. **The loader checks** that a `for_each_referrer` names a real aggregate and a real
   reference, that it is not combined with `for_each`, that policies declare no references
   (they are identified by correlation), and that a reference name does not collide with data
   or children.

8. **Amended 2026-10-10: the instance pointed at can be named.** `for_each_referrer: { via:
   RouteHandling.sample, of: "${event.sample}" }` reaches what points at the sample the event is
   *about*, when the raiser is something else — a transfer's handling announcing its progress,
   mirrored by the route's own handling for the same sample. `of` yields an id (or a
   key, for an abstract type, ADR 0009 §3). A reference to an abstract type is likewise held as
   a key.

## Consequences

- Each task interprets a scan in its own guards (`kind == 'outbound' and command.site == site`),
  which is what the domain owner asked for, taken literally: the meaning lives with the task, not in a routing table.
- **Broadcast is noisy.** In slice 1's happy flow, 58 `ignored` entries accompany 64 real
  transitions. Folding them in the trace is the mitigation; routing on a qualifier (index by
  sample *and* site) is the alternative if the noise starts to hide things.
- Under redelivery a broadcast stays harmless: the scan's own id stops a repeated scan at the
  sample, and a repeated broadcast lands on a handling already past that step.
- References are immutable. A sample moving to a new task gets a new handling, not a re-pointed
  one — the history of where it was stays true.
- Found while building it: two parent types declaring the same child type filed the child
  under both and linked it to whichever was declared last — a silent wrong answer. The loader
  now refuses it until polymorphic children exist.
