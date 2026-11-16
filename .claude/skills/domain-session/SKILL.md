---
name: domain-session
description: Iterate a statestorm model with its domain owner — numbered questions with leanings, answers written into the domain's docs/ (rules, questions, the session's log) before modelling, revisions and open points kept visible. Use whenever the user brings new requirements, flows, slides or corrections for a model.
---

# A domain session

The domain owner knows the domain; the model is only right when they agree with it. A session
turns what they bring — a request, a drawing, a correction — into numbered decisions, and only
then into model changes.

## 1. Read what they brought, then ask

- Read everything first: the request, every image, what the domain has decided and what the
  model does today. Ask the docs rather than reading them whole (ADR 0016):

  ```bash
  statestorm rules .                 # every rule on a line: id, status, title, how often cited
  statestorm rules . --topic=<topic> # one topic: what the model derives for it, its rules in full
  statestorm rules . <id>            # one rule or question, and everything that cites it
  statestorm rules . --open          # rules built on a leaning, and the open questions
  ```
- **Flag inconsistencies before proposing anything**: between their material and the model,
  between two of their drawings, between today's answer and an earlier one. Say which earlier
  rule it contradicts, by its id.
- Ask **numbered questions**, a prefix per topic (`Q-1`, `F-3`, `C-2`), each with **a leaning**
  in italics — the default you would build. They answer inline, or say "defaults". Every id is
  unique across the rules, questions and drawing issues.
- Put the questions that decide the most first, and say which they are. Few questions per
  round; follow-ups go in the next round.
- When an option is a trade-off, give the options and one recommendation with its consequence
  for the model ("this revises R12: the order now completes on payment, not on shipping").
- **A new concept is a question of its kind and its owner.** When what they bring needs a type the
  model does not have, ask — before modelling — whether it is an **aggregate** (people or policies
  tell it things; it is consistent on its own), an **entity** (no life outside its owner: which
  aggregate creates it?) or a **value object** (no identity, compared by its values), and which
  package it belongs to. Lean with the reason: who talks to it, whether it has a lifecycle of its
  own, what would be lost if it were folded into its owner. The kernel enforces the kind once
  declared (ADR 0012); choosing it is the domain's.
- If more material is coming ("I'll share more images"), wait for it before settling anything.
- If you cannot see a source (an image dropped from context, a slide not shared), say so. Ask
  for it, or find it again; never reconstruct it from its title.

## 2. Write the answers down — before modelling

In the domain's `docs/` (ADR 0016; the formats are in `schemas/`, the `lab` example has them all),
in one commit:

- **The session's log**, `docs/decisions/NN-<date>-<what>.md`: what was brought, asked and answered,
  in the owner's words where they gave them. Written once; never edited after.
- **Each decision is a rule** in `docs/rules/<topic>.yaml`: `id`, `title`, `kind` (definitional,
  behavioural, or a `table`), `status`, `text`, and `decided: { session, date, questions }`.
  - **Agreed** and **built on a leaning, to confirm** are different: `status: agreed` or
    `to-confirm`.
  - **Revisions are visible**, said on the *newer* rule only: `refines` (both hold), `revises`
    (rewrite the older rule's `text` to what still holds — its old wording stays in the log), or
    `supersedes` (set the older rule's `status: superseded`). Never a silent rewrite; the
    back-links are generated.
  - Scope deferred on purpose ("later, with the returns scenarios") is a rule with
    `status: deferred`, so it is not mistaken for a gap.
- **Each question** goes in `docs/questions.yaml` with its `leaning` (and `options` with their
  consequences, when it is a trade-off) and `status: open`. Answered, it keeps its id: `status:
  answered`, the `answer`, and `answeredBy` — the rules that record it.
- A new word, or a word used differently, goes in `docs/glossary.yaml`, with what it names in the
  model. **A new type is a rule too** — definitional: its kind, its owner (for an entity, the aggregate
  that creates it) and its package, the reason given — and its glossary term names it (`model:`); the
  type cites the rule with `why:` (skill `model-authoring`). **Moving a topic into `docs/rules/` brings its words too**: every type of its packages gets a
  term — the check warns until it has one.
- A difference from one of their drawings is also an issue for the stakeholders
  (skill `capture-drawing`, `issues.yaml`).
- Then `statestorm docs .` (the rulebook the owner reads) and `statestorm check . --docs`: no
  errors before modelling starts.

## 3. Then model, and show it

- Build with skill `model-authoring`; prove it with skill `scenario-loop`; run skill
  `model-check`.
- Report back: what was built, what each new scenario shows, what the check found, what is
  still open — with the rule and question ids, so the owner can argue with any of it.
  `statestorm rules . --open` is the list for the next session.
- Something found while building (a scenario that fails for a real reason, an inconsistency
  the owner did not mention) is raised as a new numbered question, not fixed silently.
