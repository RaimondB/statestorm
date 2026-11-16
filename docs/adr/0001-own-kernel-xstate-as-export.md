# ADR 0001 — Own execution kernel; XState as an export target

- **Status:** proposed, 2026-10-09
- **Decides:** what actually runs an aggregate's lifecycle

## Context

Three candidates for executing the model: build a small statechart interpreter, embed
**XState v5**, or embed a **BPMN engine**. The requirements that discriminate between them
are R15 (determinism), R17 (log is the source of truth), R19 (single-step at command / event
/ policy granularity), R20 (time travel and forking) and especially **R21 (say why a command
changed nothing)**.

Note that whichever option wins, the *interesting* layer is ours either way: multiple
aggregate instances, an ordered event bus, policies, a simulated clock and the log. No
candidate provides those. The question is only who owns a single aggregate's transition.

## Options

**A. Own interpreter.** The v1 statechart subset (flat states, guarded transitions, data
assignment, events on transition and on entry, `after:` timers) is a few hundred lines of
pure, synchronous TypeScript. State is plain serialisable data, so snapshots, forking and
`structuredClone`-free structural sharing are trivial.

*Against:* we own the semantics, including the corner cases. Hierarchy, parallel regions and
history states — free in XState — become work if we ever want them (Q5).

**B. XState v5 as the kernel.** Mature, well-specified semantics; hierarchy, parallel states,
history and delayed transitions on day one; an inspection API; `getPersistedSnapshot` for
time travel; an injectable clock for determinism; `@xstate/graph` for coverage (R33).

*Against:*
- **R21 is the problem.** XState guards are opaque predicates. The inspector reports that a
  snapshot did not change; it cannot report *which* guard rejected and *what values it saw*.
  Getting that means routing every guard through our own instrumented evaluator — at which
  point we own the part that matters and are paying XState's conceptual overhead for the rest.
- Its actor model (spawn, `sendTo`, parent/child) is a second, competing answer to
  "how do machines influence each other", sitting alongside our event bus. Two mental models
  in one tool is bad for a *teaching* tool (job 2).
- The DSL would be shaped by what maps cleanly onto machine config rather than by what reads
  well to a domain expert.

**C. BPMN engine.** Rejected for execution; see ADR 0002. Token-flow process semantics are a
poor fit for an aggregate lifecycle, and the credible engines are server-side (Camunda,
Zeebe), which contradicts the browser-only constraint (R35).

## Decision

**Option A.** Build the kernel, keeping the v1 subset deliberately within what XState can
express, and ship an **export to XState machine config** so a validated model can be lifted
into a real codebase (addressing the "being a toy" risk).

The expression language for guards and assignments is part of the kernel for the same
reason: R21 needs to report observed values, and a safe serialisable expression language
means a model file mailed by a stakeholder can be opened without executing their JavaScript.

## Consequences

- Guard transparency, stepping, forking and determinism are properties of the design rather
  than things wrestled out of a framework.
- Hierarchy and parallel states are a future ADR, not a given.
- The export is a real obligation: if it rots, the model becomes throwaway. It should be
  covered by tests from the moment it exists.
- If the kernel's semantics turn out to be subtly wrong in ways XState had already solved,
  this is reversible — the DSL is the contract and was kept XState-expressible on purpose.
