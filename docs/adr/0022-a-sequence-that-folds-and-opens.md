# ADR 0022 — A sequence that folds what repeats, and opens one lifeline at a time

- **Status:** proposed, 2026-11-13
- **Decides:** how a run is drawn as a sequence diagram once a real domain's runs are long: what is
  folded, in what order the messages are drawn, and how a reader chooses how deep each lifeline goes
- **Revises:** ADR 0018 §5 (a level for the whole diagram, messages in log order) and §6 (the level
  switch of the *Sequence* view); ADR 0020 §3 (sub-system level scoped to one system), for the sequence
- **Forced by:** a domain owner reading a planning scenario as 278 lines of Mermaid: the same messages
  repeated for every unit, where they wanted *"something like 'for each' and just have a single arrow"*;
  and, instead of switching the whole diagram to the deeper level, to *"open or collapse each
  lifeline"* — open the one system they are interested in to see its internal steps

## Context

ADR 0018 draws every message that crosses a boundary, in the order the log has them, at one level for
the whole diagram. A run of a real domain repeats itself: a policy's `for_each` sends one command per
unit, a `for_each_referrer` reaches every activity on the unit's path, a scenario scans each
unit in turn and each scan sets off the same cascade. At system level the reader gets the same arrow
four times, and to see inside one system they must switch the whole diagram to sub-system level —
every other system splits too, and only one system can be the scope.

The log has what is needed to do better. Every command records its cause (R18); the commands one policy
firing sends — one per item of its `for_each`, one per referrer — share that firing's log entry as their
cause, and the firing names its rule, whose `for_each` expression says what is iterated.

## Decision

1. **Drawn in causal order.** Each arrow is followed by what it caused: the steps it set off inside its
   lifeline (a note, *n steps inside X*, as before), then the arrows they set off, each in turn, in log
   order among siblings. A run's own order of unrelated messages depends on the schedule (ADR 0006); what
   caused what does not, so the picture is the same under every schedule. The inputs of a run — commands
   from a person or an external system — are the top level, in the order the scenario sent them.

2. **What a model loop sends is one arrow in a `loop` frame.** The commands of one policy firing with
   `for_each` or `for_each_referrer` that cross to the same lifeline with the same label are drawn once,
   in a frame labelled with **the list** the rule iterates — `for each of units ×2` for
   `for_each: event.units` (the leading `event.` / `command.` dropped), `for each Handling that refers to
   it ×3` for a referrer fan-out. When every iteration caused the same picture, the frame holds one
   iteration; when they differ, it holds each.

3. **Repeats the run made are folded too, and drawn as such.** Consecutive siblings that draw the same
   picture — same sender, receiver and label, and the same consequences, recursively — are folded:
   - inputs of the run (a scan per unit) into a **dashed** frame, *repeated for S1, S2* — the
     instances that differ; dashed, because the model has no loop there, the scenario repeated itself;
   - other arrows, with nothing following them, into one arrow `×n`; with consequences, a dashed frame
     *repeated ×n*.

   Because the picture compared is the one drawn at the current depth, arrows that are the same at
   system level fold, and come apart where a deeper lifeline tells their receivers apart.
   **Different commands are never folded together**: one event becoming three commands in one lifeline
   is three arrows. **An event reaching several lifelines is an arrow per receiver.**

4. **Phases are sections; the set-up starts folded.** The scenario's `phase:` marks become labelled
   sections that fold to one row (*Planning · 12 messages*); the run's `given:` sends are a section of
   their own inside the first, folded by default.

5. **What changed nothing is hidden, and counted.** A command its receiver ignored (a broadcast it had
   no answer to, ADR 0007 §5) is left out by default, with the number left out said and a switch to
   show them — as the trace does.

6. **Each fold opens where it stands.** A folded frame, arrow or section opens to show every arrow it
   stands for, and closes again. Folding is on by default; `--unfold` on the command line turns it off.

7. **Lifelines open one at a time, down one tree.** The level of ADR 0018 §5 becomes a set of *open*
   nodes, in the containment tree **domain → system → sub-system → aggregate type**: a domain holds its
   systems (ADR 0020), a system its sub-systems, a sub-system the aggregates of its packages. An arrow
   attaches to the deepest open node on each side; what stays inside a closed node is its note. Opening
   the Lab system shows its insides while every other system stays whole.
   - **Contexts are not a level of the tree.** ADR 0018 rejected a tree system ⊇ context ⊇ sub-system:
     a context may span systems. A context is drawn as a band over the adjacent lifelines it holds, where
     it says something — where its name is not their system's own.
   - **A node with one child opens through it**: a system with one sub-system opens straight to its
     aggregates.
   - **Aggregates are the deepest lifelines.** An entity is inside its aggregate (ADR 0012), its steps
     that aggregate's note; instances are named in a frame's label and an arrow's tooltip — a lifeline
     per instance would undo the folding of §2–3.
   - **An external system opens into its parts** (ADR 0020 §3). A part is a lifeline of its own, since
     it sends and receives as a whole; a part that only runs packages the model specifies, sending and
     receiving nothing itself, opens into their aggregates.
   - The levels remain as presets: *domain*, *system*, *sub-system*, *aggregate* open every node above
     that level. Sub-system level is no longer scoped to one system — opening a system is the scope.

8. **A view is a link.** What is open, which folds are opened, and whether ignored commands show are
   part of the workbench's address, with the model, the scenario and the view: a link reproduces the
   diagram, a shared file included. On the command line: `statestorm sequence <domain> <scenario>
   [--level=…] [--open=<name>,…] [--unfold] [--ignored]`; Mermaid draws an open node's children in a
   `box`, a loop or a repeat as `loop`, a section as a `rect`.

9. **One derivation.** `sequenceOf(model, log, view, marks)` in the kernel (`sequence.ts`, beside `systems.ts`) returns the tree of items and the
   lifelines; the workbench and the command line draw it, neither folds on its own.

## Consequences

- The context map keeps its levels; whether it opens node by node too is a later decision, made
  independently.
- `--level=context` is gone from `statestorm sequence` (a context is a band); `--system=<name>` there is
  `--open=<name>`.
- The tests prove each fold and the opening on the `lab` example and on small models written for them;
  a sequence is a view, not a behaviour, so there is no scenario that needs it.
- Rejected: folding by adjacency in the log — two iterations of a loop are rarely adjacent under a
  schedule that reorders, and the folds would change with the schedule; one arrow for one event's
  several commands in one lifeline (`→ 3 commands`) — the reader wants to see each; a single row with an
  arrowhead per receiver for a fan-out — not UML, and ambiguous where arrows overlap; contexts as a level
  beside systems (a second tree, chosen by a switch) — not needed while a band says it; instance lifelines.
