---
name: model-authoring
description: Write or change a statestorm model YAML in the kernel's grain — aggregates, entities, value objects, policies, guards, idempotency, inheritance, deadlines, lists. Use before editing a model — a domain repo's model.yaml, or an example's.
---

# Authoring a statestorm model

Read `docs/design.md` §2 and the ADRs it points to (`docs/adr/`, in the statestorm repo) when in doubt; these are the idioms that
keep a model honest under at-least-once, unordered delivery.

## Shape

- **Aggregates** are consistency boundaries: people and policies send them commands, they raise
  events. **Entities** (`kind: entity`) live inside one aggregate and are reached only through
  it — the owner creates and commands them with `send:`. **Value objects** (`values:`) have no
  identity: rows of a payload, a field's type, or a list field one row per key (`type: [V], key:`,
  changed with `put:`).
- Aggregates never call each other. A **policy** reacts to an event and sends a command;
  `for_each_referrer` reaches everything that points at an instance.
- A **status the business names** is an event, raised where the fact happens; its *meaning* is
  given by whatever handles it (the same event completes one step and starts another).
- An **abstract type** carries the lifecycle and the roll-up once; subtypes refine it — they add
  substates and rules, never states beside the inherited ones. A sender that knows only an id
  addresses the abstract type (`Site#${event.site}.Describe`): it reaches whichever subtype has the
  id (ADR 0028).
- **Packages** group what belongs together; an entity sits with the aggregate that creates it.
- **Systems** (ADR 0018, ADR 0020) say where packages run: a package in one sub-system of one system;
  an aggregate's entities in its sub-system — if a type's owners would run in two systems, that is a
  question for the domain owner (two types, or one owner), not a placement to force. An abstract
  type's package says which system owns the shared definition. A vendor's system that runs logic the
  model specifies is `external: true` with `packages:`; `sends:` narrowed by payload tells several
  senders of one command apart.
- **A policy runs in a part** (ADR 0035), and that decides who depends on whom: `in: <sub-system>`, or
  `in: target` (each part it commands runs it for its own types: they hear the event) or `in: source`
  (each part raising the event runs it: it sends the command). A part hearing another's event, or
  sending it a command, is downstream of it. Two parts that each hear the other are a cycle the check
  warns of. To break it, let them both hear a third that tells them (the sample everyone hears),
  not each other. Where a policy runs is the domain owner's decision, like a type's owner.
- **A new type is a decision, not a convenience.** Its kind and its owner are the domain owner's to
  decide, before it is written (skill `domain-session`): an **aggregate** because people or policies
  tell it things directly and it is consistent on its own; an **entity** because it has no life
  outside one owner — say which aggregate creates it; a **value object** because it has no identity
  and no lifecycle. The type cites that rule with `why:`. Once declared, the loader holds the line
  (ADR 0012) — a wrong kind shows up as a fight with the kernel, not as an error message, so decide it
  first. Changing a type's kind later is a revision of that rule, like any other.

## Rules that bite

- **Derive, don't accumulate.** An `assign` that reads the field it writes changes again on every
  redelivery. Derive the value, or give the rule an `idempotency:` key naming a domain identity.
- **Idempotency is the model's job.** An input carries its own id (a message id, a receipt
  number); a repeated command must change nothing.
- **A payload field that is absent cannot be read.** Make it required, or write one rule variant
  per case (`Ship#express`, `Ship#standard`) guarded on a field that is always there. A field
  `takes:` declares optional (`priority: string?`) reads as not matching when it is absent.
- **Variants are tried in order, inherited first.** To change an inherited rule in a subtype,
  declare the *same key*; a new variant name is tried after the inherited one.
- **A guard that cannot be evaluated is loud** (a `rejected` with the reason) — never a quiet
  no-op. A missing input fails visibly.
- **Deadlines** belong to the state that declares them; leaving it cancels them. A per-instance
  duration is a data field copied in when planned (`after: { reservationTime: … }`).
- **Prefer a state you can see over a flag**: "awaiting a decision" is a substate, not a boolean.
- **Don't add a kernel feature from a model.** If the model cannot say something, write the need
  down; a kernel change needs an ADR and a scenario that cannot be written without it.

## Before you leave the file

- **Every part cites the decision it implements** with `why:` — a list of rule ids, on the type,
  state, rule, policy or package that implements it (`Ship: { why: [R12], target: shipped }`).
  Put it where the rule is said: an inherited rule keeps its own, a subtype cites only what it
  adds. A comment still explains *how*; the id goes in `why:`, where the check can trace it
  (ADR 0016). `statestorm rules . <id>` shows what already cites a rule.
- `statestorm check . --docs` (no runs, about a second): no id nothing defines, no citation of a
  superseded rule, no rule left only in a comment.
- The model's scenarios pass under every schedule (`statestorm test . --schedules`), and the model
  check (`statestorm check .`) shows no new error.
