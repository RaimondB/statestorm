# ADR 0009 — Polymorphic relations: a type in a relation stands for its subclasses

- **Status:** proposed, 2026-10-10
- **Decides:** how a relation, a quantifier and a referrer fan-out treat an abstract type, and
  how a child finds its parent when more than one relation could hold it
- **Amends:** ADR 0004 §1 (one parent relation per child type)
- **Forced by:** a domain modelled line by line with its owner, where a route holds site visits
  and transfers in one journey, transfers converge, and a route is also a step

## Context

With inheritance (ADR 0008) a route's steps are site visits, courier runs and a tube
run — different types, one journey. ADR 0004's relations name exactly one
child type, and the loader refused a child type claimed by two parent types (a guard added in
ADR 0007, after finding the kernel silently filed such a child under both). Slice 1 lived
with that by duplicating task and handling types per step type.

Three places name a type and must accept subclasses: a **child relation**, the **quantifiers**
over it, and a **referrer fan-out** (`for_each_referrer`, ADR 0007).

## Decision

1. **A type named in a relation, a quantifier or a referrer fan-out stands for that type and
   every subclass of it.** `steps: { type: Step }` holds site visits and transfers;
   `for_each_referrer: Handling.sample` reaches every kind of handling — one route instead of one
   per handling type.
2. **Quantifiers on an abstract child type name the skeleton's states**, which every subclass
   has by ADR 0008. The loader now checks, for every relation, that a quantifier's state is a
   real state of the child type — a typo (`any(shipd)`) would otherwise never fire, quietly.
3. **A relation declared on an abstract parent is inherited by each concrete subclass**, and
   those copies are **one relation**. Because the parent's type is not fixed, the child's
   `via` must yield the parent's **key**, `Type#id` — e.g. a task's `step:
   "SiteVisit#R1-CLINIC1"`. A bare id is an error that lists the parent types it could be.
   A relation declared on a concrete parent keeps yielding a plain id.
4. **A child type may have several possible parent relations**, and its creating command
   picks one by the field it carries: a route created with `request:` belongs to a
   request; one created with `route:` is nested in another route.
   **Exactly one** relation's `via` must resolve; none, or more than one, is an error, and an
   ambiguous child is linked to no parent rather than to a guess. Two relations whose `via`
   reads the *same* field could never be told apart, so that stays a load error.

## Why the creating command chooses

"A route is also a step" means a route can sit in another route's `steps` — the arbitrary
nesting the domain owner said the data model allows — as well as in a request's `routes`. A static "one parent type per child type" rule
cannot express that. Choosing by the field the command carries can, and it stays loud: the
choice is visible in the command, and every way of getting it wrong is reported.

The rejected alternative was resolving the parent by *which parent instance exists*. It fails
the moment a child is created before its parent, which ADR 0004 already allows (the sales
model's "children finish early" scenario).

## Consequences

- Slice 1b has one `Task` and one `Handling` skeleton with four subclasses each, one scan
  route for all handlings, and a route rolling up a mix of step types; its
  inspector shows "6 of several types · 6/6 final".
- The children grid shows a type column when a relation holds more than one type.
- A child's `via` reads differently depending on where its relation was declared — a key
  under an abstract parent, an id under a concrete one. The error message names which is
  expected; still a thing to know.
