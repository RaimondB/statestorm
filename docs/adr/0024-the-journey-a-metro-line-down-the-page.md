# ADR 0024 — The Journey: each root a metro line down the page

- **Status:** proposed, 2026-11-13
- **Decides:** a second overview of a run, for business readers: compact, time down the page, every
  step's progress, the events received at each, and the identifiers that name them
- **Forced by:** a domain owner: *"instead of a left to right time dimension … the time dimension to flow
  from top to bottom, and a more compact view, like a metro line (or maybe 'git branch' style) that
  shows the progress of the activities and tasks hierarchy. It should be easy to comprehend for business
  users, where they need to see the progress on each activity and task, the timeline of received events
  and also the relevant identifiers of each concept."*

## Context

The overview (design §8) draws a run as nested boxes left to right, events in stickies under them. It
shows everything at once, which suits the people who built the model; a business reader asks a simpler
question per step — how far has it come, what was received there, about which sample, when. Two layouts were
weighed: a metro line (stations in plan order, the events under each) and a git log (a row per event in
time order, a column per activity). The owner chose the metro line.

## Decision

1. **A view of its own, the Journey**, read from the overview the same frame builds: the same boxes,
   the same events by the same rules (ADR 0023: a subject's events, the asks as markers, the reader's
   switch). It adds no rule about what to show; `--without=journey` leaves it out.
2. **Each root is a line** down the page — a request, its title its label, id and state. Its boxes
   are **stations**, in the overview's plan order: a sequence is the line going on; a station's own
   steps (a row of children — a step's tasks) are a thinner line inside it; a band (a route's
   end-to-end tasks) is a strip of chips on its station. **What runs side by side branches**: a layer of
   the `follows:` layout with more than one box is a branch of lines next to each other, joining after.
3. **A station's colour is its progress**: the line below a station is solid in its tone (done, in
   progress, failed, on hold), dashed while it has not started.
4. **Under each station, the events received there**, oldest first: one row per moment — what arrived
   at once for several units is one row — with whom it was about (the units' badges), a substatus where
   it has one, any fields worth reading (`overview.journey.attributes`, then `attributes`), and the
   clock where it moves. The latest row is marked *now*.
5. **Several lines side by side.** All of a run's roots are offered; the first three show, and the
   reader picks — a request and the repeat sent after it, one patient's two requests. The lines
   shown are in the link (`lines=`), as is the switch.
   With `overview.journey.together: <field>` the lines that share its value form one group — a
   patient's requests — offered by that value, and the first group shows.
6. **Its own words, if the overview's are not the business's**: `overview.journey.label: { Type:
   template }` is read before `overview.label`, for the Journey only.

## Consequences

- A domain needs no configuration to have a Journey; the examples draw one as they are.
- Rejected: a git log as the layout (exact in time, harder to read per step — it can be an option of
  the same view later); a line per unit (the units of one root travel together; the exceptions — units
  that go their own way — show as the badges on each row, and the unit filter); a separate events configuration
  for the Journey (two views telling different stories of one run).
