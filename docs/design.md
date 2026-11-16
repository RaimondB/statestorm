# Design sketch

Draft 1 — 2026-10-09. Paired with [requirements.md](requirements.md); decisions with real
alternatives are split out into [adr/](adr/).

## 1. The one-paragraph model

A **model** declares aggregate types, policies and external systems. A **run** is an
append-only **log** of commands, transitions and domain events against a **simulated
clock**. Aggregates own state and invariants; they never talk to each other. Policies are
the only wiring: they subscribe to event types and issue commands, and they are statecharts
themselves so a rule can wait, remember and hold a deadline. A parent aggregate learns about
its children only through a derived tally, so "every line is finished" is a quantifier the
kernel maintains rather than a reach across the boundary. Everything you see on
screen — the board, the statecharts, the current state of every instance — is a projection
of the log, which is why time travel is cheap and runs are reproducible.

## 2. Execution semantics

The part that must be nailed down first, because every other decision depends on it.

### The turn

Execution proceeds in discrete **turns**. A turn starts with exactly one command and runs
to quiescence. Which input a turn starts with is the **schedule's** choice, not the queue's
insertion order — delivery is at-least-once and unordered (ADR 0006), so `fifo` is one
schedule among several rather than the semantics:

```
1. Dequeue one command.
2. Route it to its target aggregate instance (create it if the command is a creator).
3. Resolve a transition, innermost-first through the active configuration: the deepest
   active state offering a match whose guard passes wins; otherwise the command bubbles
   outward to the ancestor. A failed guard does not end the search.
   - nothing anywhere in the configuration matches -> log CommandUnhandled (R22)
   - candidates existed but none passed -> log CommandRejected{rejection chain} (R21),
     naming each state, its guard, and the values that guard saw
4. Apply the transition: exit innermost-outward up to the LCA of source and target, enter
   down to the target's initial leaf, update data, append domain events to the log. A leaf
   that is `final` completes its composite and raises done.<State> for the parent to act on.
5. If the instance has a parent, update the parent's derived child tally. A tally change
   enqueues a command to the parent for any matching quantifier rule (ADR 0004).
6. For each event, in log order, deliver to every subscribed policy instance, selected by
   its correlation key (ADR 0003). Each policy transition may enqueue commands; they go to
   the back of the queue.
7. Repeat from 1 until the queue is empty.  <- quiescence
```

Notable consequences, all deliberate:

- **Breadth-first under `fifo`.** A cascade spreads a ring at a time rather than diving
  depth-first, which is easier to narrate — and it is the default for exactly that reason.
  It is not a guarantee the infrastructure makes: `random(seed)` and `duplicate` exist to
  find out what the model does when the bus misbehaves.
- **Eventual consistency is visible.** Between two turns the world is inconsistent — exactly
  the thing business owners need to see and engineers tend to hand-wave.
- **One aggregate, one transaction.** A transition touches one instance. If a rule needs two
  aggregates to change together, the model forces you to write a policy, and the gap shows
  up in the trace. That is the lesson, not a limitation.
- **Policy order is declared, not incidental.** Where several policies subscribe to one
  event, order follows declaration order in the model file, and the UI warns that the model
  depends on it.
- **A parent is always one step behind its children**, by construction. The tally updates in
  step 5 and the parent reacts in a later turn, so a run always shows the window in which
  the order is not yet "completed" although its last line is done. That window is the thing
  worth arguing about in a workshop.

### The clock

The clock only moves when asked (R16), and only at quiescence. Advancing it fires any
timers that fall due, oldest first, each as a fresh turn. "Run to next timer" is therefore
a well-defined step. Nothing in the kernel reads the wall clock.

### Delivery

A message may be delivered more than once and in an order nobody intended; it is never lost.
A transition that cannot survive a repeat says so with `idempotency:`, naming the *domain's*
identity for the thing (`command.paymentId`), and the kernel then applies it once per
identity and records the repeat in the log. Transitions without a key are expected to be
naturally idempotent, which most lifecycle transitions are for free.

The shape that is never safe is an assignment that reads the field it writes. The loader
warns about it, because the alternative — deriving the value — is almost always available and
always better.

### Loops

