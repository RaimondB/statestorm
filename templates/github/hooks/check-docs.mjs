#!/usr/bin/env node
// An agent hook for a statestorm domain repo (ADR 0016): after an edit to the model, a scenario
// or the docs, regenerate the rulebook and trace the docs (`statestorm check --docs`, no runs,
// about a second). Anything else edited: nothing runs. The edit itself always stands.
//
// One script in .github/hooks/, two callers, told apart by the payload they send:
//   Claude Code (.claude/settings.json) — snake_case `tool_input`; problems go back on stderr with
//     exit code 2, which Claude Code shows the agent.
//   GitHub Copilot (.github/hooks/statestorm.json) — camelCase `toolName`/`toolArgs`; problems go
//     back as `additionalContext` on stdout, which Copilot appends to the tool's result.
//
// Copied from statestorm's templates/ into the domain repo (README, "The domain's decisions").
// STATESTORM names another statestorm command to run — an unpushed platform, say:
// STATESTORM=../statestorm/dist/statestorm.js.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const copilot = "toolName" in input;
const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
// The edited file, under the names the tools give it; Copilot's arguments may arrive as a JSON string.
const args = (copilot ? (typeof input.toolArgs === "string" ? safeJson(input.toolArgs) : input.toolArgs) : input.tool_input) ?? {};
const file = args.file_path ?? args.filePath ?? args.path;
if (typeof file !== "string") process.exit(0);
function safeJson(text) { try { return JSON.parse(text); } catch { return {}; } }
const tell = (text) => {
  if (copilot) { console.log(JSON.stringify({ additionalContext: text })); process.exit(0); }
  console.error(text);
  process.exit(2);
};
const path = relative(root, resolve(root, file)).split("\\").join("/");
const generated = /^docs\/(rulebook|\.schemas)\//.test(path);
if (generated || !/^(model\.yaml$|scenarios\/[^/]+\.yaml$|docs\/|drawings\/issues\.yaml$)/.test(path)) process.exit(0);

const cli = process.env.STATESTORM ?? join(root, "node_modules/statestorm/dist/statestorm.js");
if (!existsSync(cli)) tell(`statestorm hook: no statestorm at ${cli} — run pnpm install`);
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
if (path.startsWith("docs/")) run("docs", root);          // keep the rulebook in step; check says what is wrong
const check = run("check", root, "--docs");
if (check.status === 0) process.exit(0);
tell(`statestorm check --docs, after editing ${path}:\n${check.stdout}${check.stderr}`);
