# ADR 0020 — Systems in a landscape: domains, vendors' parts, senders by payload, shared definitions

- **Status:** proposed, 2026-11-06
- **Decides:** what ADR 0018 could not say when a real domain declared its systems — the larger scopes
  systems belong to, a vendor's system that runs logic the model specifies, a vendor with several parts,
  several systems sending the same command, and abstract types several systems share
- **Builds on:** ADR 0018 (systems, contexts, sub-systems), ADR 0008 (inheritance), ADR 0012 (kinds)
- **Forced by:** a domain owner placing every aggregate in a system of their landscape. Their systems
  all belong to one larger scope of the organisation, beside other scopes; a vendor that is logically part
  of that scope has a planning part and two apps; the customer is told by a vendor that runs logic under
  the domain's responsibility; five systems send the same scan command; and the abstract types are a
  shared library

## Context

ADR 0018 has two groupings of sub-systems — systems and bounded contexts — and systems outside the
model that only send and receive. Declaring a real landscape showed five things it cannot say:

1. Systems belong to larger scopes of an organisation's landscape: one scope's own systems, a
   neighbouring scope's, a third's. A view above the systems is
   wanted, where a whole scope is one box.
2. Logic the domain specifies can run in a system it does not own: what the customer is told is modelled
   here, but runs in a vendor's notification system. ADR 0018 lets an external system hold no packages,
   so the model must either pretend the logic is its own, or drop it.
3. A vendor is one system with several parts — a planning service, a clinic app, a courier app — each sending
   different things. At system level it is one lifeline; inside, three.
4. A sender is declared per command, `Type.Command`. A scan command that five systems send — each its own
   scans — draws every scan as sent by the first of them.
5. An abstract type (ADR 0008) is inherited by concrete types in different systems: the definition is a
   shared library, owned by one team; each concrete type runs in its own system.

And a sixth, small: a sequence's label names the command only (`Plan`), so two types' commands of one
name cannot be told apart.

## Decision

1. **Domains.** A system — ours or external — may name the **domain** it belongs to: `domain:
   Selling`. `domains:` adds notes, as `contexts:` does; a declared domain no system names is refused. The
   context map and the sequence get a **domain** level above the system level: a domain is one node or
   lifeline, and a system in no domain is drawn as itself. "Domain" here is a scope of the landscape — the
   word an organisation uses for a group of systems and their teams — not this repo's *domain model*.

   ```yaml
   systems:
     Shop:     { domain: Selling, packages: [Catalogue, Cart, Orders] }
     Payments: { domain: Finance, external: true, sends: [Order.Paid] }
   domains:
     Selling: { note: what the customer buys from }
   ```

2. **An external system may hold packages: modelled here, run there.** Its types are specified by this
   model — rules, scenarios, `why:` — and run in a system the domain does not own, a vendor's. They are
   placed in that system: on the map and in a sequence its logic sits behind its boundary, like any
   other system's. `external: true` says only who runs it.

3. **An external system may have sub-systems**, each with its own `sends:`, `receives:` and `packages:`.
   At system and domain level it is one node and one lifeline; at sub-system level, scoped to it, its
   parts. When it has sub-systems, what it sends and receives is said on them.

4. **A sender may be narrowed by the command's payload:** `sends: [{ Sample.Scan: { event: [Collected,
   Packed] } }]` — this system sends that command when the field `event` is one of those values. A command
   from outside is drawn as sent by the first system whose declaration matches its payload, a plain
   `Type.Command` matching any. The field must be one the command `takes:`.

5. **An abstract type is a shared definition.** It is placed by its package, like any type: the system
   whose sub-system holds that package **owns the definition**. Its concrete subtypes run where their own
   packages are — a subtype with no package of its own runs where its nearest ancestor's is. An entity
   created by an inherited rule belongs to each concrete owner that creates it; if those owners run in
   different sub-systems, the check says so (ADR 0018 §7). The map shows, beside a system, the packages of
   abstract types it owns (*library*).

6. **A label names the type**: a command from outside is `Type.Command`, a hop `Event → Type.Command`,
   and a map edge lists `Type.Command`.

7. **A decision about where a part runs is proven by the check, not by a scenario.** A system, sub-system,
   context, domain or relation may cite rules with `why:` (ADR 0016), and the docs trace counts them. Where
   a part runs changes nothing at run time (ADR 0018 §7), so no scenario can fail when it changes: a rule
   only the systems declaration cites needs no scenario. The check holds it — the names exist, an
   aggregate's boundary is in one sub-system, every type runs somewhere.

## Consequences

- The `lab` example uses each: its systems in two domains, a patient portal run by a vendor, a scanner
  vendor with two parts, each sending its own scans; its tests prove the domain level, the vendor's
  placement, the narrowed sender and the labels.
- A domain declares its landscape as the owner describes it, without pretending vendors' logic is its
  own.
- Rejected: a fourth grouping, a tree landscape ⊇ domain ⊇ system — one optional field says it, and a
  domain is only ever a group of systems; a `library:` key naming the shared packages — an abstract
  type's package already says who owns it; senders narrowed by a scenario's step — the model already
  knows what each system sends, the payload says which.
