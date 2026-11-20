# ADR 0035 — A policy runs in a part, and the map says who depends on whom

- **Status:** proposed, 2026-11-20
- **Decides:** where a policy runs, and how the context map and the check use it to say which side of
  a crossing depends on the other
- **Builds on:** ADR 0018 (systems, sub-systems, the context map), ADR 0020 (external systems)
- **Forced by:** a policy hears an event raised in one part and commands a type in another, but it
  belongs to neither. The map draws it as an arrow from the raiser to the target either way. When the
  receiving part subscribes to the event, the raiser does not know it exists. When the raising part
  commands the receiver, it depends on the receiver's commands. The two couple the parts in opposite
  directions, and the model cannot say which one it means. So the map cannot show upstream and
  downstream, and nothing warns when two parts each depend on the other.

## Context

In `lab`, a scan raised on the sample (Logistics) reaches every step's handling of it: the route's
(Ordering), the site visit's and the transfer's (Logistics), the analysis's (Bench). That is one policy,
`scans_to_handlings`, over the abstract `Handling`. Drawn today, Logistics has an arrow to Ordering and
to Bench. That arrow could mean either of two things:

- **Logistics commands the bench's handlings.** Logistics then knows every step that holds a sample,
  and changes whenever one is added.
- **Each part hears the sample's scans and updates its own handlings.** Logistics knows none of them.

The second is the design `lab` intends, and the model has no way to say it. A relation declared by
hand (`relations:`) names a pattern for a pair, but nothing derives it or checks it against the
policies.

The reverse shape is there too. When a step stops expecting its sample (a haemolysed tube, a
rejection), its handling raises `SampleStopped`, and the other steps' handlings stop with it. That
event is raised in every part that has a step, and heard in every part. Whichever side runs the
policy, each part ends up depending on each of the others.

## Decision

1. **A policy may say where it runs: `in:`.** The value is one of the model's sub-systems, or a system
   of one sub-system by its name:

   ```yaml
   ask_analysis_site:
     in: Bench
     on: AnalysisPlanned
     command: "Site#${event.site}.Describe"
   ```

   The policy runs in that part: it hears the event there and sends the command from there. The loader
   refuses:
   - a name that is no sub-system ("ask_analysis_site: in: Benchh — there is no sub-system called
     Benchh");
   - a system in parts by its own name ("in: Lab — Lab is in parts: name one of Ordering, Logistics,
     Bench");
   - a part that runs none of the model's packages, such as a vendor's part that only sends scans;
   - `in:` in a model without `systems:`.
2. **`in: target` and `in: source` — one policy, run by each part for its own.** A policy over an
   abstract type whose subtypes live in several parts is, in effect, one copy per part. **`in: target`**:
   each part it commands runs it, hearing the event and commanding only its own types:

   ```yaml
   scans_to_handlings:
     in: target            # the route's handlings in Ordering, the analysis's in Bench, …
     on: [Collected, Packed, PickedUp, Delivered, Received, Rejected, Queued, Analysed, Released]
     for_each_referrer: Handling.sample
     command: "${item}.${eventName}"
   ```

   Every command's type must be readable from the model: a literal `Type#id`, or a `for_each_referrer`.
   Otherwise the loader refuses ("in: target — the type of `${event.kind}#${event.id}.Open` is worked
   out at run time").

   **`in: source`**: each part that raises the event runs it for its own events, and sends the command
   from there. The stop in `lab` now goes through the sample, which every part already hears. Each step's
   part tells the sample, and the sample tells every step:

   ```yaml
   report_stop:              # each step's part tells the sample of its own stopped step
     in: source
     on: SampleStopped
     command: "Sample#${event.sample}.Stop"
   sample_stopped:           # each part hears the sample, for its own steps
     in: target
     on: SampleHalted
     for_each_referrer: { via: Handling.sample, of: "${event.sample}" }
     command: "${item}.SampleStopped"
   ```

   An event that no type raises has no part to run it, so the loader refuses it. A sub-system called
   `target` or `source` would make the word ambiguous, and the loader refuses that too.
3. **Who depends on whom follows from where the policy runs.** A part that runs a policy depends on:
   - every part whose event it hears, since it subscribes to that event;
   - every part whose type it commands, since it uses that part's commands.

   The part it depends on is **upstream**, and the part running the policy is **downstream**. Each map
   edge still points the way the message travels: an event from where it was raised to where it is
   heard, a command from where it is sent to where it is handled. Each edge now also says which end is
   downstream (`MapEdge.downstream`, one end or, when each depends on the other on that edge, both). It
   lists the policies that carry it (`MapEdge.policies`). Under `in: target` only the event crosses; the
   command stays inside the part that runs it.
4. **When the map does not know, it says nothing.** A policy without `in:` is drawn as before, from the
   raiser to the target, with neither end marked downstream. An external system's edges, made from its
   `sends:` and `receives:`, are marked only by a declared relation: the model cannot tell whether the
   vendor calls in or an adapter of ours pulls (`anticorruption-layer`). A declared relation also marks
   an edge between our own parts that nothing placed derives.
5. **The map shows it.** Upstream is laid out above downstream. Each edge has a **U** at its upstream
   end and a **D** at its downstream end. An edge between two parts that depend on each other is drawn
   as a warning. The Mermaid export says `U → D` or `D → U` in the label. The inspector shows a policy's
   part ("runs in Bench"), and for an edge, which end is downstream and the policies that make it so.
6. **The check warns** (`systemFindings`):
   - **Some policies placed and others not.** Once a model places one policy, it is listing them all, so
     the rest are listed: "not placed: book_boxes, boxes_arrive — say `in:` (ADR 0035)".
   - **Two of our own parts depending on each other**, at the sub-system level and, where the cycle runs
     through other parts of the same systems, at the system level. Each side is named with a policy that
     makes it so. With the stop heard step to step, as before the sample was the hub: "Bench and
     Ordering depend on each other — Bench through report_stop, Ordering through report_stop: let one
     only hear the other".
   - **A declared relation that the policies contradict:** the relation says A is upstream of B, while
     the placed policies make A depend on B and not the other way.

## Consequences

- A model can say which side owns a reaction, and the map shows the dependencies the teams will live
  with, not just who sends what. `in: target` writes the publish-and-subscribe design in one line: a
  library's abstract type, heard by every part that has a subtype of it.
- Placing a policy changes nothing at run time. Scenarios, schedules and the runs are untouched. In
  `lab`, routing the stop through the sample adds one command and one event, `Sample.Stop` and
  `SampleHalted`. Its scenarios end as before, under every schedule.
- **Left out on purpose:**
  - **The sequence diagram** still draws a policy's command from the raiser's lifeline to the target's.
    A policy that runs in a third part (an orchestrator hearing one part and commanding another) would
    need two arrows and a lifeline of its own. That is backlog B-18.
  - **Who depends on an external system** stays the declared relation's to say (§4).
- **Rejected:**
  - **Listing policies in `packages:`** would place a policy where its package is, as types are. But a
    reaction is not a type, and a list per package far from the policy's body drifts. `in:` sits on the
    policy, where a reader looks.
  - **Inferring the part from the target**, as if every policy were `in: target`, would make every
    command a subscription and hide the very coupling the map is for.
  - **Warning on any command between two of our parts** would warn on an orchestrator commanding its
    workers, which is a legitimate design. The check warns on what is always a smell: a cycle, or a
    contradicted relation.
