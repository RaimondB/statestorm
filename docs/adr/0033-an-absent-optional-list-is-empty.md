# ADR 0033 — An optional list that a command does not carry is an empty one

- **Status:** proposed, 2026-11-18
- **Decides:** what a rule reads when a command leaves out a list its `takes:` declares optional
- **Builds on:** ADR 0012 §8 (`takes:`, optional fields), ADR 0026 (walking lists)
- **Forced by:** a command that may bring a list of extras, and most often brings none. A rule walks the
  list or keeps it. Declared optional, an absent list could not be read: `for_each` stopped with "is
  not a list", and an assignment stopped with "unknown reference". So every sender had to send an
  empty list it had nothing to say about, or the rule needed a second variant for a list it cannot test
  for.

## Context

In `lab`, a route's plan may bring its handling instructions with it, for example *keep frozen*. Most
plans bring none. A scalar field marked optional reads as not matching when it is absent (ADR 0012 §8).
A list has no such reading: the expression language has no lists to test, so there was no guard to
choose a variant by.

## Decision

1. **When a command does not carry a list its rule's `takes:` declares optional (`[Instruction?]`), the
   rule reads it as an empty list.** `for_each` walks nothing, and `assign` keeps an empty list:

   ```yaml
   Plan:
     takes: { request: string, lab: string, tubes: [TubeRow], instructions: [Instruction?] }
     assign: { request: command.request, lab: command.lab, instructions: command.instructions }
   ```

2. It applies only to lists that `takes:` declares optional, and only once the command has passed its
   `takes:` check. A required list that is missing is still refused (ADR 0012 §8), and a list without
   `takes:` is not guessed at.
3. The log keeps the command as it was sent. The empty list is what the rule reads, not what was sent.

## Consequences

- A sender says nothing about extras it does not have, and one rule serves both cases.
- Absent and empty mean the same for an optional list: a model cannot tell "left out" from "none".
  Where that difference matters, the list is required.
- **Rejected:** a guard that tests whether a list is present, which would bring lists into the
  expression language; and filling absent lists in every payload, which would hide a required list
  that is missing.
