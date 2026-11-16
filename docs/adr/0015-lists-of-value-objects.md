# ADR 0015 — A field may hold a list of value objects, one per key

- **Status:** proposed, 2026-10-19
- **Decides:** how an aggregate holds a list of values — and revises ADR 0012 §8 ("a list of
  them is a payload, never a field")
- **Builds on:** ADR 0006 (at-least-once delivery), ADR 0012 §8 (value objects)
- **Forced by:** a domain's owner: the instructions for a route are a list — keep cold, protect
  from light, deliver by hand — each an instruction of its own, none with an identity.

## Context

ADR 0012 kept lists out of fields for the reason ADR 0007 rejected the accumulator: delivery is
at least once, and an "append" applied twice leaves two rows. The answer so far was to make each
row an entity — but an instruction has no identity and no lifecycle; making it an entity would
draw the domain wrong to suit the kernel.

## Decision

1. **`type: [Value]` with `key:`** declares a list field of a value object:
   `instructions: { type: [Instruction], key: kind }`. The key is one of the value's
   fields; the list holds **at most one row per key**. It starts empty.
2. **`put:` changes one row:** `put: { instructions: { kind: command.kind, detail: command.detail } }`
   replaces the row with the same key, or adds the row. The row must be exactly the value object
   (checked at load, and at run against the values it was given). Put is idempotent by
   construction: a redelivered command puts the same row again and nothing changes — no
   `idempotency:` key needed, no accumulation warning.
3. **`assign:` may only replace the list whole**, with a list of rows of the value and distinct
   keys; an assignment that reads the list it writes (growing it) is refused at load — use `put:`.
4. Removing a row is not decided: no scenario needs it yet.

## Consequences

- The route holds its instructions; a step that learns one more (a site visit finding the sample
  must be kept cold) puts it into its route's list, so every step of that route — a re-run
  included — has it.
- The ERD shows the field as `[Instruction] by kind` and a "uses" line to the value.
- Rejected: rows as entities (an identity the domain does not have); a plain append with a
  declared `idempotency:` key (the key would protect one command, not the list — two different
  commands for the same kind would still give two rows).
