# ADR 0008 — Inheritance as refinement: `abstract`, `extends`, and a fixed skeleton

- **Status:** proposed, 2026-10-10
- **Decides:** how one aggregate type specialises another, and what a specialisation may and
  may not change
- **Forced by:** a domain modelled line by line with its owner, where several kinds of step share
  one lifecycle and each adds statuses of its own

## Context

The domain owner described an abstract **Step** with a common lifecycle, specialised by
the route, a site visit and a transfer (itself specialised into a courier run, a tube run and
a return), each adding "their own statuses and specialised tasks". Tasks
follow the same pattern. Every one of them rolls up the same way: in progress at the first
child, completed at the last.

Without inheritance, slice 1 wrote that roll-up out on every type — four copies for two
step types and two task types. Slice 1b has four steps and four tasks. The copies
would drift, and the roll-up is exactly the thing that must not: a parent counting children
of mixed types needs every one of them to mean the same thing by `in_progress`.

## Decision

1. **`abstract: true`** marks a skeleton. An abstract type has no instances; a command to one
   is an error naming the rule, not a creation.
2. **`extends: <abstract type>`** merges the ancestor's definition into the subclass before the
   machine is built. Chains are allowed (`CourierRun → Transfer → Step`); cycles
   are a load error. **Only abstract types can be extended** — extending a concrete type would
   make its own instances ambiguous in any roll-up that counts it.
3. **Refinement, not replacement.** A subclass may
   - add **substates beneath an inherited leaf** (decomposing it),
   - add **rules** to inherited states, and **override** a rule by declaring the same key,
   - add **data, children and references** (a field it redeclares must keep its type).

   Wherever the ancestor declares a set of states, **that set is fixed**: nothing can be
   added beside them, removed, renamed, made final or non-final, or given a different
   initial state. A final state cannot be refined. Each of these is a load error naming the
   state and the rule.
4. **Provenance is kept.** An inherited rule carries `inheritedFrom`; the inspector says
   "inherited from Step — every subclass has it".
5. Policies do not inherit. A policy is identified by its correlation and is small; there is
   nothing yet to share.

## Why refinement and not free extension

The domain owner's words were "each subclass can add their own statuses". Free extension —
a site visit adding a top-level `Stored` beside `in_progress` — would let a parent's
`steps.any(in_progress)` silently miss a site visit that is storing. Refinement puts `storing`
*inside* `in_progress`, where the kernel already counts it: being in `in_progress.storing`
*is* being in `in_progress`. So the subclass gets its own statuses, and the parent's roll-up
stays true without knowing the subclass exists. This is the classic statechart answer to
specialisation; the only rule added here is that the skeleton is fixed where it is declared.

## Consequences

- The domain's model writes the roll-up **once** on `Step` and once on `Task`. A mutation
  check removes the one inherited `tasks.all_final` rule and every concrete step in three
  scenarios stays in progress — the rule is genuinely shared, not copied.
- The merge is raw (before machines are built), so every downstream piece — resolution, the
  statechart view, payload inference — sees an ordinary machine. The cost is that transition
  ids name the subclass (`SiteVisit.in_progress on_children …`), with `inheritedFrom` saying
  where the rule was written.
- Overriding is by exact key. Overriding `Expect` to assign one more field (as the transfer
  handlings do) means restating the inherited assignments; there is no `super`. Fine at this
  size; worth revisiting if overrides start to repeat themselves.
- Abstract types appear in the statechart view (dashed, italic) — the skeleton is worth
  looking at — but not in the fire panel, since nothing can be sent to them.
