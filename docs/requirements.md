# Requirements

Draft 1 — 2026-10-09. Numbered so we can argue about individual lines.

## 1. Purpose

A browser-based workbench where a domain model expressed as **event-raising aggregates**
can be built, executed, inspected and explained.

Three jobs it must do, in priority order:

1. **Validate a design with business owners.** Non-technical stakeholders must be able to
   follow a run and say "no, that's not what happens when a customer cancels late".
2. **Explain and teach.** Make the DDD vocabulary — aggregate, command, domain event,
   policy, invariant, eventual consistency — visible and pokeable rather than abstract.
3. **Converge on a design engineers can build.** The model is the artifact: diffable,
   reviewable, backed by scenarios that fail when the rules change.

Explicitly *not* a production workflow engine, and not tied to any one domain (home
automation is one possible subject, nothing more).

## 2. Personas

| | Who | Needs |
|---|---|---|
| **P1 Modeller** | You, in a design session | Fast authoring, immediate feedback, undo, "what if I move this rule" |
| **P2 Business owner** | Domain expert in a workshop | Recognisable notation, plain-language narration, the ability to say "run it again but pay on day 15" |
| **P3 Engineer** | Whoever builds it later | Unambiguous semantics, scenarios as a regression suite, an export path to real code |
| **P4 Learner** | Someone being taught DDD | Guided example models, step-by-step execution, visible guard evaluation |

## 3. Domain concepts the tool must represent

- **R1** **Aggregate type** with a named lifecycle (a **hierarchical** statechart) and local
  data. The active state is a root-to-leaf *configuration*, not a single label: a composite
  state and its substate are active together, so the composite's handlers and deadlines apply
  while the substate runs. See ADR 0005.
- **R2** **Aggregate instance** — identity matters; several `Order`s coexist and are
  addressed independently.
- **R3** **Command** — imperative, addressed to one aggregate instance, carries a payload,
  **may be rejected** (rejection is a first-class, visible outcome, not a crash). An aggregate
  declares which commands may *create* an instance; anything else addressed to one that does
  not exist is reported rather than quietly conjuring it into being.
- **R4** **Domain event** — a past-tense fact raised by an aggregate as part of a
  transition. Immutable, broadcast, ordered.
- **R5** **Policy** (reaction / process manager / saga) — subscribes to event types and
  issues commands. This is how aggregates influence each other; aggregates never call each
  other directly. A policy is a **correlated statechart** so that it can remember — wait for
  two events, react only the first time, hold a deadline an event can defuse. The one-liner
  `on X do Y` is sugar for a single-state policy. See ADR 0003.
- **R6** **Invariant / guard** — a boolean over the aggregate's own state and data that can
  block a transition. Blocked transitions must be *reported*, never silently dropped.
- **R7** **Timer / deadline** — "after 14 days in `unpaid`". Driven by the simulated clock,
  and **scoped to the state that declares it**: a deadline on a composite survives
  transitions between its substates ("fulfilment must finish within 30 days").
- **R8** **External system** — a stub that events can be sent to and commands can arrive
  from, so the boundary of the model is explicit.
- **R9** **Bounded context** — a grouping of aggregate types, shown as a swimlane; events
  crossing a context boundary are visually marked.
- **R10** **Read model / projection** — derived view of the event stream, so a workshop can
  be shown "what the customer sees". *Candidate for v2.*

### 3.1 Relations and quantifier rules (ADR 0004)

- **R41** **Parent/child relation**, declared on the parent with an explicit correlation
  expression. Children are separate aggregates with their own lifecycles, not entities inside
  the parent's boundary.
- **R42** **Derived tally**: the kernel maintains, per parent instance, the count of its
  children per state — derived from the log, never hand-maintained by the modeller.
- **R43** **Quantifier rules** on the parent, over that tally, in two forms (ADR 0006 §4).
  **Predicates** (`all_final`, `any`, `none`) are conditions: order- and
  duplicate-insensitive, evaluated on entry to their state and on every tally change, fired
  once per occupancy, re-armed on re-entry. **Edges** (`first_entering`, `last_leaving`) are
  moments: they fire on the crossing and may legitimately pass unobserved, which makes them
  suitable for notifying and unsuitable for driving a state change.
- **R44** Quantifier rules resolve **asynchronously** — child transition, then tally, then
  parent transition, each visible as a separate step in the trace. A parent must never read a
  child's state synchronously inside a guard; the consistency gap is a feature to show, not a
  wrinkle to smooth over.
- **R45** Universal quantifiers are **false over an empty collection** unless the model opts
  in, so a childless parent does not complete itself the moment it is created.
- **R46** The inspector can **expand a quantifier rule** into the generated policy, counter
  and guard it stands for — the convenience doubles as the lesson in what it costs in real
  code.
