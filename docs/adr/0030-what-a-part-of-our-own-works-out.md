# ADR 0030 — What a part of our own works out itself: `computes:`

- **Status:** proposed, 2026-11-18
- **Decides:** how a model says that a scenario's input stands for logic of one of its own systems,
  which the model does not run, so that the sequence draws it inside that system and not from a person
- **Builds on:** ADR 0018 (systems and sub-systems), ADR 0020 §4 (what an external part sends),
  ADR 0022 (the sequence)
- **Forced by:** a system of our own works something out: a calculation, a search, a choice made from
  data the model does not hold. The model keeps the result and acts on it, but does not compute it, so
  a scenario sends the result as an input. Today an input is drawn from an external part that declares
  it in `sends:`, or else from a person. The result is neither: it is a step inside our own system.

## Context

In `lab`, the order of a route's steps (which step follows which) is worked out by the lab's own
Ordering from the route. The model does not work it out: each scenario sends `Route.Link` for every
pair of steps. The hospital information system was declared to send it, because `sends:` is only for
an external system (ADR 0020 §4). The alternative was to draw it from a person. Both are wrong: no
outside system and no person decides it.

## Decision

1. **A sub-system of our own may declare what it `computes:`**, in the form `sends:` takes (ADR 0020
   §4): `Type.Command`, or narrowed by its payload, `{ Type.Command: { field: [values] } }`. A system of
   one sub-system says it on the system:

   ```yaml
   systems:
     Lab:
       subsystems:
         Ordering: { context: Requests, packages: [Requests, Steps], computes: [Route.Link] }
   ```

   It says that a scenario sends the command in the part's name, as the result of logic of the part's
   own that the model does not run.
2. **One sender.** A command that a part computes, with values that some payload could match, is not
   also sent by an external part, a role or another part: the loader refuses it ("`Route.Link` is
   worked out inside Lab/Ordering and sent by X too…"). An external system takes `sends:`, never
   `computes:`, and a system with sub-systems says it on each.
3. **The sequence draws it inside the part.** The input's arrow starts at the part's lifeline: at the
   level of the systems, a self-arrow on the system; opened into its sub-systems, on the sub-system;
   opened further, on the aggregate it reaches. It is never drawn from a person. What it then sets off
   is drawn as before.
4. **The inspector and the check say it.** The inspector shows "worked out inside" the part where it
   shows "sent by" for an external one. The check no longer lists the command among those drawn from
   a person.

## Consequences

- A result that the model supplies but does not compute reads as what it is, a step inside the system
  that owns the logic. The context map draws no edge for it: nothing crosses.
- A scenario still sends it, with all its data. The model does not check that the result is right; it
  only knows who works it out.
- **Rejected:** `sends:` on a system of our own. `sends:` means "from outside, into the model", and the
  context map draws it as an edge. Also rejected: a person-like actor per system. That would be a
  lifeline beside the system, where the step belongs inside it.
