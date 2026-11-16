# ADR 0021 — A refused creating command creates nothing

- **Status:** proposed, 2026-11-06
- **Decides:** what a command named in `creators:` does when no rule of the new instance accepts it
- **Revises:** the engine's behaviour under ADR 0004 §1 (creation), ADR 0010 (a rejection is logged)
- **Forced by:** a domain whose model refuses to plan a transfer it cannot run: the refusal was logged,
  but the transfer was created anyway and left in its initial state — a transfer that never existed,
  counted by the check as one that never finished

## Context

A command in `creators:` that reaches no instance creates one, then resolves against it. When every
rule's guard fails, the command is `rejected` (ADR 0010) — but the instance is already there: in its
initial state, its entry actions run, its references indexed, its parent told it has a new child. The
model said no, and the world says yes. A view counts it, a quantifier on the parent counts it, the check
reports it as unfinished.

## Decision

1. **A creating command is tried before anything is created.** The engine builds the instance the
   command would make — initial configuration, defaults, the references the command sets — without saving,
   indexing or linking it, and resolves the command's rules on it.
2. **If no rule accepts it, nothing is created.** The command is logged `rejected` with the guards it
   tried, as today; or `unhandled` — *nothing was created* — when the initial state has no rule for it at
   all. No `created` entry, no entry action, no timer, no reference, no child.
3. **If a rule accepts it, creation is as before**: the instance is created (its entry actions run, its
   parent is told), and the command is resolved again on it and applied.
4. A later command that is accepted creates the instance then, as if the refused one had never come.

## Consequences

- A refused creation leaves no trace in the world but the refusal in the log; the `sales` example's
  refused order no longer exists afterwards (scenario 04), and a kernel test proves no instance, no entry
  event, no reference and no child.
- A scenario cannot yet assert that an instance does not exist; `rejected:` and what was not emitted say
  it until it can.
- Rejected: undoing a creation after the fact — entry actions, timers and the parent's tally would have
  to be unwound; creating in a provisional state and finalising later — every view and quantifier would
  have to learn a new kind of instance.
