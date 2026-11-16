# ADR 0025 — Agendas: the scenarios chosen for a meeting, in order

- **Status:** proposed, 2026-11-16
- **Decides:** how a domain names a few of its scenarios for a stakeholder meeting — grouped under the
  meeting's topics, in the order they are shown — and how the workbench, the check and `share` use it
- **Forced by:** a domain owner: *"I want to add a feature where we can highlight a number of scenarios
  for stakeholder alignment meetings."* The next meeting is about one roadmap phase, on four topics.

## Context

A domain has hundreds of scenarios; a meeting walks a dozen, in an order that tells a story. Tags
(MC-15) say what a scenario *is* — happy or deviation, a topic, a phase — and filter the picker; they
have no order, no headings, and marking a meeting with a tag would edit scenario files for every
meeting. A meeting is a thing of its own, written once and kept.

## Decision

1. **An agenda is a file in the domain**, `agendas/<name>.yaml`, beside `scenarios/`:

   ```yaml
   title: Phase 1 — stakeholder alignment
   date: 2026-11-20              # optional
   scope: [phase-1]              # optional: tags a scenario should carry one of
   view: overview                # optional: what each scenario opens in (default overview)
   items:
     - title: Happy flow — from the clinic to the result
       scenarios: ["01", "07"]   # by number (the file name up to its first dash) or whole file name
       note: …                   # optional: what to show or ask
       questions: [Q-6]          # optional: rules and questions to raise, linked to the docs
       view: journey             # optional, for this item
   ```

   Each item's first scenario is its story, the others its variants. An agenda adds no meaning to a
   scenario and changes none.
2. **The workbench** lists a domain's agendas beside the tag filter. Choosing one groups the scenario
   picker under the agenda's items, in its order, and shows an **agenda bar** over the view: the item
   (2 / 4) and its title, the scenario within it, its note and questions, and ‹ › to step through every
   scenario of the agenda — each opened in the agenda's view. The link carries it: `agenda=<name>` and
   `step=<n>`, so a reader can be sent to one step.
3. **The check** (and `check --docs`) reads the agendas: a scenario that does not resolve, an empty item,
   an unknown key, or a `questions:` id the docs lack is an **error**; a scenario carrying none of the
   agenda's `scope:` tags is a **warning** — shown in a meeting about a phase it is not of.
4. **`statestorm share --agenda=<name>`** builds the shared file with only the agenda's scenarios, opening
   on its first step: what stakeholders open before the meeting. `--without=` still applies.

## Consequences

- The kernel and the scenario runner are unchanged; this is the workbench, the check and the CLI.
- `scope:` is generic — any tags; a domain that tags its scenarios by roadmap phase scopes by those.
- What the meeting decides goes to a session log as before (ADR 0016); the log names the agenda.
