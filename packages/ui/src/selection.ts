/** What the inspector is looking at. Shared by every view (design §5). */
export type Selection =
  | { kind: "transition"; machine: string; id: string }
  | { kind: "state"; machine: string; ref: string }
  | { kind: "instance"; key: string }
  | { kind: "entry"; seq: number }
  /** A type or a package, picked in the structure: the inspector shows what the docs say of it. */
  | { kind: "type"; name: string }
  | { kind: "package"; name: string }
  /** A message of the sequence, or one an edge of the context map carries: an event, the command it
   *  became (`Type.Command`), the policy between — any of them. */
  | { kind: "message"; event?: string; command?: string; policy?: string }
  /** A part of the landscape (ADR 0018, ADR 0020): a sub-system is named with its system. */
  | { kind: "place"; level: "domain" | "system" | "subsystem" | "context"; name: string; system?: string }
  /** An edge of the context map: who tells whom what, and the patterns declared between them. */
  | { kind: "flow"; from: string; to: string; events: string[]; commands: string[]; patterns: string[] }
  | undefined;
