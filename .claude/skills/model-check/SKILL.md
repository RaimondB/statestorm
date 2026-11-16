---
name: model-check
description: Run the statestorm model check and act on it — static findings, rule and state coverage, the business drawings compared with the scenario runs, and the list of drawing changes for stakeholders. Use after any model or scenario change, and to decide what to work on next.
---

# The model check

```bash
# `statestorm` is the platform's command: in a domain repo `pnpm exec statestorm` (or its pnpm
# scripts), in the statestorm repo `node packages/cli/src/statestorm.ts`. `.` is the domain folder.
statestorm check . [--all] [--coverage] [--scenarios] [--issues] [--propose]
statestorm check . --docs          # only the docs against the model — no runs, about a second
statestorm check <model.yaml> <scenarios dir> [<drawings dir>] [--docs-dir=<dir>] [...]   # the same, by path
statestorm rules . [<id> | --topic=<topic> | --open] [--json]   # ask the docs what a finding is about
```

It runs every scenario under every schedule, then reports. Exit 1 on errors (a failing scenario,
a drawing or issue list that does not import); gaps are warnings.

## Reading it

| Section | What it means | What to do |
|---|---|---|
| Static: *nobody reacts to* (info) | an event that leaves the system — or a missing policy | confirm it is an outcome for the outside |
| Static: *waits for … which nothing raises* | a policy that can never fire | a typo, or a raise that is missing |
| Static: *nothing enters* | a state that cannot be reached; *inherited* ones are only noted (a subtype cannot drop them) | remove it, or add the transition |
| Static: *never leaves* (info) | a non-final state without a way on | a record that lives on, or a stuck step |
| Static: *compared with a value it never holds* | a guard against a value no sender or scenario uses | a misspelling — or a case no scenario covers yet |
| Coverage: rules / states | what no scenario exercises | a scenario, or `coverage: { ignore: { <id>: why } }` |
| Unanswered commands (error) | a command not handled in the state it found, refused by every guard, or sent to an instance that does not exist | a lost message (fix the model or the scenario's set-up), or a no-op the model should say (`Name: {}`) — a repeat from at-least-once delivery included |
| What each scenario alone covers (`--scenarios`) | the rules, states and drawn arrows no other scenario covers | a scenario with nothing of its own is a candidate to merge or retarget — unless its assertions are the only ones that catch a broken rule |
| Drawings: *in the model, never shown* | a drawn arrow the drawing's own scenarios do not walk | write the scenario, or change the arrow's decision with the owner |
| Drawings: *decided …, yet shown* | the model does something the drawing's decision says it should not | a model bug, or a decision to revisit |
| Drawings: lanes differ (info) | a status drawn in another lane than the board puts it | an issue for the drawing, or the board's lanes |
| Drawings: *drawn nowhere* (`--all`) | behaviour no drawing shows | ask whether the business knows it happens |
| Docs: *why: X — no rule … has this id* (error) | a `why:` that resolves to nothing | a typo, or a decision never written down — write it (skill `domain-session`) |
| Docs: *the rulebook is stale* (error) | the docs, model or scenarios changed since `statestorm docs` | run `statestorm docs .` and commit it with the change |
| Docs: names that resolve to nothing (error) | a glossary term or a topic's canvas naming a type, event, state or package the model lacks | a rename the docs missed |
| Docs: *stale: … cites R, which is superseded* | the model or a scenario still built on a replaced rule | change it to the newer rule — or ask whether the old behaviour is still wanted |
| Docs: *R (agreed) — no model element / no scenario cites it* | a decision with nothing built or shown | build it, show it (`why:` on the scenario), or say `untraced:` why on the rule |
| Docs: *R is named in a model comment … and in no why:* | a citation the check cannot follow | move the id into `why:` where the rule is implemented |
| Docs: *… is one of the topic's types, and no glossary term names it* | a topic moved without its words | add the term — what the domain calls it, and what it names in the model |
| Docs: *waiting on the owner* (info) | built on a rule to confirm, or citing an open question | the agenda for the next session: `statestorm rules . --open` |

## Acting on it

- Work the list top-down: errors, then drawn-but-never-shown arrows (they are what the business
  sees), then deviations and failures, then internal coverage.
- Each gap closes one of three ways: **a scenario** (skill `scenario-loop`), **a decision**
  recorded where it belongs (a drawing arrow's `later:`/`no:`, a `coverage.ignore` with its
  reason), or **a question** for the owner (skill `domain-session`). Never by deleting the
  check's input.
- `--propose` writes a **proposed scenario** per drawn arrow never shown, to `<scenarios dir>/proposed/`:
  the closest existing run, cut where the subject reaches the arrow's start, plus up to three steps
  that make the arrow happen, with what the model did. **"Nothing reacts"** means the status is
  raised but no step of the model answers it there — a question for the owner, not a scenario to
  keep. A proposal that does what the owner wants is renamed, given real assertions, and moved into
  the suite; the rest become questions (skill `domain-session`).
- `--issues` prints the drawing changes to take to the stakeholders; keep it current (skill
  `capture-drawing`).
- Re-run after each change and quote the before/after numbers in the report to the user.