- **R47** **Fan-out**: a policy can create one child per element of an event payload
  collection (`for_each`). This is the only place the expression language meets collections.
- **R48** **Completion of a composite** raises an internal `done.<State>` signal its parent
  state may transition on. This is a signal, **not a domain event** — not a business fact, and
  rendered distinctly from one.
- **R49** State references are **dotted paths** (`Fulfilling.AwaitingPayment`) everywhere:
  model, expressions, scenario assertions, URLs. Two matching forms exist — exact leaf match
  and `in_state(X)` for "anywhere in the configuration".
- **R50** Parallel regions and history states are **not in v1**, but the kernel's
  representation of an active configuration must not preclude them (ADR 0005).

## 4. Authoring

- **R11** A model is a set of plain-text files (YAML or JSON), hand-editable and
  git-diffable, with a published schema and validation errors that point at a line.
- **R12** The UI can edit the model too; text and visual editing are two views of one
  source of truth, not an import/export pair. **Text comes first** (Q2): the board is
  clickable for *running* a model long before it is editable, because "fire this command" is
  the interaction a stakeholder actually needs.
- **R13** Reference models ship with the tool (order/payment/shipment; a late-fee saga;
  something with a timer) as teaching material and as the tool's own test fixtures.
- **R14** A model loads and saves without a server (see R30).

## 5. Execution

- **R15** **Deterministic given a schedule.** Same model + same scenario + same *schedule* ⇒
  byte-identical trace. No wall clock, no unseeded randomness. The schedule is an input, not
  an accident: the infrastructure being modelled is at-least-once with no guaranteed order,
  so a single canonical interleaving would validate nothing (ADR 0006).
- **R15a** **Schedules**: `fifo` (the default, and the one readable story), `random(seed)`
  (arbitrary interleaving, reproducible from its seed) and `duplicate` (every delivery
  happens twice). Messages are reordered and duplicated, never lost.
- **R15b** **Idempotency is a modelling obligation, and the tool must not paper over it.** A
  transition may declare an identity and is then applied once per identity; otherwise it is
  expected to be naturally idempotent. A recognised repeat is written to the log — the kernel
  never dedups silently.
- **R15c** The loader **warns** about what at-least-once makes dangerous: an assignment that
  reads the field it writes with no declared identity, and an edge quantifier driving a state
  change.
- **R16** **Simulated clock**, advanced explicitly: step by a duration, jump to a timestamp,
  or run to the next scheduled timer.
- **R17** **Append-only event log is the single source of truth** for a run. Every view and
  every current state is derived from it.
- **R18** **Causation visible**: each entry records what caused it (command → transition →
  events → policy → command …), as a chain that can be walked in the UI.
- **R19** **Step granularity**: run to quiescence, or single-step one command / one event /
  one policy evaluation at a time.
- **R20** **Time travel**: scrub to any point in the log and see the whole board as it was
  then; continue the run from there (forking a run is acceptable).
- **R21** **Guard transparency**: for any command that did not change anything, the tool
  states why — the full **rejection chain**, since a command bubbles outward through the
  active configuration: which state offered a transition, which guard was evaluated, what
  values it saw, and why the search moved on.
- **R21a** Where two levels of the hierarchy both handle a command, the tool shows **which
  level won**. An inner handler silently shadowing an outer one is a modelling bug that
  otherwise looks like nothing at all.
- **R22** Clear, loud reporting of modelling errors found at runtime: unhandled command,
  event nobody subscribes to, policy targeting a nonexistent aggregate, two policies
  issuing contradictory commands.

## 6. Visualisation

- **R23** **Event-storm board** (business-facing): the EventStorming sticky grammar —
  command → aggregate → event → policy — laid out on a left-to-right timeline, with
  context swimlanes. The primary view for P2.
- **R24** **Statechart view**: zoom into one aggregate type, see its **nested** states and
  transitions as compound boxes, with live instances highlighted on their whole active
  configuration — not just the leaf.
- **R25** **Wiring / coupling view**: aggregate types as nodes, policies as labelled edges.
  Answers "what breaks if I change this event".
- **R26** **Trace timeline**: the ordered log with a scrubber, filterable by aggregate,
  instance or event type.
- **R27** **Narration**: the trace rendered as plain-language sentences, suitable for
  reading aloud in a workshop.
- **R28** Animation of a cascade (event → policy → command → transition) slow enough to
  follow, with a speed control.
- **R29** Light and dark, legible on a shared screen/projector — large type, no
  colour-only encoding.

## 7. Scenarios and testing

- **R30** A **scenario** is a text file: a `given` (seed events or states), a `when`
  (timed sequence of commands and clock advances) and a `then` (assertions over final
  states and the event log, including *negative* assertions — "no shipment was requested").
