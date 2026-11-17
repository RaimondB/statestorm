---
name: scenario-loop
description: Write, run and prove statestorm scenarios — one behaviour each, mid-run assertions, every delivery schedule, trace reading, mutation checks — and treat a failing scenario as a finding before treating it as a typo. Use whenever a model rule changes or a gap must be closed.
---

# The scenario loop

A scenario is the proof that the model does what the domain doc says. Passing is not proof: the
loop is write → run under every schedule → read the trace → break the rule → it must fail.

## Writing one

- **One behaviour, named in the business's words** (`NN-payment-refused-then-retried.yaml`,
  `scenario: the payment is refused, retried the next day, and the order ships`).
- **One clean goal per scenario.** Several exceptions — several items each with its own trouble —
  are several scenarios, lettered under one number (`NNa-…`, `NNb-…`), each one story; a reader
  validating the model should see what one scenario is about at a glance, and a failure should say
  which behaviour broke.
- **One drawing per scenario.** Where the model has business drawings, a scenario names the one it
  walks — `drawing: <file stem>`, under `scenario:` — the drawing that should draw every arrow it
  shows. The check (MC-14) lists, per drawing, the arrows its scenarios walk that it does not
  draw: either the scenario skips or reorders a scan the drawing shows (scan as drawn), or the
  drawing lacks the arrow (raise it as a drawing issue). A path drawn on many drawings (a referral, say)
  names its own scenarios under `paths:` instead.
- **Tags.** `tags: [happy | deviation, topic…]` under `drawing:` — exactly one kind, and the topics
  it is about (reuse the existing ones; the check prints them). Every drawing needs a happy path
  among its scenarios: the main flow, once, without trouble. A scenario that proves an item of a
  list kept elsewhere — a test plan's `WOM-12` — carries its id as a tag too: a reference, which
  the workbench groups by prefix.
- **`why:`** under `tags:` lists the rules it shows (`why: [R12, R14]`), so the check can say
  which agreed rule no scenario shows (ADR 0016). A **header comment** says what it shows, in
  words.
- `given:` plans — master data most scenarios share (places, parties, their settings) once, in a
  set-up below `scenarios/` that each includes (`given: include: [given/places.yaml]`, ADR 0029);
  `when:` steps in `phase:`s; assert **mid-run, at the moment that matters**
  (`expect_state`, `expect_in_state`, `data`), not only at the end — "paid, not yet
  shipped" is a step of its own.
- Assert on what the business cares about (states, what other systems are told, what the customer hears) and on
  idempotent outcomes. Counts of internal messages change under the duplicate schedule; counts of
  facts per unit do not.
- With deadlines, write the clock arithmetic in comments (`advance: 5d  # nine days after it was
  ready`) and check it — a timeline mistake looks exactly like a model bug.
- Ids that read: orders, items and places named so the trace can be followed.

## Running it

```bash
# `statestorm` is the platform's command: in a domain repo `pnpm exec statestorm` (or its pnpm
# scripts), in the statestorm repo `node packages/cli/src/statestorm.ts`. `.` is the domain folder.
statestorm test . --schedules                                   # every scenario: fifo, duplicate, random(1..5)
statestorm test model.yaml scenarios/<file>.yaml --schedules    # one scenario
statestorm test model.yaml scenarios/<file>.yaml --trace        # read the run
```

- **Passed first time?** Read the trace for the steps that matter (grep the events). Then break
  the rule it is meant to prove.
- **Failing?** Ask first whether the *model* is wrong. A scenario that "should" pass and does not
  has found real inconsistencies before (two views of the same outcome disagreeing). Raise it as
  a question if the right answer is not already a decision.
- Only one schedule failing points at ordering or redelivery: an accumulating assign, a missing
  idempotency key, a rule that assumes order.

## Mutation check

For each new rule: change it (drop the guard, change the target, remove the emit), rerun, and a
scenario must fail. A mutation that changes nothing proves nothing — renaming a rule variant, for
instance, leaves the rule active. Keep a list of what was checked in the commit message.

## Closing

- The full suite (`pnpm test`) passes; the model check (skill `model-check`) shows the gap closed.
- A behaviour deliberately left without a scenario is a stated decision
  (`coverage: { ignore: { <rule or Type.state>: why } }`), not an omission.
