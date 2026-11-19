# Getting started — your own domain repo

You want to model a domain with statestorm: its aggregates, the policies between them, scenarios that
prove the rules, and a workbench to show it to the people who know the domain. This guide takes you
from an empty folder to a domain repo that runs, checks itself, records its decisions and can be
shared — about half an hour. Every step was run as written; the example is a small library (members
borrow books; an overdue loan blocks its member), small enough to type in and replace with your own.

The [README](../README.md) is the reference for every command and file; this is the walk through it.

## 0. Before you start

- **Node 22.18 or newer** (24 recommended): `node --version`.
- **pnpm 9**: `npm install -g pnpm@9.15.0` if needed, then `pnpm --version`.
- **git** and network access to [RaimondB/statestorm](https://github.com/RaimondB/statestorm).
  The repository is public; the HTTPS dependency in step 3 needs no GitHub credentials.

## 1. Create the repository

A domain lives in a repository of its own, and its root is the **domain folder**.

```bash
mkdir library && cd library
git init -b main
printf 'node_modules/\nexports/\nsite/\n' > .gitignore
```

`exports/` is where shared files go (step 9) and `site/` a built site: made from the repo, not part
of it.

**Instructions for agents.** Claude Code reads `CLAUDE.md`, GitHub Copilot and others read
`AGENTS.md`; keep one text and point the other at it. The two marker lines are where the platform's
shared rules go — step 3 fills them in, and keeps them in step afterwards. Everything outside them is
yours: what this domain is, where its owner's material lives, its conventions.

```bash
cat > AGENTS.md <<'EOF'
# AGENTS.md

This repository is the **library** domain model, built and run with statestorm. Start with
HANDOFF.md, then ask the decisions rather than reading them: `pnpm rules`, `pnpm rules --open`.

## How we work on a model — the rules

<!-- statestorm:rules -->
<!-- /statestorm:rules -->
EOF
printf '@AGENTS.md\n' > CLAUDE.md
```

## 2. Write a first model

A model is one YAML file, `model.yaml`. Aggregates have a lifecycle — a statechart — accept commands
and raise events; they never call each other. A **policy** listens for an event and sends a command.
Start with the smallest thing that says something true about the domain:

```yaml
# model.yaml — the library: members borrow books; a loan not returned in three weeks blocks its member.
context: Library

aggregates:
  Member:
    creators: [Join]
    initial: active
    states:
      active:
        on:
          Join: { emit: [ MemberJoined: { member: "${id}" } ] }
          Block: { target: blocked, emit: [ MemberBlocked: { member: "${id}" } ] }
      blocked:
        on:
          Block: {}                       # a second overdue loan changes nothing
          Unblock: { target: active, emit: [ MemberUnblocked: { member: "${id}" } ] }

  Loan:
    creators: [Lend]
    data:
      member: { type: string }
    initial: lent
    states:
      lent:
        on:
          Lend: { assign: { member: command.member }, emit: [ BookLent: { loan: "${id}", member: "${command.member}" } ] }
          Return: { target: returned, emit: [ BookReturned: { loan: "${id}" } ] }
        after:
          21d: { target: overdue, emit: [ LoanOverdue: { loan: "${id}", member: "${member}" } ] }
      overdue:
        on:
          Return: { target: returned, emit: [ BookReturned: { loan: "${id}" } ] }
      returned: { final: true }

policies:
  block_when_overdue:
    on: LoanOverdue
    command: "Member#${event.member}.Block"
```

Worth noticing already: `Block: {}` in `blocked` says on purpose that a second block changes nothing —
messages may arrive twice, and the model answers every command it can receive
([ADR 0006](adr/0006-at-least-once-delivery.md)). The idioms are in the skill `model-authoring`
(step 10) and in [docs/design.md](design.md); the [examples](../packages/examples/models/) show more —
`sales` (the reference), `claims` (nested states), `lab` (everything a larger domain uses).

## 3. Install statestorm

`package.json` installs the platform as a git dependency and gives every command a short name:

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
    "dev": "statestorm dev . --name=library",
    "build": "statestorm build . --out=site --name=library",
    "share": "statestorm share . --name=library"
  },
  "devDependencies": {
    "statestorm": "git+https://github.com/RaimondB/statestorm.git#master"
  }
}
```

`#master` follows the platform; a tag (such as `#v0.4.0`) pins a release.

