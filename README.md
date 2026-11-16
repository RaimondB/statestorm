# statestorm

*Statecharts you can storm with.*

An interactive workbench for designing, explaining and validating **domain models built
from aggregates that raise events**.

You draw (or write) a handful of aggregates. Each one has a lifecycle — a statechart.
Aggregates accept commands and raise domain events. Policies listen to those events and
issue commands to other aggregates. Then you *run* it: fire a command, advance the clock,
and watch the cascade light up across the board.

Two audiences, one model:

- **Engineers** get an executable model: deterministic runs, scenario files that assert
  behaviour, a trace of exactly who caused whom.
- **Business owners** get a board they recognise (EventStorming stickies) and a narrated
  timeline in plain language — "because the invoice stayed unpaid for 14 days, the order
  cancelled itself" — so a design can be validated *before* it is built.

**Status: in use.** The kernel runs, scenarios assert under every delivery schedule, and the
workbench shows a run as the business draws it — an **overview** of the journey, a **flow board**
of every path the scenarios showed, the **structure** (ERD), the statecharts, a narrated trace and a
timeline to step through. A **model check** finds the gaps: rules and states no scenario reaches,
drawn arrows no scenario walks, and a proposed scenario for each. Real domains live in repos of
their own and use this one as a dependency.

## Setup

