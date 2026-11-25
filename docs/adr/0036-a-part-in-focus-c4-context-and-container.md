# ADR 0036 — A part in focus: the C4 system context and container diagrams

- **Status:** proposed, 2026-11-25
- **Decides:** how the workbench and the command line draw one team's part of the landscape — a system
  or a bounded context, chosen by the reader — with only the parts it exchanges messages with, as a C4
  *system context* or *container* diagram
- **Builds on:** ADR 0018 (systems, contexts, sub-systems, the context map), ADR 0020 (external systems
  in parts), ADR 0022 (a view chosen by the reader, and kept in the link), ADR 0035 (who depends on whom)
- **Forced by:** a team that works on one system, or on one bounded context inside a larger system,
  wants a picture of its own part: what it is made of, who sends it what and whom it tells. The context
  map draws the whole landscape at one level. A team must find its part among the others, and the edges
  between parts it never touches are noise. Sub-system level opens one system but still draws every
  other system, connected to it or not. A bounded context that is one part of a system cannot be put in
  the middle at all.

## Context

In `lab`, the bench team works on the *Testing* context: the Bench sub-system of the Lab system. The
context map at sub-system level, scoped to Lab, draws Ordering, Logistics and Bench, and every other
system with all their edges. To show the bench team its part, a reader has to say "ignore Ordering's
arrows to the hospital". At system level, Bench disappears into Lab.

ADR 0022 left open whether the context map would let the reader choose what to open, node by node, as the
sequence does. This ADR does not change the context map. It adds a second picture, the one C4 calls a
*system context diagram* (one system, the people and systems around it) and a *container diagram* (one
system's containers inside its boundary, and the systems around it). A sub-system is a C4 container
(ADR 0018).

## Decision

1. **The focus is a set of systems and bounded contexts**, chosen by the reader: one or more of the
   model's systems (ours or external) and contexts. It stands for a set of sub-systems: all of a
   system's, and those of a context. A name the model does not have is refused, and so is an empty focus.
2. **What the picture holds.** Every sub-system in the focus, and every part that one of them exchanges a
   message with. Nothing else, so a system with no crossing to the focus is left out. An edge is drawn
   only when one of its ends is in the focus. Edges between two neighbours are left out. The edges are
   the context map's (ADR 0018 §4, ADR 0035), built by the same code from the same crossings, so they
   carry the same events, commands and policies, the same **U** and **D**, and the same warning when two
   parts depend on each other.
3. **Two diagrams, in C4's terms:**
   - **System context.** A system the focus holds whole is one box. A context that is only part of its
     system is one box, inside that system's boundary. Around it are the neighbours, each a whole system,
     but for one case. A neighbour that is part of a system the focus holds only in part is drawn as its
     own sub-system, inside the same boundary. So the bench team sees Ordering and Logistics by name, not
     "Lab".
   - **Container.** The focus's sub-systems, each a container, inside a boundary per system. The
     neighbours are as in the system context. A sibling sub-system of a focused system stays inside its
     boundary, drawn as not in the focus.

   A box in the focus is drawn filled; a neighbour, outlined. An external system or its part looks as it
   does on the map.
4. **The reader chooses, in the workbench's C4 view.** It has a switch between *system context* and
   *container*, and a focus picker that lists the systems and the contexts, each a toggle. A box on the
   diagram has a **◎** that adds it to the focus or takes it out. So a reader can start from their own
   part and pull a neighbour in. Clicking a box or an edge shows it in the inspector, as on the map. The
   diagram and the focus are part of the link (ADR 0022 §8): `#view=c4&diagram=container&systems=Lab&contexts=Testing`.
   Without a link, the view opens on the model's first system of our own, as a system context.
5. **The command line prints Mermaid's C4 diagrams:**
   `statestorm c4 <domain folder> [--diagram=context|container] [--system=<name>,…] [--context=<name>,…]`.
   It prints a `C4Context` or `C4Container` diagram with `System`, `System_Ext`, `Container`,
   `Container_Ext`, `System_Boundary` and `Rel`. An edge's label is the one the map's Mermaid gives,
   with its **U → D**.
6. **One derivation.** `c4Of(model, diagram, focus)` in the kernel (`systems.ts`) returns the boxes,
   the boundaries and the edges. The workbench and the command line only draw it.

## Consequences

- A team gets its own picture without editing the model, and a link to it, so it can be put in a team's
  page or a session's notes and opened again later.
- The tests prove both diagrams on `lab`: Lab in focus, Testing in focus, an external system in parts
  in focus, and the edges between neighbours left out. A diagram is a view, not a behaviour, so no
  scenario needs it.
- **Left out on purpose:**
  - **People.** A C4 system context diagram puts the people who use a system around it. The model
    names the external systems that send a command (ADR 0018 §2), and a scenario's command that no
    system sends is drawn as sent by a *person* in the sequence. Which command a person sends is not in
    the model, though. Guessing it from the commands no system sends would draw a person beside every
    command a scenario sends to set up its test. A model that wants its people drawn can declare them as
    external systems today.
  - **A domain as the focus.** A domain is a group of systems (ADR 0020 §1). A reader can pick its
    systems one by one.
  - **Technology.** C4 labels a container and a relation with its technology. The model does not say
    it, and the box says its context and its note instead.
- **Rejected:**
  - **Focus on the context map itself**, by fading what is not in focus. A faded landscape is still the
    whole landscape: it lays every part out, and the team's part ends up wherever the layout puts it.
  - **Edges between neighbours.** They say how the rest of the landscape hangs together, which is the
    context map's job. C4 draws only the relations of the system in focus.
  - **A context as a boundary in the container diagram.** A context may span systems (ADR 0018 §1), and
    a C4 boundary is a system's. The container says its context in its label instead.