```bash
pnpm install
```

Installing builds the workbench and the `statestorm` command (a minute the first time), then
`postinstall` copies the platform's **skills** into `.claude/skills/` and its **shared rules** between
your markers in `AGENTS.md` ([ADR 0017](adr/0017-shared-skills-in-domain-repos.md)). Commit them: an
agent reads them from the repo. It needs `model.yaml` to be there — install before step 2 and it
says so.

## 4. Scenarios: say what should happen, and run it

A scenario is a story with assertions: what is there already (`given`), what happens (`when`), what
must be true at the end (`then`). One file each, in `scenarios/`, numbered:

```yaml
# scenarios/01-returned-on-time.yaml
scenario: a book returned within three weeks leaves the member as they were
given:
  at: 2026-01-05T10:00:00Z
  send:
    - Member#M1.Join: {}
when:
  - send: { Loan#L1.Lend: { member: M1 } }
  - advance: 20d
  - send: { Loan#L1.Return: {} }
  - advance: 5d
then:
  - state: { Loan#L1: returned, Member#M1: active }
  - not_emitted: [LoanOverdue, MemberBlocked]
```

```yaml
# scenarios/02-overdue-blocks-the-member.yaml
scenario: a loan three weeks overdue blocks its member
given:
  at: 2026-01-05T10:00:00Z
  send:
    - Member#M1.Join: {}
when:
  - send: { Loan#L1.Lend: { member: M1 } }
  - advance: 21d
  - expect_state: { Loan#L1: overdue, Member#M1: blocked }
  - send: { Loan#L1.Return: {} }
then:
  - state: { Loan#L1: returned, Member#M1: blocked }
  - emitted: [LoanOverdue, MemberBlocked]
```

```bash
pnpm test
```

**Master data most scenarios need** — the places, the parties — is written once: a file in a folder
below `scenarios/` with only `send:`, which a scenario names in `given: include: [given/places.yaml]`; its
sends run first ([ADR 0029](adr/0029-a-shared-set-up-for-scenarios.md)).

Each scenario runs under seven **schedules** — in order (`fifo`), in five random orders, and with
every message delivered twice (`duplicate`) — because real messaging does all three; `14/14 runs passed`. `pnpm exec statestorm test . --trace` prints the story
of a run: who caused what, and why a command changed nothing.

**A scenario that passes the first time proves little.** Break the rule it is about — make the policy
send `Unblock` instead of `Block` — and run again: scenario 02 must fail (`MemberBlocked was never
raised`). Then put it back. Every rule worth having gets such a mutation check (skill
`scenario-loop`).

## 5. Let the check find the gaps

```bash
pnpm check
```

The model check reads the model and runs every scenario: rules and states no scenario reaches,
commands a model does not answer, scenarios that end half-way, and — once you have them — drawings
and docs that disagree with the model. On the library it warns that both scenarios end with a member
that is not finished. That is by design here, so the model says so, with the reason:

```yaml
coverage:
  lives_on: { Member: a member stays a member — blocked or not }
```

`0 errors, 0 warnings`. `pnpm check --propose` goes further and writes a proposed scenario for each
gap it finds (`scenarios/proposed/`), to rename, give real assertions and keep — or delete. Skill
`model-check` says what each finding asks of you.

## 6. Record the decisions: `docs/`