You need **Node 22.18 or newer** (24 recommended — `node --version`), **pnpm 9** (comes with Node:
`corepack enable`, then `pnpm --version`), and git. The repo is private for now: you need read access to
[RaimondB/statestorm](https://github.com/RaimondB/statestorm).

```bash
git clone git@github.com:RaimondB/statestorm.git
cd statestorm
pnpm install          # also builds the site and the `statestorm` command (dist/)
pnpm dev              # the workbench at http://localhost:5180/ — the bundled examples, Open folder…
pnpm verify           # tests, typecheck and the model check of every example (~10s)
```

```bash
pnpm test             # unit tests + every scenario of every example under every schedule
pnpm typecheck
pnpm check <model.yaml> <scenarios dir> [<drawings dir>]   # the model check; --all, --coverage, --scenarios, --issues, --propose
pnpm check-all        # ...for every bundled example
pnpm example          # run the reference model's scenarios in a terminal
pnpm trace            # ...and print the narrated trace of each run
pnpm chaos            # ...under reordering and redelivery, not just the tidy order
pnpm build            # the site, static, in packages/ui/dist — no server needed
pnpm package          # the site plus the bundled `statestorm` command in dist/ (what a domain repo installs)
docker compose up -d --build   # the site behind nginx, on the LAN at :8097
```

### Checking the UI in a browser

`pnpm ui-check` drives the running site with Playwright (a dev dependency): every scenario of
every example at phone width, no overlapping boxes, nothing moving while you step. Once per machine,
fetch its browser:

```bash
pnpm ui-check:install              # Chromium for Playwright, into ~/.cache/ms-playwright
```

On a bare Linux machine Chromium may still miss system libraries; `sudo pnpm exec playwright
install-deps chromium` adds them. Then, with the site running:

```bash
docker compose up -d --build       # the site the checks visit by default (http://localhost:8097/)
pnpm ui-check                      # only what changed since the last pass; UI_CHECK_ALL=1 for everything
BASE=http://localhost:5180/ pnpm ui-check   # against `pnpm dev` instead
```

`PLAYWRIGHT=/path/to/playwright/index.mjs` uses another Playwright install than the repo's.

## Using statestorm in a domain repo

A domain lives in a repository of its own, whose root is a **domain folder**: `model.yaml`,
`scenarios/`, `drawings/` (with `issues.yaml`), and its decisions in `docs/` (below). It installs this
repo as a **git dependency** — no registry needed: installing runs `prepare`, which builds the
workbench and bundles the `statestorm` command. Follow a branch, or pin a tag:

```json
{
  "private": true,
  "type": "module",
  "scripts": {
    "test": "statestorm test . --schedules",
    "check": "statestorm check .",
    "drawing-issues": "statestorm check . --issues",
    "docs": "statestorm docs .",
    "rules": "statestorm rules .",
    "postinstall": "statestorm skills .",
    "dev": "statestorm dev . --name=<domain>",
    "build": "statestorm build . --out=site --name=<domain>"
  },
  "devDependencies": {
    "statestorm": "git+ssh://git@github.com/RaimondB/statestorm.git#master"
  }
}
```

`#master` follows the platform (the lockfile holds the commit in use; `pnpm update statestorm`
takes the latest); a tag pins a release. Installing needs read access to this repo: over SSH as
above, with a key on your GitHub account, or over HTTPS —
`git+https://github.com/RaimondB/statestorm.git#master` — with a credential git can use
(`gh auth setup-git` sets one up).

```
statestorm test  <domain folder> [--schedules] [--trace[=name]]
statestorm check <domain folder> [--all] [--coverage] [--scenarios] [--issues] [--docs] [--propose] [--budget=<s>]
statestorm docs  <domain folder>                                   the rulebook, generated from docs/
statestorm rules <domain folder> [<id>] [--topic=<t>] [--open] [--json]   the docs asked, not read
statestorm skills <domain folder> [--check] [--force]             the platform's skills and shared rules, copied in
statestorm dev   <domain folder>... [--port=5181] [--name=<name>]   the workbench, re-reading the files on every load
statestorm build <domain folder>... --out=<dir> [--name=<name>] [--without=<views>]   a static site
statestorm share <domain folder>... [--out=<dir/ or file.html>] [--name=<name>] [--examples] [--without=<views>] [--agenda=<name>]
                                                                   one HTML file with the domain inside
```

Any statestorm site also opens a domain folder straight from disk — **Open folder…** in its
header — read in the browser, nothing uploaded.

### The domain's decisions: `docs/`

A domain's rules, glossary and open questions are data ([ADR 0016](docs/adr/0016-domain-docs-and-traceability.md)),
in formats every domain shares ([`schemas/`](schemas/)); the neutral `lab` example has all of them,
in [packages/examples/docs/lab/](packages/examples/docs/lab/).

```
docs/
  profile.yaml            what this domain adds: its own fields, outside lists it cites (TP-12), topic order
  glossary.yaml           the ubiquitous language — each term, and what in the model it names
  rules/<topic>.yaml      the rules as they hold today, one file per topic
  questions.yaml          what is asked of the domain owner, each with its leaning
  decisions/NN-<date>-<what>.md   the log of each session, as it happened
  rulebook/  .schemas/    generated by `statestorm docs` — committed, never edited
```

The model and the scenarios say which rules they implement and show — `why: [R10]` on a type, a
state, a rule, a policy or a package, and at the top of a scenario. `statestorm check` traces both
ways: an id nothing defines, a citation of a superseded rule, an agreed rule no model element or no
scenario cites, a rule still only named in a comment, and a stale rulebook. `check --docs` does
only that — no runs — in about a second, for a hook after every edit. Point each YAML file at its
schema for the editor: `# yaml-language-server: $schema=../.schemas/rules.schema.json`.

`statestorm rules .` asks the docs instead of reading them: every rule on a line, one id with
everything that cites it (`rules . R10`), a topic with what the model derives for it
(`--topic=analysis`), what waits on the domain owner (`--open`); `--json` for a tool. It is what
an agent reads before a session, rather than the whole of `docs/`.

**Hooks**, in [`templates/`](templates/) — copy them into the domain repo:

| Template | Goes to | What it does |
|---|---|---|
| `github/hooks/check-docs.mjs` | `.github/hooks/` | after an agent edits the model, a scenario or the docs: regenerates the rulebook, runs `check --docs`, and tells the agent what is wrong |
| `claude/settings.json` | `.claude/settings.json` (merge its `hooks` into one you have) | runs it for Claude Code, after every Edit and Write |
| `github/hooks/statestorm.json` | `.github/hooks/` | runs it for GitHub Copilot (CLI and cloud agent), after every tool |
| `git/pre-commit` | `.githooks/pre-commit`, then `git config core.hooksPath .githooks` once per clone | no commit while the docs do not check — for every agent and person, whatever their editor |

```bash
mkdir -p .github/hooks .githooks
cp node_modules/statestorm/templates/github/hooks/* .github/hooks/
cp node_modules/statestorm/templates/git/pre-commit .githooks/ && git config core.hooksPath .githooks
cp -n node_modules/statestorm/templates/claude/settings.json .claude/settings.json   # or merge by hand
```

Copilot CLI also reads `.claude/settings.json`, so it may run the hook twice — harmless, it changes
nothing the second time. VS Code's Copilot agent mode is not covered by these; the pre-commit hook is.

### The skills and the shared rules: `statestorm skills`

The platform's skills (`.claude/skills/`, which Claude Code and Copilot both load) and the shared
"how we work on a model" rules of `AGENTS.md` are the platform's, and change with it
([ADR 0017](docs/adr/0017-shared-skills-in-domain-repos.md)). `statestorm skills .` copies them into
the domain repo as committed files — every agent sees them, a cloud agent before anything is
installed — and the `postinstall` above runs it on every `pnpm install` and `pnpm update
statestorm`, so they arrive in the same diff as the lockfile.

- **Don't edit a copy**: a copy changed in the domain repo is said, not overwritten (`--force` takes
  the platform's). What the domain adds to a skill goes in `DOMAIN.md` beside it; the copy then says
  to read it. A skill the platform does not have is the domain's own and is never touched.
- **The shared rules** go between `<!-- statestorm:rules -->` and `<!-- /statestorm:rules -->` in the
  domain's `AGENTS.md`; the rest of that file is the domain's.
- `--check` writes nothing and fails while anything is behind; the pre-commit hook warns with it.

### Sharing a model with stakeholders

`statestorm share .` writes the whole workbench and the domain into **one HTML file** (about 3 MB),
named by when it was made: `<name>-<yyyymmddhhmm>.html`. Mail it, put it on a share or in a Teams
channel: the reader double-clicks it and it opens in their browser — no install, no server, no
network, nothing sent anywhere. They see every view, run every scenario, fire commands and step
through time; what they change stays in their browser. The bundled examples are left out unless
`--examples`. A new file is a new snapshot: share again after the model changes.

- **Leaving a view out:** `--without=context-map,sequence` shares the domain without those views —
  no tab for them, and nothing opens on them, so a view still taking shape is not shown before it is
  ready. The views are `overview`, `journey`, `flow`, `structure`, `statecharts`, `context-map`, `sequence`, `docs`;
  `build` takes the flag too, and the workbench on the folder itself (`dev`) always shows them all.
  Put it in the domain repo's `share` script, so every share leaves the same views out.
- **A meeting's scenarios — agendas** (ADR 0025): `agendas/<name>.yaml` in the domain names the
  scenarios a meeting walks, under its topics, in order (`items: [{ title, scenarios: [50a, 21], note,
  questions }]`, with an optional `scope:` of tags and `view:`). The workbench lists them beside the
  tags; choosing one groups the picker by its items and shows an agenda bar to step through them (the
  link carries `agenda=` and `step=`). `statestorm share . --agenda=<name>` shares only its scenarios,
  opening on the first. The check fails on a scenario or an id that is not there, and warns on a
  scenario outside the agenda's `scope:`.
- **Who works what — roles** (ADR 0027): `roles:` in the model name a part of the landscape by what is
  worked in it and the commands it sends (`Testing: { works: [Analysis], sends: [...] }` in the `lab`
  example); an external sub-system `plays: [Testing]` instead of listing the sends itself, so another part can
  play it later. The overview marks an event drawn under a box of another role as *from elsewhere*
  (outlined, `↗ <role>`, a switch for only those); the check's **Roles** section lists every event that
  moved what another role works, with its scenarios.
- **The docs travel with it:** the domain's `docs/` sources — rules, glossary, questions, profile, the
  sessions' logs (not the generated rulebook) — go into the share, served site and *Open folder…* alike,
  for the **Docs** view (ADR 0016 §9): every topic and its rules, each rule linked to what cites it — a
  type or package opens the structure on it, a state or rule its statechart, a scenario runs. Back the
  other way, in the inspector (fold it away to save room): a type or package clicked in the structure,
  an instance, a state or a rule shows what the docs say of it — its words, package, topics and rules;
  so does a message or a lifeline in the sequence (its event, policy and command; a system, sub-system
  or domain), and a node or an edge of the context map (a part of the landscape; what crosses).
- **A link to a view:** the workbench keeps the model, the scenario and the view in its address — for
  the sequence also which lifelines are open and which folds unfolded (`#model=…&scenario=…&view=sequence&open=…`,
  ADR 0022); the Docs view's page and rule (`view=docs&doc=topic:orders&at=R3`) and the structure's focus (`focus=Order`) too. The sequence's *copy link* copies it; in a shared file, the part from `#` on takes the
  reader to the same view in their copy.

- **Where it goes:** by default into the domain folder's **`exports/`** — git-ignore it (`exports/` in
  `.gitignore`; sharing warns while it is not): the files are made from the repo, not part of it.
  Your own folder instead: `STATESTORM_SHARE_DIR`, or `shareDir` in `~/.config/statestorm/config.json`
  — kept out of any repo. For one share: `--out=<folder>/`, or `--out=<file.html>` for the name itself.

  ```json
  { "shareDir": "~/shares/statestorm" }
  ```
