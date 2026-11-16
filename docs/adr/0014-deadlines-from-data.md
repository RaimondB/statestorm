# ADR 0014 — Deadlines read from the instance's data

- **Status:** proposed, 2026-10-19
- **Decides:** how a deadline (`after:`) can be different per instance
- **Builds on:** ADR 0005 §5 (a deadline belongs to the state that declares it)
- **Forced by:** a domain's owner: each thing waiting has a configured time it may wait, which
  differs per instance, and the aggregate holding it is responsible for monitoring the expiry

## Context

`after: { 14d: … }` is a literal: every instance of the type gets the same deadline. A sample's
stability is not a property of the type but of the test — one sample must be analysed within
four hours, another within three days — and a reminder before it likewise. The handling cannot
read the test's catalogue entry (another aggregate) when its clock starts; the plan copies the
stability onto it, as it copies a courier contract's `maxAttempts` onto a transfer.

## Decision

1. **`after:` takes either a duration or the name of a data field.** `after: { stability: { … } }`
   reads the instance's `stability` field — a duration such as `4h` — at the moment the state
   is entered. A key that parses as a duration (`90s`, `15m`, `6h`, `14d`) is a literal, as before.
2. **Checked at load:** the field must be a declared `string` field of the type (inherited ones
   count). A misspelt name is refused rather than taken for a duration it is not.
3. **Loud at run time:** a field that does not hold a duration when the state is entered arms
   nothing and is an `error` finding naming the field and its value. A missing stability must
   not quietly mean "never".
4. Everything else is as before: the deadline belongs to the declaring state, leaving the state
   cancels it, re-entering re-arms it (from its full length), and the clock moves only at
   quiescence (Q15).

## Consequences

- An analysis's handling arms the expiry per sample when its run is *expected* (the `lab` example).
- A deadline cannot be paused: a step that leaves its state (held by a pending deviation) and
  comes back starts the full length again. The domain records that as a limitation.
- Rejected: an expression as the key (`"${stabilityDays * 24}h"`) — arithmetic in a key is hard to
  read and to check; the plan can carry the duration it means. Also rejected: reading the
  test's catalogue at the moment the clock starts — a command, or an aggregate reading
  another, which ADR 0003 forbids.