- **R31** Scenarios run **headless** in CI as a regression suite, and **replay in the UI**
  with the same result.
- **R32** A run performed by hand in the UI can be **saved as a scenario** — the workshop
  output becomes the test.
- **R33** Coverage feedback: which states and transitions no scenario has ever reached.
- **R34** *Stretch:* mutation-style check — flip a guard, assert some scenario fails. (A test suite that passes against a broken
  model is not a test suite.)

## 7b. The model check (agreed 2026-10-19)

Agreed with the domain owner as proposed ("agree with above"), MC-6 postponed; MC-11 added by
them. It refines R33 (coverage) and R22 (loud modelling errors).

- **MC-1** Three layers, built in this order — each cheaper than the next and earning trust for
  it: **static checks** (read the model, run nothing), **coverage** (what no scenario reaches),
  **exploration** (the kernel generates runs to find stuck or wrong outcomes no scenario shows).
- **MC-2** Static checks: an event nobody listens to; a policy on an event nobody raises; a
  command nobody sends that no person is expected to send; a state no transition enters; a
  non-final state with no way out; an entity type nothing creates; a guard comparing a field with
  a value it can never hold (`kind == 'outbond'`). Each finding has a severity, like the loader's.
- **MC-3** Coverage: every state and transition of every type, against the union of all scenario
  runs under all schedules; per type, what is never exercised, with its guard; the flow-board
  arrows as a second view. A gap that is accepted is stated in the model — `coverage: ignore:`
  with a reason — so every gap is a decision, not an oversight.
- **MC-4** Exploration starts from each scenario's own inputs and varies: every message ordering,
  bounded (all interleavings up to N messages in flight) instead of five random seeds;
  duplicates; the scenario's own independent steps reordered (a scan before the plan). No free
  generation of arbitrary commands yet — it explodes, and most of what it finds is nonsense input.
- **MC-5** Exploration checks generic properties, nothing declared: no error findings; every
  ordering ends in the same final states (convergence, ADR 0006); no instance stuck in a non-final
  state with nothing in flight that could move it; a duplicate never changes the outcome.
- **MC-6** *Postponed:* invariants declared in the model (`checks:`). Decided later, against a
  real need.
- **MC-7** Two faces: a **CLI** for CI (`statestorm check model.yaml scenarios/`, non-zero exit on
  errors) — first, because it drives the tests — and a **Check tab** listing findings and
  coverage, where a click jumps to the type, state or transition, or replays a counterexample.
- **MC-8** A counterexample is a replayable scenario file — inputs and message order — shrunk to
  the shortest run that still fails, ready to keep as a regression scenario.
- **MC-9** Budget: a cap per scenario (states or seconds); the report says how much was explored
  and whether it was exhaustive within the bounds. `pnpm test` runs static, coverage and a small
  exploration; the full exploration is a command of its own.
