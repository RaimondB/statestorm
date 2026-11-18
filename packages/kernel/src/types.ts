/** Core model and runtime types. See docs/design.md §3 and ADR 0005. */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** A state is addressed by a dotted path from the root — ADR 0005 §7. No relative refs. */
export type StatePath = string[];

/**
 * An active *configuration*: the set of root-to-leaf paths that are active together.
 * v1 always produces exactly one path, but the type is a set so that parallel regions
 * (Q10) are an extension rather than a re-representation — ADR 0005 §1.
 */
export type Configuration = StatePath[];

export interface FieldDef {
  /** A scalar, or — ADR 0012 §8 — `value`: the field holds one value object, of `value`; or —
   *  ADR 0015 — `list`: a set of them, one per `key`, changed only by `put:` or replaced whole. */
  type: "number" | "string" | "boolean" | "value" | "list";
  value?: string;
  /** `list` only: the value object's field that tells its rows apart. */
  key?: string;
  default: Json;
}

/** One field of a value object, or of a command's declared payload (ADR 0012 §8). */
export interface ShapeField {
  /** number, string, boolean — or the name of a value object. */
  type: string;
  optional: boolean;
  /** A list of them: only in a payload, never in a value's or an aggregate's fields. */
  list: boolean;
}

/** A package (a DDD module): a name, what it is for, and the types declared in it. */
export interface PackageDef {
  name: string;
  note?: string;
  types: string[];
  /** ADR 0016: the ids of the domain's rules it implements. */
  why?: string[];
}

/** ADR 0018, 0020 §4: a command an external system sends — narrowed, perhaps, by its payload. */
export interface SystemSendDef {
  type: string;
  command: string;
  /** The sub-system of the external system that sends it (ADR 0020 §3). */
  subsystem: string;
  /** Sent only when each field's value is one of these (ADR 0020 §4). */
  where?: Record<string, string[]>;
}

/** ADR 0018: a software system — ours, made of sub-systems, or one outside the model. */
export interface SystemDef {
  name: string;
  note?: string;
  external: boolean;
  /** ADR 0020 §1: the larger scope of the landscape it belongs to. */
  domain?: string;
  /** External only: the commands it sends into the model — said on its sub-systems, gathered here. */
  sends: SystemSendDef[];
  /** External only: the events of the model it is told. */
  receives: string[];
  why?: string[];
}

/**
 * ADR 0018: a sub-system (a C4 container): packages, in one system and one bounded context. An
 * external system's parts are sub-systems too (ADR 0020 §2–3): packages it runs for the model, and
 * what each part sends and receives.
 */
export interface SubsystemDef {
  name: string;
  system: string;
  context: string;
  packages: string[];
  external?: boolean;
  sends?: SystemSendDef[];
  receives?: string[];
  /** ADR 0027: the roles it plays — it sends and receives what they do. */
  plays?: string[];
  /** ADR 0031: the events it receives only when raised with these values — by event, then field. */
  receivesWhere?: Record<string, Record<string, string[]>>;
  /** ADR 0030: what a part of our own works out itself, which the model does not run — a scenario sends the result in its name. */
  computes?: SystemSendDef[];
  note?: string;
  why?: string[];
}

/**
 * ADR 0027: a role — a part of the landscape defined by what is worked in it and what it sends, its
 * contract; external sub-systems play it, and another could take its place.
 */
export interface RoleDef {
  name: string;
  note?: string;
  /** Types worked in this role, with their subtypes — and the tasks their instances hold. */
  works: string[];
  sends: SystemSendDef[];
  receives: string[];
  why?: string[];
}

/** ADR 0018: a bounded context — a grouping of sub-systems, which may span systems. */
export interface ContextDef {
  name: string;
  note?: string;
  team?: string;
  why?: string[];
}

export const RELATION_PATTERNS = [
  "customer-supplier", "conformist", "anticorruption-layer", "open-host-service",
  "published-language", "shared-kernel", "partnership", "separate-ways",
] as const;

/** ADR 0018 §3: a DDD pattern between two systems or contexts, declared — never derived. */
export interface RelationDef {
  upstream: string;
  downstream: string;
  pattern: (typeof RELATION_PATTERNS)[number];
  note?: string;
  why?: string[];
}

/** ADR 0020 §1: a domain — a larger scope of the landscape, a group of systems. */
export interface DomainDef {
  name: string;
  note?: string;
  why?: string[];
}

