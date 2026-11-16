---
name: platform-change
description: Take a need a domain's model cannot meet to the statestorm platform — restated in the neutral examples' words first, as a BACKLOG item, then an ADR, a lab scenario and the change. Use when a domain session finds the kernel, the workbench or the check missing something, before touching the platform repo.
---

# Taking a domain's need to the platform

The platform is shared by every domain and read by people outside all of them: nothing of one
domain may enter it — not its words, its ids, its owner's quotes, its screenshots, its file paths,
nor its repo's name. The way to keep it so is to **leave the domain behind before you cross**: say
the need again, in the platform's own examples, and work only from that.

## 1. Say the need again, without the domain

- Write down the **shape** of what the model cannot say, in general terms: "a broadcast should reach
  only the referrers that match", "a list arrives in no order and carries its order in a field".
- Find that shape in the bundled examples — `lab` first (sample, site visit, transfer, task,
  handling, deviation, scan), then `sales`, `claims`. If none has it, **extend `lab`** with the least
  that shows it: a type, a policy, a scenario. Never copy the domain's model across.
- From here on, use only those words: in the backlog item, the ADR, the tests, the code's comments,
  the commit messages, the branch name. If you catch yourself writing a domain's type, id or system,
  stop and restate it.

## 2. A backlog item in the platform

Add it to the platform's `BACKLOG.md` (the next free id), in the words of step 1: why it matters,
and how you would know it is done. Claim it before starting (BACKLOG.md says how). The domain repo
keeps its own record of why it asked — its session log, its question ids — on its side only.

## 3. Build it on the platform

- A kernel feature needs an ADR (`docs/adr/TEMPLATE.md`) — its **Forced by** is the shape from step
  1, not who asked — and a scenario in an example that cannot be written without it.
- The UI and check tests run on `lab`; a screenshot is of `lab`.
- `pnpm verify` runs the neutrality check (`pnpm neutral`); the commit hooks run it on what is
  staged and on the message (`pnpm hooks`, once per clone). A finding is a leak to restate, not a
  word to allow: `scripts/neutral/allow.txt` is for ordinary words a domain happens to use too.

## 4. Back in the domain

Take the platform change in (`pnpm update statestorm`), then use it in the domain's own words —
which belong there, and only there.