- **Where it comes from:** the file carries the domain's commit and branch and the platform's commit
  (`<meta name="statestorm:source">`, `statestorm:platform`, `statestorm:shared`, and the same in
  its data), so a stakeholder's copy traces back to git.
- **What it does not hold:** sharing warns — and the file says — when shared files (the model, the
  scenarios, the drawings) are not committed, when the commit is not pushed, or when the folder is
  not in git at all. It shares anyway: a snapshot of work in progress can be what is wanted.

## Working with an AI agent

The instructions for agents are in [AGENTS.md](AGENTS.md): Claude Code reads them through
[CLAUDE.md](CLAUDE.md), GitHub Copilot reads `AGENTS.md` (and
[.github/copilot-instructions.md](.github/copilot-instructions.md) where it does not, such as code
review). The working method is a set of skills in `.claude/skills/` — domain-session,
model-authoring, scenario-loop, capture-drawing, model-check, platform-change — which both Claude Code and Copilot
(agent mode, CLI, cloud agent) load.

## Find your way

**Picking this up fresh?** [BACKLOG.md](BACKLOG.md) is what is being worked on and what is next. Then
[docs/requirements.md](docs/requirements.md) and [docs/design.md](docs/design.md); the decisions are
in [docs/adr/](docs/adr/) and what is still undecided is in [docs/open-questions.md](docs/open-questions.md).

