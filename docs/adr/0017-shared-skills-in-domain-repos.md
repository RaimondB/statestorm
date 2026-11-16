# ADR 0017 — The platform's skills and rules, kept in step in every domain repo

- **Status:** proposed, 2026-11-02
- **Decides:** how a domain repo gets the platform's skills (`.claude/skills/`) and the shared
  "how we work on a model" rules of `AGENTS.md`, keeps them current as the platform moves, and adds
  its own without the two mixing
- **Builds on:** ADR 0016 (the hooks a domain repo copies from `templates/`); the split of one
  platform repo and one repo per domain (README, "Using statestorm in a domain repo")
- **Forced by:** a domain repo's copies of the skills fell behind the platform's within a week —
  two rows of the model check's table and a paragraph of the scenario loop missing — and ADR 0016
  changes four of the five skills again. Copying by hand does not hold; nothing even says a copy is
  behind.

## Context

A skill is how the way of working reaches an agent: Claude Code and GitHub Copilot both load
`.claude/skills/<name>/SKILL.md` from the repo they work in. The skills are the platform's — they
say how to use the kernel, the check, the docs — so they change with it. A domain repo needs them
as files in its own tree: a cloud agent (Copilot's, Claude Code's on the web) reads the repo before
anything is installed, and reads no plugin. A domain also has conventions of its own, which must
not end up in the platform's text — nor the platform's be edited in a domain repo, where the next
update would lose them.

`AGENTS.md` has the same problem in one section: "How we work on a model — the rules" is the same
in every repo, and was already drifting; the rest of each `AGENTS.md` is that repo's.

## Decision

1. **The platform ships its skills and `AGENTS.md`** in the package (`files`), so a domain repo has
   them under `node_modules/statestorm/`.

2. **`statestorm skills <domain folder>` writes them into the domain repo as committed copies** —
   `.claude/skills/<name>/SKILL.md` — with a line under the front matter saying where the copy
   comes from and where to change it. A manifest, `.claude/skills/.statestorm.json`, records each
   copy's hash as written.
   - A copy whose hash is no longer the manifest's was **edited in the domain repo**: it is not
     overwritten; the command says so and fails, and `--force` takes the platform's.
   - A skill the platform no longer has is removed, unless edited.
   - A skill the manifest does not name is the domain's own, and is never touched.
   - With no manifest yet, the first run takes over the copies already there (they are in git; the
     diff shows what changed).
   - `--check` writes nothing and fails when anything is behind or edited.

3. **A domain's additions go beside a copy, never in it**: `DOMAIN.md` in the skill's folder. When
   there is one, the copy says to read it, after the platform's text. A convention that is no skill
   of the platform's is a skill of the domain's own, under its own name.

4. **The shared rules of `AGENTS.md` are a marked block**: between `<!-- statestorm:rules -->` and
   `<!-- /statestorm:rules -->` in the platform's `AGENTS.md`, copied by the same command between
   the same markers in the domain's — and nothing else of that file is touched. A domain file
   without the markers is left as it is, and the command says how to take the block. The block is
   written for every repo: no platform-only or domain-only words in it.

5. **It runs on its own**: a domain repo's `package.json` has `"postinstall": "statestorm skills ."`,
   so `pnpm install` and `pnpm update statestorm` bring the skills in with the platform — in the
   same diff as the lockfile, committed together. The git pre-commit hook (ADR 0016) warns when the
   copies are behind; it does not refuse the commit — being behind is the platform's news, not the
   commit's fault.

## Consequences

- A platform change to a skill reaches a domain repo on its next `pnpm update statestorm`; a
  reviewer sees it in that commit.
- An edit made to a copy in a domain repo is caught on the next sync, not lost: move it into
  `DOMAIN.md`, or take it to the platform when it is not about the domain.
- The platform's skills stay free of any one domain (AGENTS.md: "nothing here is about one
  particular model"); what a domain adds stays in its repo.
- `copilot-instructions.md`, which summarises the rules for where `AGENTS.md` is not read, is
  still each repo's own; it should point at the rules rather than restate them.
- Rejected:
  - *Symlinks into `node_modules/statestorm`.* Broken in a fresh clone and in a cloud agent before
    it installs; unreliable on Windows.
  - *A Claude Code plugin served from the platform repo.* It updates itself, but Copilot reads no
    plugin, and a cloud agent sees no skill until it is installed.
  - *A git submodule.* Another manual step to update, which is the friction this removes.
  - *Merging a domain's edits into the copy.* Two authors of one text; the next update would have
    to guess which lines are whose. `DOMAIN.md` keeps them apart.
  - *Refusing a commit while the skills are behind.* It would block domain work on platform news.
