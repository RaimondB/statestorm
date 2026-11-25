# ADR 0038 — The sequence draws a policy where it runs, and the three views draw alike

- **Status:** proposed, 2026-11-25
- **Decides:** how a sequence diagram draws a policy that ADR 0035 placed in a part, and how the context map,
  the C4 view and the sequence tell an event from a command
- **Revises:** ADR 0018 §5 and ADR 0022, for a placed policy (one dashed arrow from the raiser to the part
  commanded); closes what ADR 0035 left out on purpose (backlog B-18)
- **Forced by:** the context map and the C4 view place a policy where it runs (ADR 0035), and the sequence
  did not. A policy run by the part that raised its event was drawn as the commanded part hearing that
  event, the opposite of what the map shows. A policy run by a third part, between two others, did not
  appear at all: the sequence drew the raiser commanding the target. A reader comparing the views of one
  model saw two different designs. The views also drew messages differently. The sequence draws an event
  orange and dashed and a command blue and solid, while the map and the C4 view drew every edge alike.

## Context

In `lab`, Ordering registers a request's samples itself (`register_samples`, `in: Ordering`): it hears its own
`RequestCreated` and commands `Sample.Register` in Logistics. The map draws a command from Ordering to
Logistics, with Ordering downstream. The sequence drew `RequestCreated → Sample.Register` as a dashed event
arrow, as if Logistics heard the request. A third part, such as a coordinator that hears one part and
commands another, had no arrow of its own in the sequence.

## Decision

1. **A placed policy is a step inside the part that runs it.** For each hop of a placed policy, the sequence
   draws up to two arrows:
   - **the event**, from the lifeline that raised it to the lifeline of the part that runs the policy,
     when they differ: dashed, labelled with the event;
   - **the command**, from that part to the lifeline it commands, when they differ: solid, labelled with
     the command.

   One firing hears its event once: the commands it sends follow that one arrow, in causal order (ADR
   0022). What stays inside a lifeline is its note, as before.
2. **Which part runs it, per hop**, as the map places it (ADR 0035 §2):
   - `in: target` is the part commanded, so the event crosses and the command is a step there. It is drawn
     as before, `Event → Type.Command`, dashed.
   - `in: source` is the part that raised the event, so the event stays inside and only the command
     crosses, solid.
   - A part by name runs it on the type it serves there, the commanded type or the raiser. A part that
     runs it for two others, neither raising nor holding, is a third part: its own arrow in, its own
     arrow out.
3. **A third part opened down to its aggregates** shows a lifeline of its own for the policies it runs for
   others: `policies`, beside its aggregates. The kernel derives it from the model, so only a part that
   runs such a policy has one.
4. **A policy placed nowhere** is drawn as before: one dashed arrow from the raiser, `Event →
   Type.Command`.
5. **One drawing language in the three views:** an event is orange and dashed, a command blue and solid.
   The context map and the C4 view draw an edge's events and its commands apart. Events heard across
   the edge, with what they became, are dashed and orange. Commands sent across it are solid and blue:
   a placed policy's from the part that runs it, and an external system's. An edge that carries both is
   drawn as two. A map edge says which of its commands are sent across (`MapEdge.sends`).

## Consequences

- The map, the C4 view and the sequence of one model show the same design. A part that runs a reaction
  for others is visible in all three.
- The tests prove each placement on a small model (a third part, `source`, `target`, nowhere) and on
  `lab` (`in: Ordering`, `in: Bench`, `in: target`). `lab` places no policy in a third part, so the small
  model carries that case.
- **How to place a policy** (guidance for a model author, not enforced): place it so that business logic
  couples least.
  - On a **fan-in**, where many senders trigger the same command at one target, the triggering parties
    own it: `in: source`.
  - On a **fan-out**, where one sender has many consumers, each consumer owns it: `in: target`.

  `lab`'s `report_stop` (every step's part tells the sample) and `scans_to_handlings` (one scan reaches
  every handling) follow it.
- **Amended 2026-11-25: one route per pair.** The context map and the C4 view lay out and label each
  pair of parts once, as before. What crosses the pair is drawn as strands beside that route: events,
  commands, and what unplaced policies carry, a few pixels apart. The first strand carries the label and
  the U and D. Laying out each kind as an edge of its own had spread one pair over several routes and
  labels.
- **Rejected:**
  - **A lifeline per policy.** It would be one per rule, many in a real model, and it would split one
    part's reactions over many columns.
  - **Drawing a third part's policy on the commanded aggregate.** That would hide who runs it, the very
    coupling the map shows.
  - **Colouring a map edge by what most of it carries.** An edge with both would still say only one of
    them.