Cascades can cycle (A raises an event, a policy commands B, B's event commands A). The
kernel enforces a per-turn budget (a command-count ceiling) and logs `CascadeAborted` with
the cycle it detected, rather than hanging the tab. A detected cycle is a *finding* to show
the modeller, not an error to swallow.

## 3. Model definition language

YAML, one file per bounded context (or a single file for small models), validated by a Zod
schema that also emits JSON Schema for editor completion. Shape, by way of example:

The full reference model is [`packages/examples/models/sales.yaml`](../packages/examples/models/sales.yaml),
which is also the kernel's test fixture, so it cannot drift from what actually runs. The
composite at the heart of it:

```yaml
aggregates:
  Order:
    creators: [Place]                     # the only commands that may create an instance
    data:
      total: { type: number, default: 0 }
      paid:  { type: number, default: 0 }
    children:
      lines: { type: OrderLine, via: command.orderId }

    initial: draft
    states:
      draft:
        on:
          Place:
            guard: command.total > 0
            assign: { total: command.total }
            target: fulfilling            # lands on fulfilling.awaiting_payment
            emit:
              - OrderPlaced: { orderId: "${id}", items: "${command.items}" }

      fulfilling:                         # composite state
        initial: awaiting_payment
        after:
          30d: { target: escalated, emit: [ FulfilmentOverdue ] }
        on:
          Cancel:                         # written once, applies from every substate
            target: cancelled
            emit: [ OrderCancelled: { reason: requested } ]
        on_done:                          # reacts to done.fulfilling
          target: completed
          emit: [ OrderCompleted: { orderId: "${id}" } ]
        states:
          awaiting_payment:
            after:
              14d: { target: cancelled, emit: [ OrderCancelled: { reason: unpaid } ] }
            on:
              Pay:
                guard: paid + command.amount >= total
                assign: { paid: paid + command.amount }
                target: fulfilling.shipping
                emit: [ OrderPaid: { orderId: "${id}" } ]
              Pay#partial:                # same command, different guard, no target
                assign: { paid: paid + command.amount }
                emit: [ PaymentReceived: { orderId: "${id}", amount: "${command.amount}" } ]
          shipping:
            on_children:                  # quantifiers over the tally, ADR 0004
              lines.first_entering(shipped): { emit: [ OrderPartiallyShipped ] }
              lines.all_final:            { target: fulfilling.delivered }
          delivered: { final: true }      # completes `fulfilling` -> done.fulfilling

      escalated: {}
      completed: { final: true }
      cancelled: { final: true }

policies:
  ship_when_ready:                        # stateful, correlated, ADR 0003
    correlate: event.orderId
    initial: waiting
    states:
      waiting:
        on:
          OrderPaid:     { target: paid_only }
          StockReserved: { target: stock_only }
      paid_only:  { on: { StockReserved: { target: ready } } }
      stock_only: { on: { OrderPaid:     { target: ready } } }
      ready:
        final: true
        on_entry: { command: "Shipment#${correlation}.Request" }
```

Design intents in that sketch, each arguable:

- **Guards are expressions, not code.** A tiny safe expression language over `state`,
  `data`, `command` and `event`. No arbitrary JS: it keeps models serialisable, diffable,
  explainable ("guard `total > 0` saw `total = 0`"), and safe to load from a file someone
  mailed you. Cost: real arithmetic/string needs will push at the ceiling.
- **State references are dotted paths from the root** — `fulfilling.shipping`, `cancelled`.
  No relative addressing, no nearest-match resolution: a target is greppable and means one
  thing. A bare name is simply a path of length one.
- **`${expr}` is the only interpolation.** `guard:` and `assign:` are bare expressions,
  because they are always expressions. Everywhere else — payloads, command targets — text is
  literal unless it holds a `${...}` hole, so `{ reason: unpaid }` is the string and
  `{ amount: "${command.amount}" }` is the number. A value that is exactly one hole keeps the
  expression's type, which is how `items: "${command.items}"` stays an array.
- **`creators:` is explicit.** A command addressed to an instance that does not exist is
  reported unless it is a declared creator, so a typo cannot conjure an aggregate into being.
- **`via:` is an expression over the child's creating command**, yielding the parent's id —
  `via: command.orderId`. Correlation is never guessed.
- **A composite earns its keep twice over** in that example: `Cancel` is written once for
  every substate, and the 30-day deadline survives the move from `awaiting_payment` to
  `shipping`. Those are the two things flat states cannot do (ADR 0005).
- **`on_done` is how a parent notices a composite finishing.** `delivered` is final, which
  completes `fulfilling`, which raises the internal `done.fulfilling` signal. That signal is
  not a domain event — `OrderCompleted` is the business fact, and it is raised by the
  transition that reacts to the signal.
- **`on_children` is a transition like any other**, so it can be scoped to a state: the child
  quantifiers only matter while the order is actually shipping, and they are inert in
  `awaiting_payment`.
- **Events are declared where they are raised**, so the set of possible events is derivable
  from the model and the wiring view can be computed statically.
- **Policies are their own top-level thing**, never a field on an aggregate. The notation
  enforces the rule that aggregates do not know each other.
- **`after:` is sugar for a timer** armed on entry to its state and cancelled on exit.
- **One statechart interpreter, two polarities.** An aggregate consumes commands and raises
  events; a policy consumes events and issues commands. Same kernel, mirrored, so there is
  one thing to learn and one thing to test.

Open: parallel regions (Q10) and history states (Q11). ADR 0005 keeps the representation
open for both without building either.

## 4. Architecture

```
packages/
  kernel/      model schema + expression evaluator + interpreter + log      (no DOM, R40)
  scenarios/   scenario schema, headless runner, assertions, coverage       (Node + browser)
  ui/          React app: board, statechart, wiring, trace, narration
  examples/    reference models + their scenarios (also the test fixtures)
```

- **kernel** is pure and synchronous. `step(state, input) -> { state, logEntries }`.
  Snapshots are structurally shared so scrubbing 10 000 entries is cheap (R39).
- **ui** holds no domain state of its own: it renders a projection of the log at index *i*.
  Time travel is `setIndex`.
- **scenarios** depends on kernel only, so the same runner backs `vitest` in CI and the
  replay button in the UI (R31).

Stack per R36: TypeScript, Vite, React, pnpm. Rendering: statecharts and the wiring graph
want automatic layout — likely ELK (`elkjs`) with hand-placed stickies on the board, since
the board's left-to-right timeline is semantic and should not be auto-arranged.

## 5. The four views

| View | Audience | Shows | Interactions |
|---|---|---|---|
| **Board** (EventStorming) | P2 business owner | Stickies on a timeline, context swimlanes | Click a command to fire it; watch the cascade animate |
| **Statechart** | P1/P3 | One aggregate type, instances lit on their current state | Click a transition to see its guard and emitted events |
| **Wiring** | P1/P3 | Aggregate types as nodes, policies as labelled edges | Hover an event to highlight every subscriber |
| **Trace** | all | Ordered log, causation chains, narration | Scrub, filter, fork a run, save as scenario |
| **Overview** (read model) | P2, and anyone reading a run | The *instances* at frame *i*, as the business draws them: a parent spanning its children, sequences left to right, every box's active state, the events under what they moved | Click a box or an event; pick a side-lane item to see only where it travels; scrub |

The **inspector** is shared across views: select anything and see its definition, its
history in this run, and why its last transition did or did not happen (R21).

## 6. Scenario format

```yaml
scenario: unpaid order cancels after fourteen days
given:
  at: 2026-01-01T09:00Z
  events:
    - Order#A1: OrderPlaced { total: 100 }
when:
  - advance: 13d
  - expect_state: { Order#A1: fulfilling.awaiting_payment }   # mid-run, dotted path
  - advance: 1d
then:
  - state:    { Order#A1: cancelled }              # exact leaf
  - in_state: { Order#A1: fulfilling }             # anywhere in the configuration (false here)
  - emitted: [ OrderCancelled { reason: unpaid } ]
  - not_emitted: [ ShipmentRequested ]
  - not_in_state: { Order#A1: fulfilling }
  - log_matches: snapshot            # golden trace, reviewable in a diff
```

`given` by events rather than by state is the default, because seeding state directly can
produce a world the model could never have reached. Seeding state is allowed but flagged.

## 7. Build order

A thin vertical slice first — kernel + one view + one scenario — then widen. Nothing below
is scheduled; it is dependency order.

1. **Kernel**: model schema, expression evaluator, interpreter, log. Unit tests.
   Aggregates and stateless policies only — but **hierarchical from the first commit**, with
   the active configuration as the central type (ADR 0005). This is the one thing that cannot
   be deferred without a rewrite.
2. **Scenario runner** headless, with the order/payment example green in CI.
2b. **Stateful policies** (ADR 0003) and **child tallies with quantifiers** (ADR 0004) —
   both are kernel work, both need to land before any view is worth building, because they
   are what the views have to draw.
3. **Trace view + statechart view**: load a model, fire a command, see states and the log.
   This is the first thing worth showing anyone.
4. **Clock controls, stepping, time travel.**
5. **Board view** and narration — the P2 features; by now the semantics are stable enough
   to be worth a pretty face.
6. **Wiring view, coverage, save-run-as-scenario.**
7. **Visual authoring** (R12), if the text-first workflow proves to be the bottleneck.

**Where iteration 1 landed (2026-10-09):** steps 1, 2 and 2b are done and green — the
hierarchical kernel, stateful correlated policies, child tallies with quantifiers, timers,
`done` signals, the rejection chain, the scenario runner and a narrated trace CLI. No views
yet; the trace is read in a terminal. Seven scenarios over the reference model, 29 tests.

**Where iteration 2 landed (2026-10-09):** step 3 is done and most of step 4 came with it.
`packages/ui` loads a model (bundled examples or edited YAML), replays a scenario or a
hand-fired run, and renders the statechart and the trace at any frame. What the
implementation changed about the plan:

- **The log alone is not a projection source.** It records neither `data` nor what is in
  flight, so the kernel now records an opt-in `Frame` per input (the world after it, sharing
  unchanged instances with the previous frame). Time travel is choosing a frame; the log is
  still the story the trace tells.
- **The UI's state is a list of actions**, not a world. A run is `play(model, actions,
  schedule)`, so editing the model replays the same steps against the new rules, and "fork
  from here" (R20) is truncating the list. Forking from inside a cascade continues from where
  that cascade settled — cascades are not interruptible.
- **Stepping is per input**, so a cascade can be walked one message at a time with ← / →,
  with the in-flight queue visible at every step.
- **Statecharts lay out top-down**, not left-to-right: on the four-deep claims example
  (`examples/models/claims.yaml`, built for exactly this) `RIGHT` produced a 4500×460 strip.
  ELK copes with edges from a composite into its own descendant and across three levels.

Still to do from steps 4–6: the board, the wiring view, narration as sentences rather than
log lines, save-run-as-scenario, coverage.

**The overview view (2026-10-10)** came from a domain owner's slide rather than the build
order: the statechart view explains *why*, but nobody gets the picture from it. It is a read
model of the frame, laid out mostly by inference — instances nest by parent relation,
association aggregates (those declaring references) fold into "n/m done" tallies, referenced
types go in a side lane, and an event sticky sits under the box that raised it or, when the
raiser is not drawn, under the deepest boxes it changed, found by walking causation through
the log. A model's optional `overview:` section names only what inference cannot see: roots,
sequence and band relations, labels, and which events are plumbing — or, since ADR 0023, whose events
the lane shows at all (`events.of`) and which events are asks, drawn as a marker open until answered
(`events.asks`). Sales and claims render
with no configuration at all. Converging journeys still draw in plan order: drawing the merge
needs predecessors, which is a second reason for them in slice 2.

**Since then (to 2026-10-21)**, driven by a real domain modelled with its owner: the overview lays
a sequence out by declared links (`follows:`), so a converging or branching journey draws as one;
the **flow board** draws every event's lane and every path the scenarios showed, and lays a
business drawing over it; the **structure** view is the model as an ERD with frames and packages;
and the **model check** (`docs/requirements.md` §7b) reports static findings, coverage, end states,
the drawings against their scenarios, tags, and proposes a scenario per drawn arrow nothing walks.
Of the list above, the board, the wiring view, sentence narration and save-run-as-scenario are still
open; coverage is built. A domain now lives in a repository of its own and uses this one through
the `statestorm` command (README, "Using statestorm in a domain repo").

**The overview, 2026-10-30.** A classified relation is drawn in the order of its classes, so a start
child added late still comes in its place. `attributes:` names any further fields a reader should see, read from a
folded child's data and an event's payload; `attributesWhileOpen:` the same, but on a folded child only
until it ends. The pill says who: the value is a caption under its row, in plain words, shared by the
samples that have the same one. The platform does not know what they mean. `exceptions:` names the types that
stand apart from the roots: a lane of their own under them, titled as the model says, only while
something is under them, and never the "also:" links. `takenOver:` names a data field holding the box that took this one over: it
is no longer drawn, and what happened in it shows there. None of this needs the kernel: it is how the
same frame is drawn.

## 8. Risks

- **Semantics creep.** Every "what about…" (parallel regions, history, retries,
  compensation) is a reasonable ask that enlarges the kernel. Three of the original asks —
  stateful policies, child quantifiers, nesting — were accepted in ADRs 0003–0005, which is
  most of the budget spent. Mitigation: the subset in §3 is the contract; additions need an
  ADR, and the next one should have to argue against a worked example that cannot be
  modelled without it.
- **Hierarchy's hidden cost is the diagram, not the interpreter.** Compound-node layout that
  stays readable while instances move is harder than the resolution algorithm. Mitigation:
  build the statechart view against a deliberately nasty three-deep example early.
- **Two audiences, one UI.** Dense enough for P3 and clean enough for P2 is a genuine
  tension. Mitigation: one model, distinct views, and a "presentation mode" that hides
  everything an engineer needs and a stakeholder doesn't.
- **The expression language.** Too small and models get contorted; too big and it is a
  programming language with no debugger. Mitigation: start small, let the examples apply
  the pressure.
- **Being a toy.** If the model cannot be carried into real code, the workshop output is
  thrown away. Mitigation: keep the XState export path (ADR 0001) honest from the start.
- **The quantifier sugar becoming a crutch.** `lines.all_final` is so much easier to write
  than the machinery it stands for that a modeller may stop noticing the asynchrony it
  hides. Mitigation: the inspector's expanded form (R46), and a trace that always shows the
  parent lagging its children by a step.
