# ADR 0037 — A part declared before it is modelled: `packages: []`

- **Status:** proposed, 2026-11-25
- **Decides:** how a model declares a sub-system of its own whose logic it does not model yet, and how the
  views show it
- **Revises:** ADR 0018 §1 (a sub-system lists packages)
- **Forced by:** a system is in several parts, and only one of them runs anything the model specifies. The
  others search, compute or keep something the model does not reach yet. The team wants the system drawn
  whole, with every part named, before each part's logic is modelled. ADR 0018 refuses a sub-system of our
  own without packages, so the model either leaves those parts out or invents a package for them.

## Context

The loader refuses `Results: { note: … }` in `lab` with "a sub-system lists its `packages`". That
refusal catches a part someone forgot to fill. It also blocks a part that is known, named and owned, and
simply not modelled yet. An external system can already have parts with no packages, because what it
sends and receives says what it does. A part of our own has nothing else to say it with.

## Decision

1. **`packages: []`, written on purpose, declares a part before it is modelled.** It works on a sub-system
   and on a system of one part. Leaving `packages` out is still refused, and the message now names the
   way to say it: "a sub-system lists its `packages` — `packages: []` for one declared before it is
   modelled".
2. **It changes nothing at run time** (ADR 0018 §7). No type runs there, no policy can run there (`in:`
   already refuses a part that runs none of the model's packages), and no edge reaches it.
3. **The views say so.** The context map and the C4 view (ADR 0036) draw it dotted, with *not modelled
   yet* under its name; so is a system whose every part is declared this way. The Mermaid exports add
   "(not modelled yet)". A focus on its system shows it in the container diagram, with no edge.

## Consequences

- A team can draw its system as it is built, and fill each part in a later round, without a placeholder
  package.
- Rejected: a separate `planned:` list on a system. It would be a second way to name a sub-system, with
  its own rules for contexts and notes. `packages: []` keeps one declaration and one place to fill in
  later.
