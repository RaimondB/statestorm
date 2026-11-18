# ADR 0031 — What a part receives, narrowed by the payload, and the choice shown

- **Status:** proposed, 2026-11-18
- **Decides:** how a model says that an event goes to one of several outside parts, chosen by a value
  it carries, and how the sequence shows that a choice was made
- **Builds on:** ADR 0020 §4 (a sender narrowed by the command's payload), ADR 0022 (the sequence)
- **Forced by:** an event that several outside systems could receive, where each one is told only of
  the events whose payload names it: a field says which. Declared as plain `receives:`, every one of
  them is told of every event, and the sequence draws an arrow to each. The model does know which one
  is meant, and the reader cannot see that a choice happened.

## Context

In `lab`, the patient is told by text or by e-mail: updates on the way by text, the order and its
outcome by e-mail. `PatientInformed` carries `about`, which decides it. Two messaging parts that each
`receive: [PatientInformed]` would both be drawn as told of every message. ADR 0020 §4 lets `sends:`
narrow a sender by the command's payload, but `receives:` had no such form.

## Decision

1. **`receives:` takes the form `sends:` does:** `Event`, or `{ Event: { field: [values] } }`. Such a part
   is told of the event only when the payload's field has one of the values:

   ```yaml
   Messaging:
     external: true
     subsystems:
       Text gateway: { receives: [{ PatientInformed: { about: [collected, in transit, at the lab] } }] }
       Mail service: { receives: [{ PatientInformed: { about: [ordered, results ready, a new sample is needed] } }] }
   ```

   The loader refuses a field that the event is never raised with ("PatientInformed is raised with no
   field `colour` (it has about)"), an empty narrowing, and an event listed twice for one part.
2. **The sequence tells only the parts the payload matches.** A value that no part takes reaches none.
3. **A choice is shown as a choice.** When some receiver of an event is narrowed, every arrow of that
   event is marked:
   - the label names the deciding values, `PatientInformed [about = collected]`;
   - the workbench puts a decision's diamond ◇ before the label, in italics, and its tooltip names the
     parts it was chosen among;
   - the Mermaid export wraps the arrow in an `alt` frame, `alt about = collected — one of Text gateway,
     Mail service`.

   An event that every receiver hears, whatever it carries, is not marked.
4. **The inspector** names each receiver's values ("told to Messaging (Text gateway) when about collected
   or in transit or at the lab…"). The context map still draws one edge per part that receives the
   event at all.

## Consequences

- A part chosen by a value of the payload reads as a choice, not as a broadcast.
- Roles (ADR 0027) still receive their events plainly; a part narrows only its own `receives:`.
- The choice is shown on the branch that was taken. The branches not taken are named in the tooltip
  and in the `alt` frame's title; they are not drawn as arrows.
- **Rejected:** a policy per receiver to route the event, which would model a router that does not
  exist; and drawing every candidate with the untaken ones greyed, which doubles the arrows of every
  such event.