A model is only right when the domain owner agrees with it, so what they decided is written down
first, as data the check can trace ([ADR 0016](adr/0016-domain-docs-and-traceability.md)). The
formats are in [schemas/](../schemas/); the `lab` example has all of them
([packages/examples/docs/lab/](../packages/examples/docs/lab/)). The smallest useful set:

```yaml
# docs/rules/loans.yaml — the rules of one topic, as they hold today
# yaml-language-server: $schema=../.schemas/rules.schema.json
title: Loans
canvas:
  purpose: lending a book, and what happens when it does not come back
rules:
  - id: R1
    title: A loan is due three weeks after it is lent
    kind: behavioural
    status: agreed
    decided: { session: 1, date: 2026-01-05 }
    text: A book is lent to one member and is due back three weeks later; until then nothing happens.
  - id: R2
    title: An overdue loan blocks its member
    kind: behavioural
    status: agreed
    decided: { session: 1, date: 2026-01-05 }
    text: When a loan becomes overdue, its member is blocked from borrowing.
```

```yaml
# docs/questions.yaml — what is still asked of the owner, each with the default you would build
# yaml-language-server: $schema=.schemas/questions.schema.json
questions:
  - id: Q-1
    question: Does returning an overdue book unblock the member?
    leaning: no — a librarian unblocks, once any fine is paid
    status: open
    about: [R2]
    asked: { session: 1, date: 2026-01-05 }
```

```yaml
# docs/glossary.yaml — the domain's words, and what each names in the model
# yaml-language-server: $schema=.schemas/glossary.schema.json
terms:
  - term: Loan
    definition: One book lent to one member, due back three weeks after it was lent.
    model: [Loan]
  - term: Overdue
    definition: A loan not returned within three weeks.
    model: [Loan.overdue, LoanOverdue]
```

and a log of the session that decided them, `docs/decisions/01-2026-01-05-first-session.md`, in
plain Markdown — what was brought, asked and answered, in the owner's words. Then say where each rule
is built and shown: `why: [R1]` on the `Loan` type and on scenario 01, `why: [R2]` on the policy and
on scenario 02 (a `why:` line at the top of a scenario file).

```bash
pnpm run docs      # the rulebook the owner reads, generated into docs/rulebook/ (commit it); not bare `pnpm docs`, pnpm's own
pnpm check         # now also traces the docs: every agreed rule cited by the model and a scenario
pnpm rules --open  # what waits on the owner — the agenda of the next session
```

## 7. See it in the workbench

```bash
pnpm dev
```

opens the workbench on http://localhost:5181/ — reload to read your files again. Pick a scenario and
step through it: the **overview** (as the business draws it), the **flow** board, the **structure**,
the **statecharts**, the **sequence**, the **docs**, a narrated trace and a timeline. Another
workbench already on that port? `pnpm dev --port=5182`.

## 8. Turn on the hooks

The platform brings hooks that keep the docs honest after every change, for agents and people alike:

```bash
mkdir -p .github/hooks .githooks
cp node_modules/statestorm/templates/github/hooks/* .github/hooks/
cp node_modules/statestorm/templates/git/pre-commit .githooks/ && git config core.hooksPath .githooks
cp -n node_modules/statestorm/templates/claude/settings.json .claude/settings.json   # or merge by hand
```

The pre-commit hook refuses a commit while the docs do not check; the agent hooks regenerate the
rulebook after an edit and tell the agent what is wrong. `core.hooksPath` is set per clone — say so in
your README. Now commit:

```bash
git add -A && git commit -m "library: lending and overdue loans"
```

## 9. Share it with the people who know the domain

```bash
pnpm share
```

writes `exports/library-<yyyymmddhhmm>.html` — the whole workbench with your domain inside, in one
file. Mail it or put it on a share; it opens in a browser with nothing installed and sends
nothing anywhere. It names the commit it was made from, and warns when that commit is not pushed. For
a meeting about a few scenarios, an **agenda** (`agendas/<name>.yaml`, [ADR 0025](adr/0025-agendas-scenarios-chosen-for-a-meeting.md))
and `pnpm share --agenda=<name>`. The README's "Sharing a model with stakeholders" has the options.

