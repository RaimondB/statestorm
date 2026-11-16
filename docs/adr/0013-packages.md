# ADR 0013 — Packages: which types belong together

- **Status:** proposed, 2026-10-16
- **Decides:** how a model groups its types into packages (DDD modules), and how an entity's
  package and aggregate are found
- **Builds on:** ADR 0008 (inheritance), ADR 0012 (aggregates, entities, value objects)
- **Forced by:** a domain's owner, on the ERD: the generic step and task in a package of their
  own, and each concrete kind of step with its related concrete types in a package of its own,
  so that it is clear where the ownership belongs — the generic package just a commonly used
  component

## Context

ADR 0012 drew each aggregate's boundary around the entities its *declared relation* owns.
With inheritance that is the wrong place: `tasks` is declared on the abstract `Step`, so
every concrete task — site visit, courier run, tube run — was drawn inside the generic Step, and
nothing showed that a site visit owns site tasks and a tube run tube tasks.

## Decision

1. **`packages:`** is a top-level section: `Name: [types]` or `Name: { note, types }`, in the
   order they should be read. Every name must be a type of the model (aggregate, entity or value
   object); a type is in one package at most. A type in no package is drawn loose.
2. **An entity belongs to the aggregate that creates it.** Who creates what is read from the
   model's `send:` (ADR 0012 §4): a site visit sends site tasks, a site task its handlings —
   so both sit in the site visit's boundary. An entity nothing creates (an abstract Task) falls
   back to the type that declares the relation owning it: the generic shape stays with the
   generic Step. An entity **several kinds of aggregate create** (2026-10-19: the
   hand-over at the receiving lab, planned by a courier run and a tube run alike) is a part they share: it
   goes with the **nearest supertype they have in common** (Transfer) — drawing it inside one
   of them would say the other does not own its own, and putting it with the most generic type
   would say every step can have one.
3. **An entity's package is its aggregate's.** Packages list aggregates (and value objects);
   their entities come along. Listing an entity in another package than its aggregate's is
   reported, because it would draw ownership wrong.
4. Packages are documentation with checked names: they change nothing at run time.

## Consequences

- The domain's model has a generic Steps package (Step, Transfer, Task,
  Handling — the lifecycle and roll-up every step shares) and one package per kind of
  step, each holding the aggregate and the concrete tasks and handlings it owns.
- Rejected: a `package:` key on each type — the grouping would be scattered over a long file,
  where a reader looking for "what is in the site-visit package" finds it nowhere in one place.
