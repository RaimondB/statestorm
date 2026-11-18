# Backlog

What is being worked on, what is next, and what is known not to work — for everyone working on the
platform, person or agent. A domain's own work is in that domain's repo, not here.

## How to use it

- **Pick an item, claim it, then start.** Set its `status:` to `claimed — <who>, <branch>, <date>`
  and push that one-line change to `master` (or open a draft pull request with it) before you write any
  code. That is how a second person or agent sees it is taken. One item per branch, named
  `b<id>-<what>` (e.g. `b4-cached-guards`).
- **Done is deleted.** The pull request that finishes an item removes it from this file; its
  description and the commits say what was built. Nothing here is kept for history — git keeps it.
- **Found something?** Add an item at the end of its section with the next free id (ids are never
  reused). Say what it is, why it matters, and how you would know it is done. Write it in the examples'
  words (`lab`, `sales`, `claims`), never a domain's — the neutrality check reads this file too.
- **Not everything goes here.** A decision about the kernel is an ADR (`docs/adr/`, needed for every
  new kernel feature — AGENTS.md); a design question still open, with its leaning, is in
  [docs/open-questions.md](docs/open-questions.md); the requirements are in
  [docs/requirements.md](docs/requirements.md).
- **Stale claim?** A claim with no commit on its branch for two weeks may be taken over: say so on the
  item (`status: claimed — <new>, taken over from <old>, <date>`).

Status is one of `open`, `claimed — …`, `blocked — <on what>`.

## Next

### B-1 Lay out an overview sequence by a field
- **status:** open
- **why:** a model can number its steps in outline form (`4`, `4.1`, `4.2` — a step inserted after
  step *n* takes *n.1*, so nothing is renumbered). The overview lays steps out in plan order and by
  `follows:` links only.
- **done when:** an overview option lays a sequence out by a field, segment by segment (`4.10` after
  `4.9`), equal values side by side, `follows:` still honoured where present. UI only, no kernel
  change; a test with outline numbers and a tie.

### B-2 Tones declared by the model
- **status:** open
- **why:** `toneOf` (`packages/ui/src/overview.ts`) colours a state by patterns in its name (`fail`,
  `cancel`, `skip`, `left_behind`, …). A model whose words differ draws wrong, and each new word is a
  platform change.
- **done when:** a model can declare `overview.tones` (state → tone), with an ADR; the patterns stay
  the fallback.

### B-3 UI checks a domain repo can run
- **status:** open
- **why:** `pnpm ui-check` (phone width, overlapping boxes, nothing moving while stepping) runs on
  the bundled examples only. A domain's own site is not browser-checked.
- **done when:** the scripts ship in the package and a domain repo runs them against its own site
  (`BASE=`), documented in the README.

### B-5 Run the check's scenarios in parallel
- **status:** open
- **why:** the scenario runs inside the model check are single-threaded; only the proposal search uses
  worker threads. A large domain waits on it.
- **done when:** the runs are spread over workers, with the same findings in the same order.

### B-6 A package without the git dependency
- **status:** open
- **why:** a domain installs the platform as a git dependency, which builds the site on install
  (`prepare`) and needs read access to this repo.
- **done when:** a published package (npm or GitHub Packages) is the documented way to install, and a
  domain repo installs it without building.

### B-7 `where:` on `for_each_referrer`
- **status:** open — check first whether a model still needs it
- **why:** `for_each` filters with `where:` (ADR 0026); `for_each_referrer` reaches every referrer and
  leaves the filtering to each receiver's guard, so most answers are `ignored`.
- **done when:** decided by an ADR, with a scenario that cannot be written without it — or dropped.

### B-15 Structure's layout off the page's thread
- **status:** open
- **why:** ELK lays a large model's structure out in about half a second, and the page freezes while it
  does. A second opening is free (the layout is kept per model and options), but the first is not.
- **done when:** ELK runs in a worker, in the served site and in the single shared file alike; the page
  answers while a large model is laid out.

### B-16 Load a large domain without freezing
- **status:** open
- **why:** loading a domain with about 200 scenarios freezes the page for about two seconds: the model
  and every scenario are parsed at once, before anything is shown.
- **done when:** the page is usable while a large domain loads, as the Flow board already is while its
  runs are made (`runs.ts`); measured on a domain of about 200 scenarios.

## Later — on the roadmap, not yet started

- **B-8 The board view:** EventStorming stickies laid out as a board, clickable to run before it is
  editable (docs/design.md, build order step 5).
- **B-9 The wiring view:** aggregate types as nodes, policies as labelled edges, computed statically
  (docs/design.md).
- **B-10 Narration as sentences** rather than log lines ("because the invoice stayed unpaid for 14 days,
  the order cancelled itself").
- **B-11 Save a run as a scenario** from the workbench.
- **B-12 XState export** — ADR 0001's promise.
- **B-13 Workshop mode:** several people on one model at once (open-questions Q3).
- **B-14 The Docs view:** a page for the drawing issues; more of Markdown in a session's log (today
  headings, lists, quotes, code and emphasis).

## Known limitations

Not bugs to fix now, but what a model author runs into:

- Counts (ADR 0010/0011) see only top-level states; a nested refinement counts as its parent.
- `data` holds lists only as value-object lists with a key (ADR 0015); other lists live in payloads and
  become children.
- The clock moves only when nothing is in flight (Q15); `given:` replays commands rather than injecting
  events (Q13).
- A broadcast (`for_each_referrer`) reaches every referrer; most log `ignored`, folded in the trace
  (see B-7).
- Frames hold references, sound only because an instance replaces its `config` and `data` rather than
  changing them (tested).
