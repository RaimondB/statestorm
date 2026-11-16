# ADR 0002 — EventStorming is the business-facing notation; BPMN is at most an export

- **Status:** proposed, 2026-10-09
- **Decides:** what a business owner looks at

## Context

Job 1 is validating a design *with business owners*, so the primary view must use a notation
they can read without a lesson. BPMN is the obvious candidate — it is a standard, it is
widely taught, and `bpmn-js` renders and edits it in a browser.

## Options

**BPMN.** Recognised in enterprises; standardised (OMG); swimlanes map neatly onto bounded
contexts; `bpmn-js` exists.

*Against:*
- **The semantics do not match the model.** BPMN describes a *process* as tokens flowing
  through tasks and gateways. Our model is a set of *independent objects with lifecycles*
  reacting to facts. Rendering aggregates-and-events as a token flow either lies about the
  model or forces the model to become a flowchart — and "it's one long process" is precisely
  the misconception a DDD design session is trying to break.
- **It hides the thing we want to show.** Eventual consistency, the gap between contexts and
  the fact that nothing is transactional across aggregates all disappear into a tidy flow.
- `bpmn-js` is not plain OSS — the bpmn.io licence carries an attribution/watermark
  obligation. Workable, but it needs checking before adoption, and the modeller is heavy.
- Audiences that genuinely want BPMN usually want it for *orchestration*, which is the one
  shape of our model (a long-running policy) where it does fit.

**EventStorming.** The DDD community's own workshop notation, and already the vocabulary of
the model: orange event, blue command, yellow aggregate, purple policy, pink external
system, on a left-to-right timeline. It maps **1:1** onto §3's model, so there is no
translation layer and nothing to lie about. Business owners read it in a workshop *because
it was invented for workshops with business owners* — stickies on a wall, not a diagram
standard.

*Against:* less formally recognised; nobody arrives already knowing the colours (though
"things that happened, left to right" needs no legend); no interchange format, so we define
the file layout ourselves.

## Decision

The **event-storm board is the primary business-facing view** (R23). BPMN is explicitly a
non-goal for execution and for v1 rendering.

A **BPMN export of stateful policies/process managers** is a legitimate later feature — it
is the one part of the model with genuine process semantics, and it is what hands a design
to a team that lives in Camunda. It would be an export, never the source of truth.

## Consequences

- Layout on the board is semantic (time runs right) and so is hand-placed, not auto-laid-out.
- We define the board's persisted layout format; it must survive a model edit without
  scrambling.
- Statecharts remain the engineer-facing view of an aggregate's internals (R24). Two
  notations, one model — which is a feature: the board is the conversation, the statechart
  is the specification.
