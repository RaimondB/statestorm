# ADR 0026 — Walking lists in order: `for_each` with `order`, `where` and `pairs`

- **Status:** proposed, 2026-11-16
- **Decides:** how a policy or a rule walks a list in an order the model names, keeps only some of its
  items, and acts on two items in a row — without giving the expression language lists
- **Forced by:** a domain whose plan arrives as a path of rows, nodes and the edges between them: which
  step follows which is the order of the path's rows; a node may be in it twice; some places on it are
  no steps. Its links could only be read from ids the payload carried, or worked out with a lookup the
  expressions do not have.

## Context

Expressions are deliberately small (design §2, Q4): no collections, so a model is data, not code.
`for_each` (ADR 0003, ADR 0012) is where lists are walked — one command per item, in the list's own
order. A list held as rows (ADR 0015) keeps the order its rows arrived in, which under unordered delivery
is no order at all. So "the step before this one" could not be said.

A general graph type (nodes, edges, predecessors) was weighed and left for later: every case at hand is
a line — a route, a planned path — and a line is a list in order.

## Decision

1. **`for_each` takes one list or several**: `for_each: [event.nodes, event.edges]` walks their items as
   one list.
2. **`order: <field>`** walks the items by that field, a number, smallest first (equal numbers keep the
   lists' order). An item without the number is a finding (error) and nothing is walked.
3. **`where: <expression>`** keeps the items it holds for; `item` is the item asked about.
4. **`pairs: true`** issues one command per two items in a row of what is kept: `previous` and `item`
   (and `index`, from 0). One item, or none, is no pair.
5. The same keys work on a policy, on a rule with `for_each`, and on a `send` with `for_each`. Without
   `for_each` they are a load error. The sequence diagram names the walk: *for each two in a row of
   nodes and edges, by place*.

## Consequences

- The expression language stays without lists; the walk is in `for_each`, where lists were already.
- A model says *what the order is* (a field it keeps) rather than computing neighbours.
- A graph type — branches and merges in one value — can come later beside it, if a case needs one.