export interface SystemsDef {
  systems: SystemDef[];
  /** Every sub-system, ours and the external systems' parts. */
  subsystems: SubsystemDef[];
  /** Every domain a system names, declared or implied. */
  domains: DomainDef[];
  /** Every context a sub-system or an external system is in, declared or implied. */
  contexts: ContextDef[];
  relations: RelationDef[];
  /** ADR 0027: the roles, whoever plays them. */
  roles: RoleDef[];
}

/** ADR 0012 §8: no identity, no lifecycle — a named, unchangeable set of fields. */
export interface ValueDef {
  name: string;
  fields: Record<string, ShapeField>;
}

export interface ChildRelDef {
  /** Aggregate type of the children — or an abstract type, standing for every subclass
   *  (ADR 0009). */
  type: string;
  /** The type that declared the relation. When that type is abstract the parent's own type
   *  is not fixed, so `via` must yield the parent's full key, `Type#id` (ADR 0009 §3). */
  declaredOn: string;
  /**
   * ADR 0011: the children fall into declared classes by one of their data fields — a task's
   * `stage` — and rules read counts per class (`tasks.stage.final.in.failed`).
   */
  classify?: { by: string; values: string[] };
  /** Expression over the child's creating command that yields the parent's id. */
  via: string;
}

/**
 * A pointer to another aggregate instance, by id — ADR 0007. Set once, from the creating
 * command, like a parent's `via:`. The kernel keeps the reverse index (who points at X), so
 * the instance pointed at never has to know who refers to it.
 */
export interface RefDef {
  /** Aggregate type of the instance pointed at. */
  type: string;
  /** Expression over the creating command that yields the id. */
  via: string;
}

export interface EmitDef {
  event: string;
  /** String values are templates — literal text with `${expr}` holes. Other scalars
   *  pass through untouched, so `amount: 3` stays the number 3. */
  payload: Record<string, Json>;
}

export interface CommandDef {
  /** Template resolving to `Type#id.Name` or `Type.Name`. */
  target: string;
  payload: Record<string, Json>;
}

export interface TransitionDef {
  /** Human-readable origin, used in the rejection chain (R21). */
  id: string;
  /**
   * Expression yielding this command's identity. Delivery is at-least-once, so a command
   * carrying a key that the instance has already applied is recognised as a repeat rather
   * than applied twice. Omit it when the transition is *naturally* idempotent — when a
   * repeat lands in a state where nothing handles it (ADR 0006).
   */
  idempotency?: string;
  /** State that owns this transition — the bubbling level it was found at. */
  owner: StatePath;
  guard?: string;
  assign: Record<string, string>;
  /** ADR 0015: list field -> the row to put into it (value field -> expression), replacing the
   *  row with the same key or adding it — so a repeat changes nothing. */
  put: Record<string, Record<string, string>>;
  target?: string;
  emit: EmitDef[];
  command?: CommandDef;
  /** ADR 0012: commands to this instance's own entities, settled in the same step. */
  send: SendDef[];
  /** ADR 0012 §8 / Q16: what the command must carry — a value object's name for the whole
   *  payload, or fields. Checked before the transition is applied. */
  takes?: { value: string } | { fields: Record<string, ShapeField> };
  /** Policies only: expression yielding an array; the command is issued per element. */
  forEach?: string;
  /** ADR 0026: how `forEach` is walked — more lists beside it, in an order, only some items, in pairs. */
  walk?: Walk;
  /** Set when the rule was declared on an abstract ancestor and inherited (ADR 0008). */
  inheritedFrom?: string;
  /** ADR 0016: the ids of the domain's rules it implements; an inherited rule keeps its own. */
  why?: string[];
  /**
   * Policies only: issue the command to every instance of `type` whose reference `ref`
   * points at the aggregate that raised the event — ADR 0007. Delivered as a *broadcast*:
   * a target with no answer ignores it, and the ignoring is logged.
   */
  forEachReferrer?: {
    type: string;
    ref: string;
    /** Template naming the instance pointed at, when it is not the event's raiser — e.g. a
     *  handling's event about `${event.sample}` reaching what points at that sample (ADR 0007 §8). */
    of?: string;
  };
}

export type ChildTriggerKind =
  | "all_final"
  | "first_entering"
  | "last_leaving"
  | "any_in"
  | "none_in";

export interface ChildTrigger {
  raw: string;
  rel: string;
  kind: ChildTriggerKind;
  /**
   * ADR 0006 §4. A *predicate* depends only on the children's current states, so it is
   * order- and duplicate-insensitive: it is evaluated on entry to its state and whenever the
   * tally changes, and fires once per occupancy. An *edge* is a moment in history, so it can
   * legitimately pass unobserved — which is why driving a state change from one is a lint.
   */
  form: "predicate" | "edge";
  /** Dotted state path the quantifier is about; absent for `all_final`. */
  state?: string;
  /** ADR 0004 §3: universal quantifiers are false over an empty collection by default. */
  allowEmpty: boolean;
}

