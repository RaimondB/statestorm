/**
 * The log is the single source of truth for a run (R17). Every view, every current state
 * and every assertion is derived from it, which is what makes time travel a matter of
 * reading fewer entries.
 */
import type { Json } from "./types.ts";

export interface Base {
  seq: number;
  /** Simulated clock, ms since epoch. */
  at: number;
  /** `seq` of the entry that caused this one; 0 for something a person did (R18). */
  cause: number;
}

export type LogEntry =
  | (Base & { kind: "command"; instance: string; name: string; payload: Record<string, Json>; redelivery?: boolean })
  /** A keyed command the instance had already applied — correct behaviour, not a fault. */
  | (Base & { kind: "duplicate"; instance: string; name: string; identity: string })
  | (Base & { kind: "created"; instance: string; state: string })
  | (Base & { kind: "transition"; instance: string; from: string; to: string; via: string; internal?: boolean })
  | (Base & { kind: "event"; instance: string; event: string; payload: Record<string, Json> })
  /** done.<State> — an internal signal, *not* a domain event (ADR 0005 §6). */
  | (Base & { kind: "signal"; instance: string; signal: string })
  | (Base & { kind: "timer"; instance: string; label: string; state: string })
  | (Base & { kind: "tally"; instance: string; rel: string; trigger: string; before: string; after: string })
  | (Base & { kind: "rejected"; instance: string; name: string; chain: Rejection[] })
  | (Base & { kind: "unhandled"; instance: string; name: string; reason: string })
  /** A broadcast this instance had no answer to — expected, not a fault (ADR 0007 §5). */
  | (Base & { kind: "ignored"; instance: string; name: string; reason: string; chain?: Rejection[] })
  | (Base & { kind: "policy"; instance: string; from: string; to: string; via: string; on: string; internal?: boolean })
  | (Base & { kind: "clock"; from: number; to: number })
  | (Base & { kind: "finding"; severity: "info" | "warning" | "error"; message: string; instance?: string });

/** One link in the rejection chain a command leaves as it bubbles outward (R21). */
export interface Rejection {
  state: string;
  transition: string;
  guard: string;
  /** The values that guard actually saw. */
  values: string;
  /** Set when the guard itself could not be evaluated — a model error, reported loudly. */
  error?: string;
}

export function describe(e: LogEntry): string {
  switch (e.kind) {
    case "command": return `${e.instance} ← ${e.name}${payload(e.payload)}${e.redelivery ? "  [redelivered]" : ""}`;
    case "duplicate": return `${e.instance} had already applied ${e.identity} — repeat ignored`;
    case "created": return `${e.instance} created in ${e.state}`;
    case "transition": return e.internal ? `${e.instance}: stayed in ${e.to}` : `${e.instance}: ${e.from} → ${e.to}`;
    case "event": return `${e.instance} raised ${e.event}${payload(e.payload)}`;
    case "signal": return `${e.instance} completed ${e.signal.replace(/^done\./, "")} (${e.signal})`;
    case "timer": return `${e.instance} ${e.label} deadline on ${e.state} fell due`;
    case "tally": return `${e.instance} children ${e.rel}: ${e.trigger} (${e.before} → ${e.after})`;
    case "rejected":
      return `${e.instance} refused ${e.name}: ` +
        e.chain.map((r) => `${r.state} wanted ${r.error ? `[${r.error}]` : `\`${r.guard}\` with ${r.values}`}`).join("; ");
    case "unhandled": return `${e.instance} had no answer to ${e.name} — ${e.reason}`;
    case "ignored": return `${e.instance} ignored ${e.name} — ${e.reason}`;
    case "policy": return e.internal ? `${e.instance} on ${e.on}: stayed in ${e.to}` : `${e.instance} on ${e.on}: ${e.from} → ${e.to}`;
    case "clock": return `clock moved ${new Date(e.from).toISOString()} → ${new Date(e.to).toISOString()}`;
    case "finding": return `${e.severity}: ${e.message}`;
  }
}

function payload(p: Record<string, Json>): string {
  const keys = Object.keys(p);
  if (keys.length === 0) return "";
  return `{${keys.map((k) => `${k}: ${JSON.stringify(p[k])}`).join(", ")}}`;
}
