#!/usr/bin/env node
/**
 * statestorm check (MC-7) — the model check for CI:
 *
 *   node packages/ui/src/check/cli.ts <domain folder> [flags]
 *   node packages/ui/src/check/cli.ts <model.yaml> <scenarios dir> [drawings dir] [--docs-dir=<dir>] [flags]
 *   node packages/ui/src/check/cli.ts docs <the same paths>        writes the docs' rulebook (ADR 0016)
 *   node packages/ui/src/check/cli.ts rules <the same paths> [--id=<id>] [--topic=<t>] [--open] [--json]
 *
 * Runs every scenario under every schedule, then reports the static checks (MC-2), coverage
 * (MC-3) and the drawings compared with the board (MC-12), commands nobody answered (MC-17) and
 * how many scenarios cover nothing of their own (MC-16). Exits 1 on errors: a scenario that
 * fails, a drawing that does not import, a command nobody answered. Gaps are warnings; `--all` shows the info findings too,
 * `--coverage` every untaken rule and unreached state, `--scenarios` what each scenario alone
 * covers, `--issues` only the changes to the drawings
 * (drawings/<model>/issues.yaml) as Markdown, for the stakeholders; `--propose` writes a proposed
 * scenario per drawn arrow never shown to <scenarios dir>/proposed/ (MC-11). The docs (ADR 0016) are
 * traced on every run; `--docs` traces only them, with no runs — the check a hook runs after an edit.
 */
import { check, docs, rules } from "./main.ts";

const [first, ...rest] = process.argv.slice(2);
process.exit(first === "docs" ? docs(rest) : first === "rules" ? rules(rest) : await check(process.argv.slice(2)));
