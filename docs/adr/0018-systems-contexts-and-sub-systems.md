# ADR 0018 — Systems, bounded contexts and sub-systems; the context map and the sequence diagram

- **Status:** proposed, 2026-11-06
- **Decides:** how a model says which software system, bounded context and sub-system (a C4
  container) each of its types lives in, and which systems outside it talk to it — and the two
  views derived from that: the context map, and a scenario as a sequence diagram at system,
  context or sub-system level
- **Builds on:** ADR 0012 (aggregates and their boundaries), ADR 0013 (packages), ADR 0003
  (policies — the only way a message crosses a boundary)
- **Forced by:** a domain owner who wants to "group aggregates / bounded contexts into a system
  boundary", generate "a context map on the system level", and see a scenario "as a sequence
  diagram … on a system level, leaving out the system internal logic", prepared for "the
  SubSystem (Container) level interactions inside the system"

## Context

Packages (ADR 0013) group types into modules — a handful of aggregates each. A bounded context is
bigger: a model and a language owned by one team, usually built as several sub-systems (C4
containers), often the whole of a software system. But not always nested: one system may host
several contexts, and one context may span several systems — a context whose job is to harmonise a
capability that lives in several vendor systems, so the rest of the landscape never sees the vendors'
models. A tree system ⊇ context ⊇ sub-system cannot say that.

Nothing outside the model is named today either. A scenario's command from outside comes from
"a person" (`cause: 0`); events nobody inside handles go nowhere.

## Decision

1. **The sub-system is the unit.** A sub-system lists packages; it belongs to exactly **one system**
   and **one bounded context**. System and context are two groupings of the same sub-systems, not
   one inside the other. A type's sub-system is its package's; an entity's, its aggregate's (ADR
   0013 §3). A package is in one sub-system at most.

   ```yaml
   systems:
     Shop:                                  # a system of ours
       note: what the customer orders from
       context: Selling                     # the default context of its sub-systems
       subsystems:
         Storefront: { packages: [Catalogue, Cart] }
         Checkout:   { packages: [Orders], context: Ordering }
     Warehouse: { packages: [Stock] }       # not split: one sub-system, named as the system
     Payment provider:                      # outside the model
       external: true
       sends: [Order.Paid]                  # commands it sends into the model
       receives: [OrderPlaced]              # events it is told
   contexts:                                # optional: notes and owners
     Ordering: { team: checkout, note: … }
   relations:                               # optional: the patterns a map cannot derive
     - { upstream: Payment provider, downstream: Ordering, pattern: anticorruption-layer }
   ```

   Defaults keep small models small: a system without `subsystems:` is one sub-system of its own name;
   a sub-system without `context:` takes its system's, and a system without one is a context of its
   own name. `contexts:` only adds notes and a `team:`; a declared context no sub-system uses is
   refused.

2. **External systems** (`external: true`) have no packages. `sends:` names the commands they send
   into the model as `Type.Command` — an aggregate's (ADR 0012 §4), a command it answers; `receives:`
   names events the model raises. They are their own context. A scenario's command from outside is
   drawn as sent by the external system that sends it, else by a lifeline *person*.

3. **Relations** declare a DDD pattern between two systems or contexts, upstream and downstream:
   `customer-supplier`, `conformist`, `anticorruption-layer`, `open-host-service`,
   `published-language`, `shared-kernel`, `partnership`, `separate-ways`. They are documentation, checked:
   a relation between two that the model does not connect is a warning.

4. **The context map is derived from the model, statically.** An edge runs from A to B when a policy
   reacts to an event raised by a type in A and commands a type in B — A upstream, B downstream —
   labelled with the events and the commands they become; an external system's `sends:` and
   `receives:` add edges to and from it. At **system** level the nodes are systems; at **context**
   level, contexts; at **sub-system** level, one system's sub-systems with the systems around them.
   Declared patterns label their edges.

5. **A scenario becomes a sequence diagram** from its run under the default schedule — deterministic,
   and the same run the trace shows. The log already says what caused what (R18): a command with
   cause 0 came from outside; one sent by a policy traces back to the event that set it off. At a
   level, each message that **crosses** a boundary is an arrow: a command from outside (solid), an
   event that becomes a command elsewhere (dashed, `Event → Command`), an event an external system
   receives (dashed). What stays inside a lifeline is folded into a note, *n steps inside X*.
   Sub-system level is scoped to one system: its sub-systems, and the other systems as wholes.

6. **Where it shows:** the workbench gets a *Context map* view of the model and a *Sequence* view of the
   running scenario, each with a level switch; `statestorm context-map` and `statestorm sequence` print
   Mermaid for documents. All of it is read from one derivation in the kernel (`systems.ts`), so the
   views, the command line and the check cannot disagree.

7. **Checked:** names exist (packages, systems, contexts, `Type.Command`, events, patterns); once a model
   declares systems, a type in none is a warning; a sub-system's packages must not hold the entities of
   an aggregate in another sub-system (they would split a boundary — ADR 0012). Systems change nothing at
   run time.

## Consequences

- The `lab` example declares its systems; its tests prove the map's edges and each level's sequence.
- A domain can declare its systems before it is split into sub-systems, and split later without
  touching a scenario.
- Rejected: a strict tree system ⊇ context ⊇ sub-system — it cannot say a context that harmonises
  several vendor systems; naming the sender on every scenario step — precise, but every scenario would
  change, and the model already knows who sends what; deriving the DDD patterns — they are agreements
  between teams, not facts in the messages.
