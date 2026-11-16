# ADR 0010 — Per-state counts in rules, and variants of a child rule

- **Status:** proposed, 2026-10-10
- **Decides:** how a parent rule tells *how* its children ended, not only *that* they did
- **Amends:** ADR 0004 (the tally is visible to rules as counts per state)
- **Forced by:** a domain modelled line by line with its owner, where a task's outcome per item
  is completed, failed, or partially completed, and the same rule rolls up through steps and
  orders

## Context

ADR 0004 gave a parent quantifiers over its children (`all_final`, `any(state)`) and exposed
the tally to expressions only as `count` and `finals`. That answers "is everyone done?" but not
"did they succeed?". The domain owner's roll-up needs exactly that: two samples, one analysed and
one rejected at the bench, makes the task **partially completed** — not completed, not failed.

Two things were missing: a way to read *how many children are in which state*, and a way to
give one trigger (`all_final`) more than one outcome. A child rule was keyed by its trigger,
so `handlings.all_final` could appear once per state.

## Decision

1. **Per-state counts.** In a parent's expressions, `rel.in.<state>` is how many children of
   that relation are in `<state>`, for every **top-level** state of the child type (for an
   abstract child type, its skeleton — every subclass has those, ADR 0008). The counts are
   **zero-filled** from the child type's states: `handlings.in.failed` is `0` when nothing
   failed, and a misspelt state (`handlings.in.faild`) is an unknown reference — a guard error
   that the rejection chain names — never a quiet zero.
2. **Variants of a child rule.** `handlings.all_final#partial` is a second rule for the same
   trigger, with its own guard — the same `#` convention as `Pay#partial` for commands. The
   trigger is watched, and queued, once; resolution tries the variants in declaration order.
3. **A child rule whose guards all fail says so.** It logs a `rejected` entry with the chain
   — the values each guard saw, or why it could not be evaluated — as a refused command does.
   Before, that case was folded into an `info` "not handled", and a broken guard on a roll-up
   rule was effectively silent; a test found it.

## Consequences

- The domain's roll-up is three variants per level, written once on the abstract Step
  and Task (ADR 0008): completed if nothing failed, failed if nothing succeeded, partially
  completed otherwise. An *excluded* sample — one whose journey stopped upstream — is final
  and counts neither way.
- Only top-level states are counted. Nested refinements (`in_progress.storing`) count as their
  top-level state, which is what a roll-up across subclasses should see. Counting deeper
  needs a syntax for dotted names under `in`; not needed yet.
- The domain owner says a step is *failed* when the **latest task it reached** failed. Counts cannot
  see order, so for now a transfer whose pickup succeeded and whose delivery failed rolls up as
  *partially completed*. Order arrives with predecessors (slice 2, step 5).