## 10. Working with an AI agent

The skills `postinstall` copied are the working method, for Claude Code and Copilot alike:

| Skill | For |
|---|---|
| `domain-session` | a session with the domain owner: numbered questions with leanings, answers written into `docs/` before modelling |
| `model-authoring` | writing the model in the kernel's grain |
| `scenario-loop` | a scenario per behaviour, a mutation check per rule |
| `capture-drawing` | the business's drawings as data, and where they differ from the model |
| `model-check` | what each finding of `pnpm check` asks of you |
| `platform-change` | when the platform cannot say what the domain needs (step 12) |

A good first request: *"run a domain session — here is how lending works today …"*. Keep a
`HANDOFF.md` at the root — where the work stands, what is next — so the next session, yours or an
agent's, starts from it.

**Don't edit a skill's copy**: what your domain adds to a skill goes in `DOMAIN.md` beside it, and the
copy then tells the agent to read it. A skill of your own (a folder the platform does not have) is
never touched.

## 11. Keeping up with the platform

```bash
pnpm update statestorm
pnpm exec statestorm skills .
```

The first command updates the lockfile to the platform's latest `master`; the second syncs the
skills and shared rules. Run `pnpm test` and `pnpm check`, then commit the lockfile, the skills and
`AGENTS.md` together.

## 12. When the platform cannot say what you need

Sooner or later the model needs something the kernel, the workbench or the check does not have. The
platform is shared by every domain, so **nothing of yours may go into it** — not your words, your ids,
your owner's quotes, your screenshots. Restate the need in the platform's own examples first, then
work from that: skill `platform-change` walks it, the platform's [BACKLOG.md](../BACKLOG.md) is where
it is proposed, and its [AGENTS.md](../AGENTS.md) ("Keep it neutral") says why.

## What you have now

```
library/
  model.yaml                    the model
  scenarios/NN-<what>.yaml      what must happen, proven under every schedule
  docs/                         rules/<topic>.yaml, questions.yaml, glossary.yaml, decisions/, rulebook/ (generated)
  drawings/                     the business's drawings as data, and issues.yaml — when you have some (skill capture-drawing)
  agendas/                      scenarios chosen for a meeting — optional
  AGENTS.md  CLAUDE.md          instructions for agents; the shared rules between the markers
  HANDOFF.md                    where the work stands
  .claude/skills/               the platform's skills (copied; DOMAIN.md beside one adds yours)
  .githooks/  .github/hooks/  .claude/settings.json   the hooks
  package.json  pnpm-lock.yaml
```

## When something goes wrong

| You see | It means |
|---|---|
| `Permission denied (publickey)` or `Repository not found` on install | check that the dependency uses the public HTTPS URL in step 3 and Git is not rewriting it to SSH |
| `statestorm skills: . is not a domain folder yet — it has no model.yaml` | install ran before the model existed — write `model.yaml`, `pnpm install` again |
| `pnpm docs` opens a browser, or fails with "Set the BROWSER environment variable" | pnpm's own `docs` command ran, not the script — `pnpm run docs` |
| `statestorm dev: port 5181 is in use` | another workbench runs there — `pnpm dev --port=5182` |
| `✗ .claude/skills/<skill>/SKILL.md was edited in this repo` | a copied skill was changed — move the change to `DOMAIN.md` beside it, or `pnpm exec statestorm skills . --force` |
| `pre-commit: the docs do not check` | `pnpm run docs` regenerates the rulebook; `pnpm exec statestorm check . --docs` says what else |
| a scenario passes under `fifo` but fails under `random(n)` or `duplicate` | the model depends on order or on hearing a message once — ADR 0006 and skill `model-authoring` |
