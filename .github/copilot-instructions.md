# Copilot instructions

The full instructions for agents in this repo are in [AGENTS.md](../AGENTS.md) — read it first —
and the skills it names are in `.claude/skills/<name>/SKILL.md` (Copilot loads skills from there).
What is being worked on and what is next: [BACKLOG.md](../BACKLOG.md).

The essentials, for where AGENTS.md is not read (code review, chat on github.com):

- statestorm is a platform: the kernel, the scenario runner, the workbench and the model check.
  Real domains live in repos of their own; the neutral examples here (`sales`, `claims`, `lab`) are
  also the test fixtures.
- `pnpm verify` (tests, typecheck, the model check of every example) must pass and stay under five
  minutes.
- Nothing of a real domain goes in — not in code, tests, comments, ADRs, docs, images or commit
  messages: examples use `lab`, `sales` or `claims` (AGENTS.md, "Keep it neutral"; `pnpm neutral`).
  A new kernel feature needs an ADR in `docs/adr/` (`TEMPLATE.md`) and a scenario that cannot be
  written without it.
- Every behaviour has a scenario, and every rule a mutation check: a scenario that passes the first
  time is suspect until a broken rule makes it fail.
- After a UI change: rebuild what runs (`docker compose up -d --build`), look at a screenshot, and
  run `pnpm ui-check`.
- Commit in pieces, with messages that say why and what was rejected. Push only when asked.