export interface TimerDef {
  durationMs: number;
  /** ADR 0014: the deadline is read from this data field when the state is entered — a
   *  duration such as `7d`, copied onto the instance when it was planned. */
  field?: string;
  label: string;
  transition: TransitionDef;
}

export interface StateDef {
  name: string;
  path: StatePath;
  final: boolean;
  initial?: string;
  states: Record<string, StateDef>;
  /** Command (aggregate) or event (policy) name -> candidates in declaration order. */
  on: Record<string, TransitionDef[]>;
  onChildren: { trigger: ChildTrigger; transition: TransitionDef }[];
  /** Reaction to this composite completing — the done.<State> signal, ADR 0005 §6. */
  onDone?: TransitionDef;
  after: TimerDef[];
  emitOnEntry: EmitDef[];
  emitOnExit: EmitDef[];
  entryCommand?: CommandDef;
  /** ADR 0016: the ids of the domain's rules it implements, as written on it (not inherited). */
  why?: string[];
}

/**
 * ADR 0012: what an owner sends one of its own entities — to create it, or to pass a command
 * on. `to` names one (`Type#id.Command`, a template), optionally once per item of `forEach`;
 * `children` names a relation, and every child in it gets `command`.
 */
export interface SendDef {
  to?: string;
  children?: string;
  command?: string;
  payload: Record<string, Json>;
  forEach?: string;
  /** ADR 0026: as a transition's. */
  walk?: Walk;
}

/**
 * ADR 0026: a walk over lists in order. `for_each: [a, b]` walks both lists as one (`also`: the
 * lists after the first); `order: <field>` sorts the items by that number, smallest first;
 * `where: <expression>` keeps the items it holds for (`item` is the one asked about); `pairs: true`
 * issues one command per two items in a row, with `previous` beside `item`.
 */
export interface Walk {
  also?: string[];
  order?: string;
  where?: string;
  pairs?: boolean;
}

export interface MachineDef {
  name: string;
  kind: "aggregate" | "policy";
  /** ADR 0012: an aggregate is a consistency boundary; an entity lives inside one, owned
   *  through a relation, and is reached only through its aggregate. Policies: "aggregate". */
  role: "aggregate" | "entity";
  /** ADR 0008: an abstract type is a skeleton for subclasses and has no instances. */
  abstract: boolean;
  /** The chain of types this one extends, nearest first. */
  ancestors: string[];
  initial: string;
  states: Record<string, StateDef>;
  data: Record<string, FieldDef>;
  children: Record<string, ChildRelDef>;
  references: Record<string, RefDef>;
  /** Commands that may bring an instance into existence. Anything else to a missing
   *  instance is a finding, not an implicit create (R22). */
  creators: string[];
  /** Policies: expression identifying the instance — ADR 0003. */
  correlate?: string;
  /** ADR 0016: the ids of the domain's rules it implements, as written on it (not inherited). */
  why?: string[];
  /** Every child trigger anywhere in the machine, with the state that owns it. */
  allChildTriggers: { state: StatePath; trigger: ChildTrigger }[];
}

export interface ModelFinding {
  severity: "warning" | "error";
  message: string;
}

export interface Model {
  context: string;
  aggregates: Record<string, MachineDef>;
  /** ADR 0012 §8: the value objects. */
  values: Record<string, ValueDef>;
  /** Modules: which types belong together, in the order declared — documentation of where
   *  ownership sits, checked by name (ADR 0013). */
  packages: PackageDef[];
  policies: Record<string, MachineDef>;
  /** Things the loader noticed that are legal but suspect — see ADR 0006 §5. */
  findings: ModelFinding[];
  /** How the overview view lays this model's instances out. Interpreted, and validated, by
   *  the view; the kernel only carries it. */
  overview?: Json;
  /** The model check's accepted coverage gaps (MC-3): `ignore: { <rule or state>: why }`. */
  coverage?: Json;
  /** ADR 0018: the systems, bounded contexts and sub-systems its types live in, when declared. */
  systems?: SystemsDef;
  /** ADR 0019: where each declared name came from, when the model is in several files —
   *  `aggregates.Order` → `model/orders.yaml`. */
  sources?: Record<string, string>;
}

export class ModelError extends Error {}
export class ExprError extends Error {}
