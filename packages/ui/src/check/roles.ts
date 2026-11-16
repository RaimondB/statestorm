/**
 * ADR 0027 §5: the events that move something worked in another role — read from runs. An event's
 * owner is the role sending the input at the root of its causes; what it moved is worked in the role
 * of its type, or of its nearest parent's.
 */
import { roleOfCommand, roleOfType, type Json, type LogEntry, type Model, type World } from "@statestorm/kernel";

export interface Crossing {
  /** What was sent: the command, and the `event` of its payload when it has one. */
  input: string;
  owner: string;
  /** The type that moved, the states it moved to, and the role it is worked in. */
  moved: string;
  to: string[];
  movedRole: string;
  /** Scenario files it happened in. */
  scenarios: string[];
}

export function crossings(model: Model, runs: { file: string; world: World }[]): Crossing[] {
  const found = new Map<string, Crossing>();
  for (const { file, world } of runs) {
    const bySeq = new Map<number, LogEntry>(world.log.map((e) => [e.seq, e]));
    const roleOfInstance = (key: string): string | undefined => {
      const seen = new Set<string>();
      for (let k: string | undefined = key; k && !seen.has(k); k = world.aggregates[k]?.parent?.key) {
        seen.add(k);
        const r = roleOfType(model, k.slice(0, k.indexOf("#")));
        if (r) return r.name;
      }
      return undefined;
    };
    const owners = new Map<number, string | undefined>();
    const ownerOf = (e: LogEntry): { owner: string; input: string } | undefined => {
      let root = e;
      for (let i = 0; i < 1000 && root.cause !== 0; i++) { const up = bySeq.get(root.cause); if (!up) break; root = up; }
      if (root.kind !== "command") return undefined;
      const type = root.instance.slice(0, root.instance.indexOf("#"));
      if (!owners.has(root.seq)) owners.set(root.seq, roleOfCommand(model, type, root.name, root.payload)?.name);
      const owner = owners.get(root.seq);
      const event = (root.payload as Record<string, Json>).event;
      return owner ? { owner, input: `${type}.${root.name}${typeof event === "string" ? ` ${event}` : ""}` } : undefined;
    };
    // Per input, what it moved; an activity rolling up because its task moved is not counted again.
    const movedBy = new Map<number, { by: { owner: string; input: string }; moves: { key: string; to: string }[] }>();
    for (const e of world.log) {
      if (e.kind !== "transition" || e.internal) continue;
      const by = ownerOf(e);
      if (!by) continue;
      let root: LogEntry = e;
      for (let i = 0; i < 1000 && root.cause !== 0; i++) { const up = bySeq.get(root.cause); if (!up) break; root = up; }
      const m = movedBy.get(root.seq) ?? (movedBy.set(root.seq, { by, moves: [] }), movedBy.get(root.seq)!);
      m.moves.push({ key: e.instance, to: e.to.split(".").pop()! });
    }
    const ancestorsOf = (key: string): Set<string> => {
      const out = new Set<string>();
      for (let k = world.aggregates[key]?.parent?.key; k && !out.has(k); k = world.aggregates[k]?.parent?.key) out.add(k);
      return out;
    };
    for (const { by, moves } of movedBy.values()) {
      const keys = new Set(moves.map((x) => x.key));
      const above = new Set([...keys].flatMap((k) => [...ancestorsOf(k)]));
      for (const mv of moves) {
        if (above.has(mv.key)) continue;
        const movedRole = roleOfInstance(mv.key);
        if (!movedRole || movedRole === by.owner) continue;
        const moved = mv.key.slice(0, mv.key.indexOf("#"));
        const key = `${by.input}|${moved}`;
        const c = found.get(key) ?? (found.set(key, { input: by.input, owner: by.owner, moved, to: [], movedRole, scenarios: [] }), found.get(key)!);
        if (!c.to.includes(mv.to)) c.to.push(mv.to);
        if (!c.scenarios.includes(file)) c.scenarios.push(file);
      }
    }
  }
  return [...found.values()].sort((a, b) => a.owner.localeCompare(b.owner) || a.input.localeCompare(b.input) || a.moved.localeCompare(b.moved));
}
