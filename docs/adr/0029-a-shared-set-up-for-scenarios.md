# ADR 0029 — A shared set-up for scenarios: `given: include:`

- **Status:** proposed, 2026-11-17
- **Decides:** how scenarios that start from the same world write that start once
- **Builds on:** ADR 0019 (a model in parts — the same idea for a model's files), ADR 0022 §4 (the
  set-up folded in the sequence)
- **Forced by:** master data most scenarios need: the places, the parties, their settings. Every
  scenario registers them in its `given:`, the same lines copied into tens or hundreds of files. A
  change to one place's settings is a change to every copy, and a story's own set-up drowns in them.

## Context

A scenario's `given:` replays commands before the story starts. In `lab`, every scenario now needs the
sites registered, clinics and labs (ADR 0028), before its request is planned. Copied into each file,
five lines of master data would stand before every story; in a larger domain, the same set-up runs to
dozens of lines in every one of hundreds of scenarios.

## Decision

1. **`given: include:` lists shared set-ups** by path relative to the scenarios folder:
   `include: [given/sites.yaml]`. Their sends come **first**, in the order included, before the
   scenario's own `send:`.
2. **A shared set-up is a file in a folder below `scenarios/`**, which keeps it from being taken for a
   scenario. It holds only `send:` and may `include:` other set-ups, relative to its own folder; theirs
   come before its own. `scenarios/proposed/` is the check's and is never read as a set-up.
3. **Refused, with the path:** a file that is missing, is not `.yaml`, lies outside the scenarios
   folder, includes itself, or holds anything but `include:` and `send:` (a set-up does not set the
   clock or name a phase; the scenario does).
4. **One parser, no file system in it.** `parseScenario(text, file, read)` takes a reader of the
   scenarios folder's files by path. The command line reads the disk (`readScenario`). The workbench
   reads the files a domain's folder gave it (`Example.setups`, from `domains.json`, a shared file or
   Open folder…). The bundled examples are globbed.
5. **The set-up is part of `given:`.** The sequence folds it with the rest of the set-up (ADR 0022 §4).
   A proposed scenario keeps the original's `include:`, which resolves once it is kept in `scenarios/`.

```yaml
# scenarios/lab/given/sites.yaml
send:
  - Clinic#CLIN1.Register: { name: north clinic }
  - Lab#LAB1.Register: { name: central lab }

# scenarios/lab/01-two-tubes-to-the-lab.yaml
given:
  include: [given/sites.yaml]
  at: 2026-03-02T08:00:00Z
  send:
    - Request#R1.Create: { patient: P1, samples: [S1, S2] }
```

## Consequences

- Master data is written once, and a story shows only its own set-up. Every `lab` scenario includes
  its sites.
- A scenario can still register a place of its own, or send a setting after the include to differ
  from the shared one. The shared set-up is a start, not a fixture to override.
- **Rejected: a set-up for the whole folder, applied to every scenario.** It would be implicit: a
  scenario would no longer say where its world comes from, and those that need a different start
  could not opt out.
- **Rejected: YAML anchors across files.** YAML has none, and a merge key would put the set-up's
  lines back into every file anyway.
