# ADR 0019 — A model in parts: `include:`

- **Status:** proposed, 2026-11-06
- **Decides:** how one model is written in several files, and how every reader finds them
- **Builds on:** ADR 0013 (packages), ADR 0016 (`why:` and the trace of the comments), ADR 0018 (systems)
- **Forced by:** a domain owner whose model "is also growing pretty big": *"it could be useful to split the
  yaml into parts and include them in the larger one"* — per bounded context, or per team when one team
  owns several

## Context

A domain's model is one `model.yaml`. Grown to four thousand lines, it is hard to read, to review and to
own: a team cannot see its part apart from the rest. Splitting it must not change what the model *is* —
the kernel, the scenarios and every view read one model, as today.

## Decision

1. **`include:`** in `model.yaml` lists parts, by path relative to it: `include: [model/orders.yaml,
   model/bench.yaml]`. A part is a YAML file with the same sections — `values`, `packages`, `aggregates`,
   `policies`, `systems`, `contexts`, `relations` — and may include parts of its own, relative to itself.
   How to cut is the domain's choice: per bounded context, per team, per package.
2. **The parts are merged before anything is read**, in the order included, depth first. A name declared
   twice is an error naming both files (`aggregates.Order: declared in model/a.yaml and in model/b.yaml`);
   `relations` are joined. Inheritance, policies and packages work across parts as within one file.
3. **What says something of the whole model stays in `model.yaml`:** `context`, `overview`, `coverage`.
   A part included twice, in a circle, missing, or outside the model's folder is refused.
4. **Errors and traces name the file.** The model remembers where each name was declared
   (`model.sources`); an error about a name declared in a part ends `(in model/orders.yaml)`. The docs'
   trace reads every file's comments: a rule named only in a part's comment is said as `part:line`.
5. **One loader, no file system in the kernel.** `loadModel(text, files)` takes the parts by path;
   `modelFiles(read)` follows the includes with whatever reads — the disk for the command line
   (`readModel`), the files a folder gave the browser for the workbench (Open folder…, `domains.json`).
   Every command (`test`, `check`, `docs`, `rules`, `context-map`, `sequence`, `dev`, `build`, `share`)
   reads the parts; the workbench's model editor edits `model.yaml` itself, the parts as they are.

## Consequences

- A domain can split its model without touching a scenario, a drawing or a `why:`.
- Extracting a scoped description for one team (a system, a context) can start from its parts.
- Rejected: globs (`model/*.yaml`) — the order of packages is the reading order, and an explicit list
  says it; a part overriding a name from another — a model in parts must mean the same as in one file;
  YAML anchors across files — YAML has none, and a part stays a valid file on its own.
