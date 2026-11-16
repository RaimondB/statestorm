# AGENTS.md

Guidance for coding agents working in this repository — Claude Code (through `CLAUDE.md`, which
imports this file), GitHub Copilot, and any agent that reads `AGENTS.md`. The skills it names are in
`.claude/skills/<name>/SKILL.md`, a place both Claude Code and Copilot load skills from.

Most sessions here are on **statestorm itself** (the kernel, the scenario runner, the workbench,
the model check); work on a real domain happens in that domain's own repo, with these same rules.
Nothing here is about one particular model; a model's own decisions live in its domain doc.

**Start with [BACKLOG.md](BACKLOG.md)** — what is being worked on, by whom, and what is next; claim an
item there before you start on it — and [README.md](README.md) for setup.

## What statestorm is

A workbench for designing, running and explaining domain models built from **DDD aggregates
that raise events**. Aggregates never call each other; policies react to events and send
commands. A model is a YAML file; scenarios are YAML files that run it and assert what happens;
the UI shows the same runs as an overview, a flow board, a structure (ERD) and statecharts.

## Where a model's things live

A real domain lives in **a repository of its own** — one platform repo, one repo per domain — whose
root is the domain folder; it installs this repo as a git dependency on a tag (README, "Using
statestorm in a domain repo").

| What | In a domain repo | Here, for the neutral examples |
|---|---|---|
| The model | `model.yaml` | `packages/examples/models/<model>.yaml` |
| Its scenarios | `scenarios/NN-<what-it-shows>.yaml` | `packages/examples/scenarios/<model>/` |
| The business's drawings, as data | `drawings/<drawing>.yaml` | `packages/examples/drawings/<model>/` |
| Changes to those drawings, for stakeholders | `drawings/issues.yaml` | `packages/examples/drawings/<model>/issues.yaml` |
| The domain's decisions: rules by topic, glossary, questions, session logs (ADR 0016) | `docs/` — `rulebook/` generated | `packages/examples/docs/<model>/` (lab) |
| Where the domain stands, for the next session | `HANDOFF.md` | — |
| Kernel decisions | — | `docs/adr/NNNN-*.md` |
| The platform's own work: claimed, next, known limitations | — | `BACKLOG.md` |

The neutral examples are `sales`, `claims`, and `lab` — the one that uses what a real domain needs
(inheritance, entities, packages, an overview and flow board, deviations, drawings), so the UI and
check tests need no domain.

## Commands

```bash
pnpm install                       # once: links the workspace packages
pnpm test                          # unit tests + every scenario of every model under every schedule
pnpm typecheck
node packages/scenarios/src/cli.ts <model.yaml> <scenarios dir> [--schedules] [--trace]
pnpm check <model.yaml> <scenarios dir> [<drawings dir>] [--all|--coverage|--issues|--propose]
pnpm check-all [--propose …]       # the check for every bundled example
pnpm docs-all                      # regenerate the rulebook of every example with docs (check-all fails while one is stale)
node packages/cli/src/statestorm.ts test|check|docs|rules|skills|dev|build|share <domain folder>   # the command a domain repo runs
pnpm package                       # build the site and bundle that command into dist/ (prepare does this)
pnpm verify                        # tests, typecheck, check-all with proposals, the neutrality check — must finish within 5 minutes
pnpm neutral                       # nothing of a real domain in the repo ("Keep it neutral" below)
pnpm hooks                         # once per clone: the commit hooks that run it on what you commit
pnpm dev                           # the UI on :5180
pnpm ui-check:install              # once per machine: Chromium for the UI checks (README, "Checking the UI")
pnpm ui-check                      # browser checks against the running site (:8097; BASE= for another)
```

## How we work on a model — the rules

<!-- statestorm:rules — the same in every repo: `statestorm skills .` copies it into a domain repo's AGENTS.md (ADR 0017) -->
1. **Decide with the domain owner before modelling.** Ask numbered questions, each with a
   leaning (a default); write the answers into the domain's `docs/` *first* — a rule each, the
   questions, the session's log. Never silently rewrite a decision — the newer rule says what it
   revises or supersedes. The model and scenarios cite rules with `why:`. → skill `domain-session`.
2. **Every behaviour has a scenario, every rule a mutation check.** A scenario that passes the
   first time is suspect until the trace and a broken rule say otherwise. Run under every
   schedule. → skill `scenario-loop`.
3. **The business's drawings are data.** Capture each drawing — lanes, legend paths and colours,
   every arrow with a decision — and every difference between drawing and model as an issue for
   the stakeholders. → skill `capture-drawing`.
4. **Let the check find the gaps.** Static findings, coverage and drawn-but-never-shown arrows
   come from the model check, not from reading. → skill `model-check`.
5. **Model in the kernel's grain.** Commands to aggregates only, derive don't accumulate,
   idempotency is the model's job, a guard that cannot be evaluated is loud. → skill
   `model-authoring`.
6. **Say what you did not see.** If a source (an image, a slide) is not in front of you, say so
   and ask — never rebuild it from its title.
7. **Commit in pieces** — the model, its scenarios, its drawings, its docs; on the platform the
   kernel and the UI apart too — with messages that say why and what was rejected. Push only when
   asked.
8. **A need the platform cannot meet crosses in neutral words.** Before touching statestorm, say
   the need again in its own examples' words (`lab`, `sales`, `claims`) and work only from that: a
   backlog item there, an ADR whose *Forced by* is the general shape, a scenario in an example.
   Nothing of a domain — its words, ids, quotes, screenshots, paths, repo — goes into the platform,
   not even in a commit message. → skill `platform-change`.
<!-- /statestorm:rules -->

## Working on statestorm itself

- **A new kernel feature needs an ADR and a scenario that cannot be written without it.** A domain
  need becomes a general mechanism, said in the examples' words (below).
- Kernel semantics to keep in mind: delivery is at least once and unordered (ADR 0006); an
  aggregate's step settles inside it (ADR 0012); inherited rules are tried before a subtype's
  own, and a subtype overrides a rule by declaring the *same key* (ADR 0008); a payload field
  that is absent cannot be read — required fields, or one variant per case; a field `takes:`
  declares optional (`name: string?`) reads as not matching when it is absent.
- **The whole build (`pnpm verify`) stays under 5 minutes.** Search from snapshots (`fork`), never by
  replaying a run; spread independent work over worker threads; give every search a budget.
- After a UI change: rebuild what the user runs, **look at a screenshot**, run `pnpm ui-check`.
- No build step for the kernel (Node runs the TypeScript); the UI is Vite + React.

## Keep it neutral

This repo is shared by every domain that uses statestorm and read by people outside all of them.
**Nothing of a real domain goes in** — anywhere: code, tests, comments, error messages, ADRs, docs,
the backlog, images, commit messages, branch names. Not its type, event or system names, not its
rule or question ids, not its owner's words, not its node or scenario ids, not a screenshot of its
model, not its repo, people, addresses or machines.

- **Say it in the examples' words.** Every example, test and screenshot uses `lab`, `sales` or
  `claims`; if none has the shape you need, extend `lab` with a scenario. A need that came from a
  domain is restated before work starts (skill `platform-change`).
- **An ADR's *Forced by*** is the general shape of the need, not who asked or what they said —
  `docs/adr/TEMPLATE.md`.
- **Code never knows a domain's field or state name** (a `payload.batchNo`, a `*Planned` event of one model):
  read it from the model, or make it the model's to declare.
- **The check:** `pnpm neutral` (part of `pnpm verify`), and the commit hooks on what is staged and on
  the message — `pnpm hooks` once per clone. It takes the words to look for from the domain folders
  in your own `~/.config/statestorm/config.json` (`"neutral": { "domains": [...], "terms": [...] }`),
  so that list is never in this repo; without it, it still checks addresses, private IPs, home paths,
  GitHub owners and images. A finding is a leak to restate; `scripts/neutral/allow.txt` is only for
  ordinary words a domain happens to use too.