- **MC-10** The CLI and findings speak to the modeller; the Check tab speaks the business's
  language where it can ("Too old to run never follows In the queue in any
  scenario"), kernel terms in the details.
- **MC-11** **Proposed scenarios** (the domain owner). For each coverage gap, the check proposes
  a scenario that would close it (agreed as proposed):
  - **a** It starts from the existing run that comes closest — reaches the state the missing
    transition starts from — and searches for the input that takes it: a scan or command the rule
    accepts, with values that pass its guard (from the guard's own comparisons and the run's ids).
  - **b** Up to **three extra steps**, using only inputs the model offers: the scans of the things it
    tracks, a person's Confirm / Resolve / Redeliver and the like. A different plan is out of scope: a gap
    it cannot reach is reported as "needs a new journey", with what that journey would need.
  - **c** Gaps are untaken transitions (the modeller's view) and missing flow-board arrows (the
    business's view).
  - **d** Ordered business-visible first (flow arrows, customer notices, upstream statuses), then
    deviations and failures, then internal transitions; within a group, shortest proposal first.
  - **e** The CLI writes them to `scenarios/<model>/proposed/`, one file per gap, marked proposed
    and outside `pnpm test`; the Check tab lists them with *replay* and *keep* (keep moves the
    edited file into the suite). A proposal says only what the model does; whether it is right is
    the domain owner's call.
- *MC-11 built 2026-10-19 for drawn arrows (`--propose`); untaken transitions not yet.*
- **MC-12** **Drawn flows as data** (the domain owner: "a way to capture all the expected
  transitions for the drawings, so we can import them cleanly and decide which ones actually go
  in the model"). Each business drawing is captured as a file of its own — its lanes and every
  arrow, under the drawing's own names — next to the model, and **each arrow carries a decision**:
  in the model, later (with why: reverse flow, cancellation), an open question (with its
  reference), or not in the model (with why). The check compares:
  - an arrow decided *in the model* that no scenario shows → a gap, with a proposed scenario;
  - an arrow the scenarios show that no drawing has → behaviour nobody drew, to be decided;
  - a drawing's name that maps to no model status → an import error, not a silent miss;
  - and summarises per drawing how many arrows are in, later, open, rejected.
- **MC-14** **One drawing per scenario** (the domain owner, 2026-10-21: "a single scenario should be
  mappable to one primary drawing that has all the arrows it needs. It could also point to arrows
  missing on certain drawings"). Each scenario names the drawing it walks (`drawing:`); the
  drawing's scenarios are those (a shared path names its own). The check lists, per drawing, every
  arrow its scenarios walk that it does not draw — and where else it is drawn, if anywhere: a
  point to raise and address. The UI groups the scenarios by drawing, and the Flow tab shows a
  group's — or one scenario's — arrows on the drawing, marked drawn, missing, decided, or proposed.
- **MC-15** **Tags** (the domain owner, 2026-10-21: "each drawing group of scenarios also contains a
  happy path … indicate which ones are happy and which are deviation scenarios … a way to show all
  cancellation scenarios together"). A scenario's `tags:` say its kind — `happy` or `deviation`,
  exactly one — and what it is about (`cancellation`, `missing`, `haemolysed`, …). The check
  warns on a scenario without one kind and on a drawing whose scenarios have no happy path. The
  picker marks ✓ happy and ⚠ deviation and filters by tag; on Flow, the arrows of every scenario
  with a tag. A tag shaped like an id in a list kept elsewhere — a test plan's `WOM-12`, a ticket
  `LFMT-280` — is a **reference** (2026-11-02, a test plan to trace to scenarios): the Tag menu
  lists references under their prefix, in number order, with *every WOM-\** for all of them; the
  picker shows a scenario's references before its name and finds it by one typed.
- **MC-16** **What each scenario alone covers** (the domain owner, 2026-10-22: "it would be beneficial
  to have clear what each scenario uniquely covers"). Per scenario, over its runs under every
  schedule: the rules it alone takes, the states it alone reaches, and the drawn arrows (decided in
  the model) it alone walks among its drawing's — or its path's — scenarios. The check says how many
  scenarios cover nothing of their own; `--scenarios` lists what each covers. A scenario with
  nothing of its own adds runs, not reach — kept, if at all, for what it asserts.
- **MC-17** **Unanswered commands** (2026-10-22). A command no rule answered in the runs — not
  handled in the state it found, refused because no guard held, or sent to an instance that does
  not exist — is a message lost, or a no-op the model does not say. Each kind (type, command, state)
  is an error, with the scenarios it happens in; `--all` says why. A redelivered command (ADR 0006)
  and a refusal a scenario asserts (`rejected:`) are left out — but a command a policy sends again,
  because the event reached it twice, is a repeat the model answers. The model answers by handling it, or
  by saying the no-op (`Name: {}`), which makes it a decision a mutation can test. (Built as a warning
  first; an error since the domains and the examples answer every command, 2026-10-22.)

## 8. Non-functional

- **R35** **Browser-only SPA**, no backend required. Persistence via the File System Access
  API where available, with file download/upload and `localStorage` as the fallback.
  Multi-user workshop mode is a roadmap item (§10), and is the one feature allowed to
  revisit this constraint.
- **R36** Stack: TypeScript, Vite, React, pnpm — familiar tooling.
- **R37** A model + run must be shareable as a single file (and ideally a URL) so a design
  can be mailed to a stakeholder. *Built 2026-10-22:* `statestorm share <domain folder>` writes
  the workbench and the domain into one HTML file that opens from disk — no install, no server.
  A URL is still open.
- **R38** Responsive enough to be driven on a laptop in a meeting room; offline-capable.
- **R39** Performance target: models of ~30 aggregate types and runs of ~10 000 log entries
  stay interactive.
- **R40** The execution kernel is a separate package from the UI, with no DOM dependency,
  so it can run in Node for CI and be reused elsewhere.

## 9. Non-goals (v1)

- Executing BPMN, or being a workflow engine (see ADR 0002).
- Generating production backend code. An *export* of statecharts/types is a later stretch.
- Connecting to live systems or real event brokers.
- Persistence of real business data; everything is a simulation.

## 10. Roadmap, deliberately later

- **Multi-user workshop mode** — several people on their own devices against one model.
  Needs a backend and conflict handling; until then a session is one driver on a shared
  screen. Read-only spectator links are the cheap middle step.
- **Visual authoring** (R12), once the text workflow proves to be the bottleneck.
- **Read models / projections** (R10).
- **BPMN export** of stateful policies (ADR 0002).
- **XState export** of aggregate lifecycles (ADR 0001) — scheduled early enough to stay
  honest, not so early that it constrains the kernel.
