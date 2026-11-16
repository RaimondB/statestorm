# ADR NNNN — <what is decided, in a few words>

<!--
Copy to docs/adr/NNNN-<what-is-decided>.md, the next free number. An ADR is needed for every new
kernel feature (AGENTS.md), and comes with a scenario that cannot be written without it.

Keep it neutral (AGENTS.md, "Keep it neutral"): this repo is read by people outside every domain
that uses it, and the check (`pnpm neutral`, and the commit hooks) fails on a domain's words.

- **Forced by** says the *shape* of the need, in general terms — "one scan of a unit must reach
  every task that holds that unit", "a list arrives in no order, and its order is a field". Not
  who asked, not which domain, not its question or rule ids, not its owner's words: a quote
  belongs in the domain's own session log, where it was said.
- **Examples** use the bundled examples' types and words — `lab` (sample, site visit, transfer,
  task, handling, deviation), `sales`, `claims`. If none of them has the shape, extend `lab` (with
  a scenario) rather than borrowing a domain's model.
- Ids are this repo's own: other ADRs, requirements (R…, MC-…), open questions (Q…).
-->

- **Status:** proposed, <yyyy-mm-dd>
- **Decides:** <the question this answers, in one sentence>
- **Forced by:** <the general shape of the need — see above>

## Context

<What the kernel or the workbench cannot say today, shown on an example model. What was tried,
and why it was not enough.>

## Decision

<What is decided, numbered when there are several parts. The model syntax with a short example from
`lab`, `sales` or `claims`. What the loader refuses, with its message.>

## Consequences

<What becomes possible; what it costs; what is left out on purpose; the alternatives rejected and
why.>
