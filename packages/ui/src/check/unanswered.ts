/**
 * Commands no rule answered (MC-17): in the scenario runs, a command an instance did not handle
 * in the state it was in, or refused because no guard held, or sent to an instance that does not
 * exist. Each is a message lost — or a no-op the model should say (`Name: {}`) so that it is a
 * decision. A redelivered command is left out (a repeat is expected, ADR 0006), and so is a
 * refusal a scenario asserts (`rejected:`).
 */
import type { LogEntry } from "@statestorm/kernel";

export interface Unanswered {
  kind: "unhandled" | "rejected";
  type: string;
  name: string;
  /** Where it was not answered: the instance's state, or "no such instance". */
  where: string;
  /** One occurrence, as the log says why. */
  why: string;
  scenarios: string[];
}

/** `expected`: `<instance key> <command>` of every refusal a scenario asserts. */
export function unanswered(runs: { file: string; log: LogEntry[] }[], expected: Set<string> = new Set()): Unanswered[] {
  const found = new Map<string, Unanswered>();
  for (const { file, log } of runs) {
    const bySeq = new Map(log.map((e) => [e.seq, e]));
    for (const e of log) {
      if (e.kind !== "unhandled" && e.kind !== "rejected") continue;
      const cause = bySeq.get(e.cause);
      if (cause?.kind === "command" && cause.redelivery) continue;
      if (e.kind === "rejected" && expected.has(`${e.instance} ${e.name}`)) continue;
      const type = e.instance.slice(0, e.instance.indexOf("#"));
      let where: string;
      let why: string;
      if (e.kind === "unhandled") {
        where = /^no such instance/.test(e.reason) ? "no such instance" : (/^nothing in (\S+)/.exec(e.reason)?.[1] ?? e.reason);
        why = e.reason;
      } else {
        where = [...new Set(e.chain.map((c) => c.state))].join(", ");
        why = e.chain.map((c) => (c.error ? `[${c.error}]` : `\`${c.guard}\` with ${c.values}`)).join("; ");
      }
      const key = `${e.kind} ${type} ${e.name} ${where}`;
      const hit = found.get(key) ?? { kind: e.kind, type, name: e.name, where, why: `${e.instance}: ${why}`, scenarios: [] };
      const stem = file.replace(/\.yaml$/, "");
      if (!hit.scenarios.includes(stem)) hit.scenarios.push(stem);
      found.set(key, hit);
    }
  }
  return [...found.values()].sort((a, b) => b.scenarios.length - a.scenarios.length || a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}
