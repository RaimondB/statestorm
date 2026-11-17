/**
 * `statestorm context-map` and `statestorm sequence` (ADR 0018 §6): the context map of a domain's
 * model, and one of its scenarios as a sequence diagram, as Mermaid for documents — read from the
 * same derivation the workbench draws.
 */
import {
  contextMap, contextMapToMermaid, DEPTHS, lifelineNamed, lifelinesOf, loadModel, openAt, scopesOf, sequenceOf, sequenceToMermaid,
  type Depth, type Level, type Model,
} from "@statestorm/kernel";
import { parseScenario, runScenario } from "@statestorm/scenarios";
import { readDomain } from "./domains.ts";

const flag = (args: string[], name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const plain = (args: string[]) => args.filter((a) => !a.startsWith("--"));

function level(args: string[]): Level {
  const l = flag(args, "level") ?? "system";
  if (l !== "domain" && l !== "system" && l !== "context" && l !== "subsystem") throw new Error(`--level=${l}: domain, system, context or subsystem`);
  return l;
}

/** The scope of sub-system level: `--system`, or the model's one system that has a scope (ADR 0020 §3). */
function scope(model: Model, l: Level, args: string[]): string | undefined {
  if (l !== "subsystem") return undefined;
  const given = flag(args, "system");
  if (given) return given;
  const own = scopesOf(model);
  if (own.length === 1) return own[0]!;
  throw new Error(`--level=subsystem needs --system=<one of: ${own.join(", ")}>`);
}

function model(dir: string): { model: Model; files: Record<string, string> } {
  const d = readDomain(dir);
  return { model: loadModel(d.files["model.yaml"]!, d.files), files: d.files };
}

export function contextMapCommand(args: string[]): number {
  const [dir] = plain(args);
  if (!dir) { console.error("usage: statestorm context-map <domain folder> [--level=domain|system|context|subsystem] [--system=<name>]"); return 2; }
  const { model: m } = model(dir);
  const l = level(args);
  process.stdout.write(contextMapToMermaid(contextMap(m, l, scope(m, l, args))));
  return 0;
}

const SEQUENCE_USAGE = "usage: statestorm sequence <domain folder> <scenario: its file, or the start of its name> [--level=domain|system|subsystem|aggregate] [--open=<name>,…] [--unfold] [--ignored]";

/**
 * What is open (ADR 0022 §7–8): every node above `--level` (system by default), and each node `--open`
 * names — a domain, system, sub-system or aggregate, by its name. `--system=<name>` is `--open=<name>`.
 */
function opened(m: Model, args: string[]): string[] {
  const l = flag(args, "level") ?? "system";
  if (l === "context") throw new Error("--level=context: the sequence opens down domain → system → sub-system → aggregate; a context is drawn as a band (ADR 0022 §7)");
  if (!(DEPTHS as string[]).includes(l)) throw new Error(`--level=${l}: ${DEPTHS.join(", ")}`);
  const lines = lifelinesOf(m);
  const named = [flag(args, "open"), flag(args, "system")].filter((v): v is string => !!v).flatMap((v) => v.split(",")).map((n) => n.trim()).filter(Boolean);
  // A node opened by name opens what it is inside, too: otherwise it could not be seen.
  const withAncestors = named.map((n) => lifelineNamed(lines, n)).flatMap((id) => {
    const out: string[] = [];
    for (let n: string | undefined = id; n; n = lines.nodes[n]?.parent) out.push(n);
    return out;
  });
  return [...new Set([...openAt(lines, l as Depth), ...withAncestors])];
}

export function sequenceCommand(args: string[]): number {
  const [dir, which] = plain(args);
  if (!dir || !which) { console.error(SEQUENCE_USAGE); return 2; }
  const { model: m, files } = model(dir);
  const names = Object.keys(files).filter((f) => f.startsWith("scenarios/"));
  const base = which.replace(/^.*\//, "");
  const found = names.filter((f) => f === `scenarios/${base}` || f.slice("scenarios/".length).startsWith(`${base}-`) || f.slice("scenarios/".length) === `${base}.yaml`);
  if (found.length !== 1) throw new Error(found.length ? `${which}: more than one scenario — ${found.join(", ")}` : `${which}: no such scenario in ${dir}/scenarios`);
  const run = runScenario(m, parseScenario(files[found[0]!]!, found[0], (p) => files[`scenarios/${p}`]), { kind: "fifo" });
  const view = { open: opened(m, args), fold: !args.includes("--unfold"), ignored: args.includes("--ignored") };
  process.stdout.write(sequenceToMermaid(sequenceOf(m, run.world.log, view, run.marks)));
  return 0;
}
