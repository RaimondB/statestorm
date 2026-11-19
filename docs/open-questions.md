# Open questions

Things the design genuinely hangs on, that I should not decide alone. Answered questions
move into requirements.md or an ADR and are recorded here with the call that was made.

## Resolved

### Q1 — Does a policy get to have state? ✅ yes, and more than that

Stateful rules are required, **including over child collections** — "the first child reaches
X, so the parent goes to Y", "every child is final, so the parent is completed".

Two ADRs came out of it:
- **ADR 0003** — a policy is a correlated statechart, so the one-liner form becomes sugar for
  a single-state policy and there is one execution model in the kernel, not two.
- **ADR 0004** — parent/child relations are declared, the kernel derives a per-parent tally of
  children-by-state, and quantifier rules fire edge-triggered on tally changes. A parent never
  reads a child's state inside a guard: the resolution stays asynchronous so the window where
  the last line is done but the order is not yet completed is visible rather than smoothed
  away. Universal quantifiers are false over an empty collection by default.

### Q2 — Text-first or visual-first authoring? ✅ text first, then extend into visual

The board is clickable for *running* early (firing a command is what a stakeholder needs);
visual *editing* comes once the semantics have stopped moving. R12 updated.

### Q3 — Workshop mode: one screen or multi-user? ✅ later, on the roadmap

One driver on a shared screen for now. Multi-user is requirements §10, and is the one item
allowed to reopen the browser-only constraint (R35).

### Q7 — Repo home and licence ✅ GitHub, private to start, LGPL

The [GitHub repository](https://github.com/RaimondB/statestorm) started private and is now public.
The licence remains [LGPL-3.0-or-later](../LICENSE). The kernel being a reusable library is what
makes LGPL the right fit — someone can embed it without their own code being pulled in, while fixes
to the kernel itself stay in the open.

### Q9 — The name ✅ statestorm

Statecharts plus EventStorming — precisely the two halves of the tool. pnpm scope
`@statestorm/*`. Runners-up, for the record: `choreo` (choreography over orchestration, but
WSO2 ships a PaaS by that name), `past-tense` (teaches the first lesson in its own name) and
`ergo` (the causation chain, but a crowded namespace).

### Q5 — Nested states? ✅ yes, and the configuration is the central type

Nesting is required, and a child aggregate's state is independent of its parent's. **ADR
0005**: the active state is an ordered root-to-leaf *configuration*, not a label; resolution
is innermost-first with outward bubbling; entry/exit order follows the least common ancestor;
timers are scoped to the declaring state; a final substate completes its composite and raises
an internal `done.<State>` signal (a signal, not a domain event). R21's "why did nothing
happen" becomes a rejection *chain*, which is strictly better than the flat answer.

Two knock-ons worth remembering: `all_final` in ADR 0004 now means **root-level** final, and
the configuration is stored as a *set* of paths from day one so that Q10 stays cheap.

### Q12 — Should a quantifier be evaluated on state entry? ✅ yes — and the vocabulary split

Resolved by **ADR 0006 §4**, and the deciding argument was not the empty collection but
arbitrary delivery order. `all_final` is a *condition* — convergent under reordering and
redelivery — so it is evaluated on entry to its state as well as on tally changes, fires once
per occupancy and re-arms on re-entry. `first_entering` is a *moment*, which can legitimately
pass unobserved; driving a state change from one is now a lint.

That also fixes a bug the empty-collection framing had hidden: a parent whose children all
finished before it entered the state that watches them was stranded forever. And
`allow_empty` finally does something — before, it could only suppress a firing, never enable
one.

## Still open

### Q4 — How far does the expression language go?

`total > 0` is clearly in. Is `items.filter(...)`? Dates and durations? String matching?
Each addition makes models expressive and explanations harder.

*Leaning:* numbers, booleans, strings, comparison, `and/or/not`, durations, and field access
on the command/event payload. **One exception now confirmed:** `for_each` fan-out over an
event payload collection, to create children (R47). Otherwise scalar until an example model
genuinely cannot be written without more.

### Q6 — Is a read model / projection in v1 or v2?

R10 says v2. Cheap to add given a log, and "what does the customer actually see" is a strong
workshop moment.

### Q8 — Does the model need versioning / migration?

If a workshop's scenarios are its output and the model then changes, scenarios break.

*Leaning:* breakage is correct and informative. Recorded so we don't accidentally build
migration machinery.

### Q10 — Parallel / orthogonal regions

"Shipping *and* invoicing at once." ADR 0005's set-of-paths representation already holds it;
the resolution rules, fork/join and per-region finality do not. Deliberately deferred.

*Leaning:* wait for a worked example that genuinely cannot be modelled with a composite plus
a child collection — ADR 0004 absorbs a lot of what looks like concurrency, since much of it
is really the state of children. If one turns up, it gets its own ADR and it is additive.

### Q11 — History states

`shallow` / `deep` re-entry into whatever substate was last active. Cheap once configurations
exist, so there is no reason to design for it now; noted so it is not accidentally precluded.

### Q13 — `given:` by events, not by commands

Design §6 says a scenario should seed by *events*, since seeding state directly can produce a
world the model could never have reached. Iteration 1 only implements `given.send`, which
seeds by replaying commands — honest and reachable-by-construction, but slower to write and
it drags the policies along with it. Injecting events directly needs a way to attach them to
an instance that does not exist yet.

### Q14 — Do we model optimistic-concurrency conflicts?

ADR 0006 §6 serialises commands per instance, which is what the consistency boundary buys.
Not modelled: two concurrent writers against the same instance where one is rejected on a
stale version. Real, and visible to users of any such system.

*Leaning:* leave it out until a model needs it. Per-instance serialisation already captures
the important lesson (the aggregate is the unit), and version conflicts are an
infrastructure-shaped concern rather than a domain-design one.

### Q15 — In-flight messages across a clock advance

The clock still only moves at quiescence, so "the message that arrived three days late" is
not expressible. Needed for a genuinely adversarial schedule; deliberately out of the
minimum (ADR 0006 §2).

### Q16 — Should a command declare its payload?

The fire panel offers a form and a grid of child items rather than a YAML box, but the model
cannot say what a command carries, so the UI infers it (`packages/ui/src/payload.ts`): a field
is whatever the chart reads as `command.<x>` (plus a child's `via:`), typed by where it lands,
and a field is a *list of child items* when an event carries it whole into a policy's
`for_each` — that policy's command naming what a row becomes and which columns it has.

It works on both examples, but it follows one hop only, and a field nobody reads yet (the
modeller is still writing the rule) does not appear at all. A declared shape —
`commands: { Place: { total: number, items: [ { sku: string, qty: number } ] } }` — would also
let the kernel reject a malformed command loudly instead of letting a guard trip over a
missing field.

*Leaning:* keep inferring until a model needs a shape inference gets wrong; then add an
*optional* declaration that wins over inference, so existing models keep working. Data stays
flat scalars either way: a list lives in a payload and becomes children, never a field.
