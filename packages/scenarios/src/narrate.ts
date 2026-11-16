/** The trace, rendered for reading aloud (R27). Indentation follows causation (R18). */
import { describe, type LogEntry, type World } from "@statestorm/kernel";

const GLYPH: Record<LogEntry["kind"], string> = {
  command: "▸", created: "✱", transition: "●", event: "◆", signal: "✓",
  timer: "⏱", tally: "∑", rejected: "✗", unhandled: "⚠", policy: "◇",
  clock: "—", finding: "!", duplicate: "⟳", ignored: "·",
};

/** How far down a causation chain each entry sits, for indenting a trace (R18). */
export function depths(log: LogEntry[]): Map<number, number> {
  const bySeq = new Map(log.map((e) => [e.seq, e]));
  const depth = new Map<number, number>();
  for (const e of log) {
    let d = 0;
    let cause = e.cause;
    const guard = new Set<number>();
    while (cause > 0 && !guard.has(cause)) {
      guard.add(cause);
      d++;
      cause = bySeq.get(cause)?.cause ?? 0;
    }
    depth.set(e.seq, Math.min(d, 8));
  }
  return depth;
}

export function narrate(world: World, startedAt = world.log[0]?.at ?? 0): string[] {
  const depth = depths(world.log);
  return world.log.map((e) => {
    const mins = Math.round((e.at - startedAt) / 60000);
    const clock = mins >= 1440 ? `d+${Math.floor(mins / 1440)}`.padEnd(6) : `${mins}m`.padEnd(6);
    const indent = "  ".repeat(depth.get(e.seq) ?? 0);
    return `${String(e.seq).padStart(3)} ${clock} ${GLYPH[e.kind]} ${indent}${describe(e)}`;
  });
}
