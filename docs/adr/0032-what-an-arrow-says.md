# ADR 0032 — What an arrow in the sequence says: `sequence: label:`

- **Status:** proposed, 2026-11-18
- **Decides:** which of a message's values the sequence shows beside its name, and how a roll-up of
  many instances stays readable
- **Builds on:** ADR 0022 (the sequence, its folds), ADR 0020 §4 (a sender narrowed by the payload),
  ADR 0031 (a chosen receiver)
- **Forced by:** a command sent many times with different meanings, such as a scan whose payload says
  what happened, where, and to which unit. The sequence labelled each arrow `Type.Command` only, so a
  run read as the same arrow over and over. Showing the whole payload is too long; which few fields
  matter is the model's to say. Some messages are about many instances at once: a plan with a list of
  rows, or an event that reaches every unit on a vehicle. Those must stay short.

## Context

In `lab`, every scan is `Sample.Scan`. What tells them apart is the event (collected, packed, received),
the site and the sample. In the sequence, one run's dozens of scans all read `Sample.Scan`; only the
tooltip and the inspector held the rest. A route's plan names its samples in a list of tube rows. Alike
arrows to several samples fold into one (ADR 0022 §3), which must not lose which samples it stands for.

## Decision

1. **`sequence: label:` names, by command (`Type.Command`) or event, the fields its arrow shows**, in
   order, after its name and a `·`:

   ```yaml
   sequence:
     label:
       Sample.Scan: [event, site, id]
       Route.Plan: [lab, tubes.sample]
   ```

   `Sample.Scan · Collected · CLIN1 · S1`. A field that is empty or absent is left out. For a hop, the
   event's fields follow the event and the command's follow the command.
2. **A list shows its values**, and a path into a list of rows (`tubes.sample`) shows each row's field:
   `Route.Plan · LAB1 · S1, S2`. More than three are cut short with a count: `S1, S2, S3 +2`.
3. **`id` lists the instances the arrow reached.** It is shown last, and it is not part of the label: alike
   arrows to different instances still fold into one (ADR 0022 §3), and the folded arrow lists them all,
   `Sample.Scan · Packed · CLIN1 · S1, S2`, cut short the same way. This is how a roll-up, such as one
   event reaching every unit on a vehicle, reads as one arrow that names its units.
4. **By default, a command from outside shows the fields its senders are narrowed by** (ADR 0020 §4). Those
   are the fields that tell its kinds apart, such as a scan's event. With nothing declared, `lab`'s scans
   read `Sample.Scan · Collected`. An event shows nothing by default; a chosen receiver keeps its
   `[field = value]` (ADR 0031).
5. **The loader refuses** a command a type does not answer, a name that is neither such a command nor an
   event the model raises, a field the command does not take or the event is never raised with (only the
   first segment of a path is checked), and an empty list.
6. The tooltip, the inspector and the Mermaid export are unchanged in what they offer: the full payload
   stays one click away, and the export shows the same text as the arrow.

## Consequences

- A run reads as what happened, not as one message name repeated.
- The model decides what matters; the platform knows no field names (AGENTS.md).
- **Rejected:** a free text template with `${field}` holes. An absent field leaves stray text behind, and
  an id inside the label would stop alike arrows from folding. Also rejected: showing every field, which
  is too long, and the instance id always, which is noise for most messages.
