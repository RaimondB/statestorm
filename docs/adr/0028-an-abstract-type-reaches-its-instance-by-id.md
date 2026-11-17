# ADR 0028 — A command to an abstract type reaches its instance by id

- **Status:** proposed, 2026-11-17
- **Decides:** what a command addressed to an abstract type does, now that one can be addressed
- **Builds on:** ADR 0008 (inheritance), ADR 0009 §3 (a reference to an abstract type is a key)
- **Forced by:** places that come in kinds, named everywhere by their id alone. A plan, a list or
  another system's message says *which* place, never *what kind* of place it is, and the step planned
  there must ask that place something. Its kind is the place's own data, so the sender cannot build the
  concrete type's name.

## Context

ADR 0008 made an abstract type a skeleton with no instances: a command to `Step#S1` is an error, and a
sender must name `SiteVisit#S1` or `CourierRun#S1`. ADR 0009 §3 answered the same question for
references, where the value carries the concrete key (`"SiteVisit#R1-CLIN1"`), because the one who sets
the reference knows the kind.

Not every sender knows it. In `lab`, a site is a clinic or a lab. A route plans an analysis at a site
by its id (`site: CLIN2`), and nothing the route has says which kind CLIN2 is. Only the site knows. The
analysis must still ask it whether it can run there. There was no way to write
`command: "<the right subtype>#${event.site}.Describe"`: the kind cannot be read from the event, and a
lookup table in the model would copy what the site already holds.

## Decision

1. **A command to an abstract type reaches the one instance, of any of its concrete subtypes, that
   has the id.** `Site#CLIN2.Describe` reaches `Clinic#CLIN2`. The log records the command at the
   instance it reached, so every view, trace and assertion names the concrete instance, as before.
   The rule that runs is the subtype's: inherited, or overridden by the same key (ADR 0008).
2. **None has the id:** the command is *unhandled*, like a command to an instance that does not exist
   (`no Clinic or Lab has the id X9 — an abstract type is reached, never created`). An abstract type
   is still never created through itself: a creator sent to it stays the error of ADR 0008.
3. **More than one has the id:** an error naming them (`Clinic#P1 and Lab#P1 share the id P1, so
   Site#P1 could be either`), and none is told. Two subtypes may still share an id (ADR 0009 §3 relies
   on it); only reaching such an id by the abstract type is refused. A model whose ids are unique
   across a hierarchy never meets this.

```yaml
policies:
  ask_analysis_site:
    on: AnalysisPlanned
    command: "Site#${event.site}.Describe"     # a clinic or a lab — the site knows which
    with: { analysis: "${event.analysis}" }
```

## Consequences

- A sender names a thing as it knows it: by the abstract type and the id. `lab`'s scenario 11 cannot be
  written without it: the analysis asks its site, and the clinic answers.
- The context map already drew a policy naming an abstract type to every concrete subtype; that is
  what now happens at run time.
- **Rejected: uniqueness at creation**, refusing a second subtype instance with an id already taken.
  That would turn models that are legal today (ADR 0009 §3) into errors, for a case that only matters
  when the abstract type is addressed.
- **Rejected: the concrete type carried in the data** (`site: "Clinic#CLIN2"`). The sender does not
  know it; whoever wrote it would copy the site's own data into every plan.
