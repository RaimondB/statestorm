# ADR 0012 — Aggregates, entities and value objects

- **Status:** proposed, 2026-10-16
- **Decides:** the three kinds of type a model declares, what each may do, and how a command
  reaches an entity
- **Builds on:** ADR 0004 (parent/child relations), ADR 0007 (references and routing by
  reference), ADR 0008 (inheritance)
- **Forced by:** a domain's owner, on seeing the model as an ERD, asking for a clean distinction
  between aggregates, entities and value objects (they chose the strict option below)

## Context

Until now every type was an *aggregate*: an identity, a statechart, addressable by anyone. A
task and the handlings under it were aggregates of their own, each a separate message, each
roll-up a separate step. That is not what the domain says. A site visit's task and its handlings are
*part of* the site visit: the visit is the thing that is consistent or not; nothing
outside should point at a handling, or tell one what to do.

## Decision

1. **Every type declares its kind:** `kind: aggregate` (the default), `kind: entity`, or —
   in the `values:` section — a value object. A subtype has its supertype's kind.

2. **An aggregate** is a consistency boundary. It has an identity and a lifecycle (its
   statechart); people and policies send it commands; it raises the events. It may be the
   child of another aggregate (a Route of a Request): that is a relation between
   two boundaries, by id, and its roll-up is a message between them, as before.

3. **An entity** has an identity and a lifecycle too, but *inside one aggregate*: it is owned
   by exactly one owner (its aggregate's root or another entity of it) through a declared
   relation, and its aggregate is the nearest owner that is an aggregate. The loader refuses
   an entity no relation owns.

4. **Commands only to aggregates (strict).** A command addressed to an entity from outside
   its aggregate is refused — at load, when a policy names the entity type literally; at run,
   as an error finding, otherwise (a person's command, a computed target).
   - An owner reaches its entities with **`send:`** in its own transitions — to create them
     (a step plans its own tasks; a task its handlings) and to pass a command on (a
     deviation's resolution hands a decision to the sample's handling). `send:` may only reach the sender's own
     aggregate: `{ to: "Type#id.Command", with, for_each }`, or `{ children: rel, command:
     Name, with }` for every child in one of its relations.
   - **Routing by reference through the aggregate.** `for_each_referrer: Handling.sample`, where
     the handlings are entities, sends *one command per aggregate* that holds such handlings
     — not one per handling — and the aggregate delivers it to exactly those handlings. The
     policy still says which entities the event is about; the aggregate is what receives it.

5. **An aggregate's step settles inside it.** Everything an input causes to its own instances
   — commands its owners `send:`, their roll-ups into owners in the same aggregate, completion
   signals — is processed before the next input is taken. Only events leave the boundary,
   and only through policies. So a handling, its task and its site visit change in one step, and
   under any delivery schedule they are never seen half-moved. Between aggregates nothing
   changes: messages, at least once, in any order (ADR 0006).

6. **Quiet inside.** An entity reached by routing that has no answer stays silent; the
   aggregate logs one `ignored` when nobody inside answered. A guard that could not be
   evaluated is still a loud `rejected` (R21).

7. **A reference into another aggregate's entity** is a warning at load: point at the root.

8. **A value object** has no identity and no lifecycle: a named, unchangeable set of fields,
   compared by value (`TubeRow: { sample: string, tube: string }`). It is declared under
   `values:` and may be a data field's type and the declared shape of a payload's rows. A
   list of them is a payload, never a field (the accumulator of ADR 0007 stays rejected).
   *Revised by ADR 0015:* a field may hold a list of value objects, one per key, changed by `put:`.

9. **How it is drawn** (decided with the rest, 2026-10-16; written down 2026-11-06). The structure
   view says on every box what it is — «aggregate», «entity», «value object». An aggregate that owns
   entities is drawn as a **frame around itself and the entities it creates**: its boundary, as ADR
   0013 §2 places an entity. A value object is a **box of its own**, outside every frame, with a
   dashed *uses* line from each type that holds it in a field or takes it in a command — shared by
   value, owned by none.

## Consequences

- The domain's model is cut accordingly: steps, requests, routes, samples, deviations and
  what the patient is told are aggregates; tasks, handlings and precedence links are entities; the plan rows and the scan are value objects. The planning policies that
  created tasks and handlings from outside disappear: each owner `send:`s its own.
- A person's decision on a deviation is addressed to the step it was raised at, naming the
  sample, not to a handling.
- The trace is shorter: one message per aggregate per scan, and no `ignored` line for every
  handling at another site.
- Models without entities (sales, claims) behave as before, except that an aggregate's own
  completion signal (`done.X`) settles in its step rather than as a later message.
- Rejected: commands to entities allowed and merely *labelled* as going through the
  aggregate (the lenient option) — it would draw the boundary without meaning anything;
  entities as nested data inside one aggregate's statechart — every handling would lose its
  own lifecycle, which is where the per-sample outcome lives.
