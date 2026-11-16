import type { LogEntry } from "@statestorm/kernel";

export const GLYPH: Record<LogEntry["kind"], string> = {
  command: "▸", created: "✱", transition: "●", event: "◆", signal: "✓",
  timer: "◔", tally: "∑", rejected: "✗", unhandled: "⚠", policy: "◇",
  clock: "—", finding: "!", duplicate: "⟳", ignored: "·",
};

/** Simulated wall time, to the minute — the clock a workshop talks about. */
export function clock(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace("T", " ");
}

/** Time since the run started, as the trace prints it. */
export function offset(at: number, start: number): string {
  const mins = Math.round((at - start) / 60000);
  if (mins === 0) return "0";
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  return [d ? `${d}d` : "", h ? `${h}h` : "", m ? `${m}m` : ""].filter(Boolean).join(" ");
}

export function compact(data: Record<string, unknown>): string {
  return Object.entries(data).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
}
