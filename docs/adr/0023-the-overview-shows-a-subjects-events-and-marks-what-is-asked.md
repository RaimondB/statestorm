# ADR 0023 — The overview shows a subject's events, and marks what is asked

- **Status:** proposed, 2026-11-13
- **Decides:** which events the overview draws, and how it draws what the model asks someone and waits on
- **Revises:** the overview's `events:` (design §8): `hide:` alone said what to leave out
- **Forced by:** a domain owner whose overview grew a planning event for every row of a plan: they
  wanted only the events of what travels shown, and the things the model asks of someone — a request
  sent upstream, a decision a person must take — shown differently, *"to not clutter the overview"*

## Context

The overview places every event the model raises under the box it raised or moved, except those named
in `events.hide`. A real domain's list had grown to some seventy names, and it fails open: every new
event is shown until someone hides it — as a plan's six planning events were, on the request.
What the reader wants under the boxes is the statuses of what travels — what happened to a
sample — and that is a rule the flow board already has (`flow.of`). Some other events are worth seeing
once, but as a different thing: a question put to someone (a person's decision on a deviation, a
new sample asked of the clinic) is open until it is answered, and that is what a reader needs to see.

## Decision

1. **`events.of: [Type]`** — only the events about these types reach the event lane: raised by one, or
   naming one in a reference their raiser declares (`sample: S1`, where `sample` refers to a `Sample`).
   The flow board's rule, so both views agree on what a sample's events are. Without `of:`, as before.
2. **`events.show: [Event | pattern]`** — shown whatever `of:` and `hide:` say. `hide:` still applies on
   top of `of:`.
3. **`events.asks: { Event: { mark, icon, answered: [Event…] } }`** — an event the model asks someone
   with is not drawn in the lane: it is a **marker on the box** it would have sat under (`? decision`),
   amber while it is **waiting**, grey once **answered** — answered by the first later event of
   `answered` about the same subject (without `of:`, raised by the same instance), named on the marker
   when it is one thing (`? decision: rebooked`). Each occurrence is its own: asked twice, answered once,
   the marker says *1 waiting*. It reads the moment the reader is at: stepping back reopens it. A click
   travels to the ask. The marker is part of what a box shows, so stepping by what is visible stops on it.
4. **The reader chooses, on top**: a switch on the overview — *statuses* (the lane, no markers),
   *+ asks* (the default, when the model has asks), *every event* (nothing hidden, an ask an event
   like the others — for working out what happened). It travels in the link (`events=`).

## Consequences

- A domain with `of:` can drop most of its `hide:` list; the leftovers are a subject's own plumbing.
- What answers an ask is the domain's to say, and must be an event about the same subject: an answer
  that names no subject (a new request created upstream) cannot close an ask about a sample. A domain
  that needs it either names the subject in that event or chooses a later one that does.
- Rejected: an allow-list of event names (the flow board's lanes already list the statuses — a second
  copy); classifying every event in the model (`kind: status | request | …`) — a change to the model's
  format for one view, and two hundred events to classify; deriving an ask's answer from a lifecycle
  of its own — right where a request is an instance, but no request is one yet; a separate lane for
  asks — it takes them away from the step they are about.