| | |
|---|---|
| `packages/kernel` | model loading, the expression language, the hierarchical interpreter, the log |
| `packages/scenarios` | scenario schema, headless runner, assertions, trace narration |
| `packages/ui` | the workbench (Vite + React + ELK): overview, flow board, structure, statecharts, trace, timeline; and the model check (`src/check/`) |
| `packages/cli` | the `statestorm` command a domain repo runs — test, check, dev, build — bundled into `dist/` |
| `packages/examples` | the neutral example models (`sales`, `claims`, `lab`), their scenarios and drawings — also the test fixtures |

No build step for the kernel: Node runs the TypeScript directly, and its only runtime dependency
is a YAML parser. The workbench is a static Vite build.

## What a run looks like

```
  1 0m  ▸ Order#A1 ← Place{total: 100, items: ["widget","gizmo"]}
  3 0m  ●   Order#A1: draft → fulfilling.awaiting_payment
  4 0m  ◆     Order#A1 raised OrderPlaced{orderId: "A1", items: ["widget","gizmo"]}
  9 0m  ▸         OrderLine#A1-widget ← Create{orderId: "A1", sku: "widget"}
 18 0m  ◆             Warehouse#main raised StockReserved{orderId: "A1"}
 20 0m  ◇               ship_when_ready#A1 on StockReserved: waiting → stock_only
 21 0m  ▸ Order#A1 ← Pay{amount: 100}
 24 0m  ◇       ship_when_ready#A1 on OrderPaid: stock_only → ready
 25 0m  ▸         Shipment#A1 ← Request
 32 0m  ∑     Order#A1 children lines: lines.first_entering(shipped) (0/2 final → 1/2 final)
 38 0m  ∑     Order#A1 children lines: lines.all_final (1/2 final → 2/2 final)
 39 0m  ●       Order#A1: fulfilling.shipping → fulfilling.delivered
 40 0m  ✓         Order#A1 completed fulfilling (done.fulfilling)
 41 0m  ●           Order#A1: fulfilling.delivered → completed
```

Indentation is causation: how far a step is from the thing a person did. And when a command
changes nothing, the run says why, with the values the guard actually saw —

```
  3 0m  ✗ Order#D1 refused Place: draft wanted `command.total > 0` with command.total=0
```

## Delivery is at-least-once

The infrastructure under these models duplicates messages and reorders them, so `fifo` is
only the first pass — the readable story a workshop needs. `pnpm chaos` runs every scenario
again under reordering and redelivery, and the loader warns about the shapes that cannot
survive it: an assignment that reads the field it writes, or a state change driven by a
moment that might never be observed. See [ADR 0006](docs/adr/0006-at-least-once-delivery.md).

---

Licensed under the GNU Lesser General Public License v3.0 or later — see [LICENSE](LICENSE)
(which incorporates [LICENSE.GPL-3.0](LICENSE.GPL-3.0) by reference).
