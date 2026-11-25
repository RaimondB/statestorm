/**
 * The overview: a read model of the world at frame *i*, drawn the way the business draws it —
 * instances, not types; a parent spanning its children; a sequence left to right; the events
 * that moved things, under what they moved.
 *
 * Most of it is inferred from the model, so it works without configuration:
 *   - instances nest under their parents (ADR 0004 relations);
 *   - an *association* — a type that declares references, like a handling (ADR 0007) — is not
 *     drawn; its parent shows it as a tally ("handlings · 2/3 done");
 *   - a type something points at (a sample) goes in a side lane;
 *   - an event sticky sits under the box that raised it, or — when the raiser is not drawn — under
 *     the deepest boxes the event changed, found by following causation through the log.
 *
 * The model's optional `overview:` section says only what cannot be inferred: which types are
 * the roots, which relations are sequences or bands, the label on each box, any further attributes
 * to show, what stands apart from the roots and what another box has taken over.
 */
import {
  isA, isFinalConfiguration, roleOfCommand, roleOfType, senderOfCommand, template,
  type Frame, type InstanceView, type Json, type LogEntry, type Model,
} from "@statestorm/kernel";

export type Placement = "auto" | "raised" | "triggered" | "none";

/** Colour families a box can take; each has a few tints, darkest first. */
export const FAMILIES = ["navy", "green", "blue", "teal", "purple", "amber", "grey"] as const;
export type Family = (typeof FAMILIES)[number];
/** Without configuration, a family by depth — what the first version drew. */
const DEPTH_FAMILIES: Family[] = ["navy", "green", "teal", "teal"];

export interface OverviewConfig {
  /** Types whose parentless instances are the top boxes. Default: every parentless instance. */
  roots?: string[];
  /** Types drawn in a lane above the roots, always, wherever they belong in the tree — what a
   *  reader should see first, like what the customer is told. */
  top: string[];
  /** Types summarised on their parent rather than drawn. Default: types that declare references. */
  hide: string[];
  /** Types neither drawn nor counted — bookkeeping a reader does not need here (the
   *  links that order a route's steps: the layout already shows them). */
  omit: string[];
  /** Types drawn in the side lane. Default: types that something references. */
  side: string[];
  /** `Type.relation` whose children are drawn left to right with arrows, in plan order. */
  sequence: string[];
  /** `Type.relation` whose children are drawn as a thin band between the parent and its other
   *  children, the first at the left end and the last at the right. */
  band: string[];
  /** Type (or abstract ancestor) -> label template, e.g. `"${origin} → ${destination}"`. */
  label: Record<string, string>;
  events: Placement;
  /** Event names (or `*` patterns) left out of the event lane — plumbing like `*Planned`. */
  hideEvents: string[];
  /** `events.of` (ADR 0023): only the events about these types — raised by one, or naming one in
   *  a reference — reach the event lane; the flow board's rule, so both views agree. */
  eventsOf?: string[];
  /** `events.show`: events shown however the rest of the configuration reads. */
  showEvents: string[];
  /** `events.asks`: what the model asks and waits on — drawn as a marker on the box it is asked in,
   *  open until one of `answered` happens to the same subject. */
  asks: Record<string, Ask>;
  /** `journey:` (ADR 0024) — what the Journey says beyond the overview: a label per type, read
   *  before the overview's, and the event fields shown on each event's row. */
  journey: { label: Record<string, string>; attributes: string[]; together?: string };
  /** What the reader chose to see (the overview's switch): the statuses only, with the asks, or every
   *  event the model raises — nothing hidden, the asks as plain events. */
  eventsMode?: EventsMode;
  /** `events.status`: a type whose instance an event opens holds that event's substatus — a
   *  Deviation, pending until resolved or confirmed. */
  eventStatus?: string;
  /** Any further fields a reader should see: read from a folded child's data and an event's payload,
   *  and shown with the sample they are about. Every one that has a value is shown, in this order. */
  attributes: string[];
  /** The same, but on a folded child only until it ends: what stops being true once it has. */
  attributesWhileOpen: string[];
  /** Types whose parentless instances stand apart from the roots: drawn in a lane of their own
   *  under them while they have something to show under them, and otherwise left out. */
  exceptions: string[];
  /** What the model calls that lane. */
  exceptionsTitle?: string;
  /** A data field naming the box that took this one over: it is no longer drawn, and what
   *  happened in it shows on that box. */
  takenOver?: string;
  /** Type (or abstract ancestor) -> colour family. A box without one takes its parent's
   *  family, one tint lighter, so a route's tasks look like the route. */
  color: Record<string, Family>;
  /** A link type saying which box follows which (`Link`, refs `before`/`after`): a
   *  sequence is then laid out in layers, so a merge draws as one — not in plan order. */
  follows?: { type: string; before: string; after: string };
  /** ADR 0034: further overviews of the same run, by name — each read on its own. */
  views?: Record<string, OverviewConfig>;
  /** ADR 0034 §2: a parentless type drawn under the instance its field names, while that exists. */
  under?: Record<string, { parent: string; by: string }>;
  /** ADR 0034 §3: a unit's badge names the main overview's roots that carry it. */
  badgesRoots?: boolean;
}

export type EventsMode = "statuses" | "requests" | "all";
export interface Ask { mark: string; icon: string; answered: string[] }

const KEYS = ["roots", "top", "flow", "journey", "hide", "omit", "side", "sequence", "band", "label", "events", "color", "follows", "attributes", "attributesWhileOpen", "exceptions", "takenOver", "views"];
/** A named view (ADR 0034 §1): the overview's keys, less what only the main one has, and its own two. */
const VIEW_KEYS = [...KEYS.filter((k) => !["flow", "journey", "views"].includes(k)), "under", "badges"];

/** Reads the model's `overview:` section, filling in what can be inferred. Every name is
 *  checked — a misspelt type or relation is an error, not a quietly missing box. */
export function overviewConfig(model: Model): { config: OverviewConfig; errors: string[] } {
  const raw = (model.overview ?? {}) as Json;
  const read = readOverview(model, raw, KEYS);
  if (read.errors.length > 0 && read.errors[0] === "overview: expected a block") return read;
  const views = (raw as Record<string, Json>).views;
  if (views === undefined) return read;
  const errors = [...read.errors];
  const named: Record<string, OverviewConfig> = {};
  if (views === null || typeof views !== "object" || Array.isArray(views)) errors.push("overview.views: expected name: { roots, … }");
  else for (const [name, body] of Object.entries(views)) {
    const v = readOverview(model, body, VIEW_KEYS);
    errors.push(...v.errors.map((e) => e.replace(/^overview([.:])/, `overview.views.${name}$1`)));
    named[name] = v.config;
  }
  return { config: { ...read.config, views: named }, errors };
}

function readOverview(model: Model, rawIn: Json, keys: string[]): { config: OverviewConfig; errors: string[] } {
  const errors: string[] = [];
  const raw = (rawIn ?? {}) as Record<string, Json>;
  if (typeof raw !== "object" || Array.isArray(raw) || raw === null) {
    return { config: defaults(model), errors: ["overview: expected a block"] };
  }
  for (const key of Object.keys(raw)) if (!keys.includes(key)) errors.push(`overview: unknown key \`${key}\` (expected ${keys.join(", ")})`);

  const types = (key: string): string[] | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    const list = (Array.isArray(v) ? v : [v]).map(String);
    for (const t of list) if (!model.aggregates[t]) errors.push(`overview.${key}: there is no aggregate called \`${t}\``);
    return list.filter((t) => model.aggregates[t]);
  };
  const relations = (key: string): string[] => {
    const v = raw[key];
    if (v === undefined) return [];
    const list = (Array.isArray(v) ? v : [v]).map(String);
    return list.filter((r) => {
      const [type, rel] = r.split(".");
      const def = type ? model.aggregates[type] : undefined;
      if (!def || !rel) { errors.push(`overview.${key}: \`${r}\` should be Type.relation`); return false; }
      if (!def.children[rel]) { errors.push(`overview.${key}: ${type} has no relation called \`${rel}\``); return false; }
      return true;
    });
  };

  const d = defaults(model);
  const label: Record<string, string> = {};
  if (raw.label !== undefined) {
    if (typeof raw.label !== "object" || Array.isArray(raw.label) || raw.label === null) errors.push("overview.label: expected Type: template");
    else {
      for (const [t, tpl] of Object.entries(raw.label)) {
        if (!model.aggregates[t]) errors.push(`overview.label: there is no aggregate called \`${t}\``);
        else label[t] = String(tpl);
      }
    }
  }
  const color: Record<string, Family> = {};
  if (raw.color !== undefined) {
    if (typeof raw.color !== "object" || Array.isArray(raw.color) || raw.color === null) errors.push("overview.color: expected Type: family");
    else {
      for (const [t, f] of Object.entries(raw.color)) {
        if (!model.aggregates[t]) errors.push(`overview.color: there is no aggregate called \`${t}\``);
        else if (!(FAMILIES as readonly string[]).includes(String(f))) errors.push(`overview.color.${t}: \`${f}\` — expected one of ${FAMILIES.join(", ")}`);
        else color[t] = String(f) as Family;
      }
    }
  }
  let follows: OverviewConfig["follows"];
  if (raw.follows !== undefined) {
    const f = raw.follows as Record<string, Json>;
    const t = model.aggregates[String(f?.type)];
    if (!t) errors.push(`overview.follows: there is no aggregate called \`${f?.type}\``);
    else {
      const missing = ["before", "after"].filter((k) => !t.references[String(f[k])]);
      if (missing.length) errors.push(`overview.follows: ${t.name} has no reference ${missing.map((k) => `\`${f[k]}\``).join(" or ")}`);
      else follows = { type: t.name, before: String(f.before), after: String(f.after) };
    }
  }
  const holdsField = (name: string) => Object.values(model.aggregates).some((a) => name in a.data);
  const fieldNames = (v: Json | undefined): string[] => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).map(String));
  const attributes = fieldNames(raw.attributes);
  const attributesWhileOpen = fieldNames(raw.attributesWhileOpen);
  for (const [key, list] of [["attributes", attributes], ["attributesWhileOpen", attributesWhileOpen]] as const) {
    for (const f of list) {
      if (!holdsField(f) && !eventFields(model).has(f)) errors.push(`overview.${key}: no aggregate or event has a field called \`${f}\``);
    }
  }
  // `journey: { label: { Type: template }, attributes: [field] }` — the Journey's own words (ADR 0024).
  const journey: OverviewConfig["journey"] = { label: {}, attributes: [] };
  if (raw.journey !== undefined) {
    const j = raw.journey as Record<string, Json>;
    if (j === null || typeof j !== "object" || Array.isArray(j)) errors.push("overview.journey: expected { label, attributes }");
    else {
      for (const key of Object.keys(j)) if (!["label", "attributes", "together"].includes(key)) errors.push(`overview.journey: unknown key \`${key}\` (expected label, attributes, together)`);
      if (j.together !== undefined) {
        if (!holdsField(String(j.together))) errors.push(`overview.journey.together: no aggregate has a field called \`${j.together}\``);
        else journey.together = String(j.together);
      }
      if (j.label !== undefined) {
        if (j.label === null || typeof j.label !== "object" || Array.isArray(j.label)) errors.push("overview.journey.label: expected Type: template");
        else for (const [t, tpl] of Object.entries(j.label)) {
          if (!model.aggregates[t]) errors.push(`overview.journey.label: there is no aggregate called \`${t}\``);
          else journey.label[t] = String(tpl);
        }
      }
      for (const f of fieldNames(j.attributes)) {
        if (!holdsField(f) && !eventFields(model).has(f)) errors.push(`overview.journey.attributes: no aggregate or event has a field called \`${f}\``);
        else journey.attributes.push(f);
      }
    }
  }
  const takenOver = raw.takenOver === undefined ? undefined : String(raw.takenOver);
  if (takenOver !== undefined && !holdsField(takenOver)) errors.push(`overview.takenOver: no aggregate has a field called \`${takenOver}\``);
  // `exceptions: [Type]`, or `exceptions: { types: [Type], title: "what the model calls them" }`.
  const rawExceptions = raw.exceptions;
  const titled = rawExceptions !== null && typeof rawExceptions === "object" && !Array.isArray(rawExceptions);
  if (titled) {
    for (const key of Object.keys(rawExceptions)) if (!["types", "title"].includes(key)) errors.push(`overview.exceptions: unknown key \`${key}\` (expected types, title)`);
  }
  const exceptionTypes = (titled ? fieldNames(rawExceptions.types) : fieldNames(rawExceptions)).filter((t) => {
    if (!model.aggregates[t]) errors.push(`overview.exceptions: there is no aggregate called \`${t}\``);
    return !!model.aggregates[t];
  });
  const exceptionsTitle = titled && rawExceptions.title !== undefined ? String(rawExceptions.title) : undefined;
  let events: Placement = "auto";
  let eventStatus: string | undefined;
  let hideEvents: string[] = [];
  let eventsOf: string[] | undefined;
  const showEvents: string[] = [];
  const asks: Record<string, Ask> = {};
  const placement = (v: Json | undefined, where: string) => {
    if (v === undefined) return;
    if (["auto", "raised", "triggered", "none"].includes(String(v))) events = String(v) as Placement;
    else errors.push(`${where}: \`${v}\` — expected auto, raised, triggered or none`);
  };
  if (raw.events !== null && typeof raw.events === "object" && !Array.isArray(raw.events)) {
    const ev = raw.events as Record<string, Json>;
    for (const key of Object.keys(ev)) if (!["place", "hide", "status", "of", "show", "asks"].includes(key)) errors.push(`overview.events: unknown key \`${key}\` (expected place, hide, status, of, show, asks)`);
    if (ev.status !== undefined) {
      if (!model.aggregates[String(ev.status)]) errors.push(`overview.events.status: there is no aggregate called \`${ev.status}\``);
      else eventStatus = String(ev.status);
    }
    placement(ev.place, "overview.events.place");
    const known = eventNames(model);
    for (const pattern of (Array.isArray(ev.hide) ? ev.hide : ev.hide === undefined ? [] : [ev.hide]).map(String)) {
      if (!known.some((n) => globMatch(pattern, n))) errors.push(`overview.events.hide: \`${pattern}\` matches no event the model raises`);
      else hideEvents.push(pattern);
    }
    if (ev.of !== undefined) {
      eventsOf = fieldNames(ev.of).filter((t) => {
        if (!model.aggregates[t]) errors.push(`overview.events.of: there is no aggregate called \`${t}\``);
        return !!model.aggregates[t];
      });
    }
    for (const pattern of (Array.isArray(ev.show) ? ev.show : ev.show === undefined ? [] : [ev.show]).map(String)) {
      if (!known.some((n) => globMatch(pattern, n))) errors.push(`overview.events.show: \`${pattern}\` matches no event the model raises`);
      else showEvents.push(pattern);
    }
    if (ev.asks !== undefined) {
      if (ev.asks === null || typeof ev.asks !== "object" || Array.isArray(ev.asks)) errors.push("overview.events.asks: a mapping, event → { mark, icon, answered }");
      else for (const [event, body] of Object.entries(ev.asks as Record<string, Json>)) {
        const where = `overview.events.asks.${event}`;
        if (!known.includes(event)) { errors.push(`${where}: no event the model raises is called \`${event}\``); continue; }
        const b = (body ?? {}) as Record<string, Json>;
        if (typeof b !== "object" || Array.isArray(b)) { errors.push(`${where}: { mark, icon, answered }`); continue; }
        for (const k of Object.keys(b)) if (!["mark", "icon", "answered"].includes(k)) errors.push(`${where}: unknown key \`${k}\` (expected mark, icon, answered)`);
        const answered = (Array.isArray(b.answered) ? b.answered : b.answered === undefined ? [] : [b.answered]).map(String);
        for (const a of answered) if (!known.includes(a)) errors.push(`${where}.answered: no event the model raises is called \`${a}\``);
        asks[event] = { mark: b.mark !== undefined ? String(b.mark) : spoken(event).toLowerCase(), icon: b.icon !== undefined ? String(b.icon) : "?", answered: answered.filter((a) => known.includes(a)) };
      }
    }
  } else placement(raw.events, "overview.events");
  // `under: { Type: { parent: Type, by: field } }` (ADR 0034 §2).
  const under: Record<string, { parent: string; by: string }> = {};
  if (raw.under !== undefined) {
    if (raw.under === null || typeof raw.under !== "object" || Array.isArray(raw.under)) errors.push("overview.under: expected Type: { parent, by }");
    else for (const [t, body] of Object.entries(raw.under as Record<string, Json>)) {
      const b = (body ?? {}) as Record<string, Json>;
      const def = model.aggregates[t];
      const parent = model.aggregates[String(b.parent)];
      if (!def) { errors.push(`overview.under: there is no aggregate called \`${t}\``); continue; }
      if (def.role === "entity") { errors.push(`overview.under.${t}: an entity has its parent already`); continue; }
      if (!parent) { errors.push(`overview.under.${t}: there is no aggregate called \`${b.parent}\``); continue; }
      if (!(String(b.by) in def.data)) { errors.push(`overview.under.${t}: ${t} has no field \`${b.by}\``); continue; }
      under[t] = { parent: parent.name, by: String(b.by) };
    }
    // A nesting that comes back to where it started would put a box inside itself.
    for (const start of Object.keys(under)) {
      const seen = new Set([start]);
      for (let at = under[start]?.parent; at; at = under[at]?.parent) {
        if (seen.has(at)) { errors.push(`overview.under.${start}: the nesting loops back to ${at}`); delete under[start]; break; }
        seen.add(at);
      }
    }
  }
  let badgesRoots = false;
  if (raw.badges !== undefined) {
    if (String(raw.badges) === "roots") badgesRoots = true;
    else errors.push(`overview.badges: \`${raw.badges}\` — expected roots`);
  }
  return {
    config: {
      roots: types("roots"),
      top: types("top") ?? [],
      hide: types("hide") ?? d.hide,
      omit: types("omit") ?? [],
      side: types("side") ?? d.side,
      sequence: relations("sequence"),
      band: relations("band"),
      label,
      events,
      hideEvents,
      journey,
      ...(eventsOf ? { eventsOf } : {}),
      showEvents,
      asks,
      ...(eventStatus ? { eventStatus } : {}),
      attributes,
      attributesWhileOpen,
      exceptions: exceptionTypes,
      ...(exceptionsTitle ? { exceptionsTitle } : {}),
      ...(takenOver ? { takenOver } : {}),
      color,
      ...(follows ? { follows } : {}),
      ...(Object.keys(under).length ? { under } : {}),
      ...(badgesRoots ? { badgesRoots } : {}),
    },
    errors,
  };
}

/** Everything any aggregate in the model can raise. */
function emits(model: Model): Model["aggregates"][string]["states"][string]["emitOnEntry"] {
  const out: ReturnType<typeof emits> = [];
  const walk = (states: Model["aggregates"][string]["states"]) => {
    for (const st of Object.values(states)) {
      const rules = [...Object.values(st.on).flat(), ...st.onChildren.map((o) => o.transition), ...st.after.map((a) => a.transition), ...(st.onDone ? [st.onDone] : [])];
      for (const t of rules) out.push(...t.emit);
      out.push(...st.emitOnEntry, ...st.emitOnExit);
      walk(st.states);
    }
  };
  for (const a of Object.values(model.aggregates)) walk(a.states);
  return out;
}

/** Every event any aggregate in the model can raise. */
export function eventNames(model: Model): string[] {
  return [...new Set(emits(model).map((e) => e.event))];
}

function eventFields(model: Model): Set<string> {
  return new Set(emits(model).flatMap((e) => Object.keys(e.payload)));
}

/** `*Planned` matches `SiteTaskPlanned`; no other wildcard is needed yet. */
export function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return re.test(name);
}

function defaults(model: Model): OverviewConfig {
  const aggregates = Object.values(model.aggregates);
  return {
    top: [],
    omit: [],
    hide: aggregates.filter((a) => Object.keys(a.references).length > 0).map((a) => a.name),
    // What gets pointed at and belongs to nothing — samples, vehicles. A referenced type that is
    // also somebody's child (a step a link points at) is drawn under its parent.
    side: [...new Set(aggregates.flatMap((a) => Object.values(a.references).map((r) => r.type)))]
      .filter((t) => !aggregates.some((a) => Object.values(a.children).some((c) => isA(model, t, c.type)))),
    sequence: [],
    band: [],
    label: {},
    events: "auto",
    hideEvents: [],
    journey: { label: {}, attributes: [] },
    showEvents: [],
    asks: {},
    attributes: [],
    attributesWhileOpen: [],
    exceptions: [],
    color: {},
  };
}

// ---------------------------------------------------------------- the tree

export type Tone = "neutral" | "active" | "done" | "partial" | "failed" | "skipped" | "held";

export interface Box {
  key: string;
  machine: string;
  id: string;
  depth: number;
  label?: string;
  labelError?: string;
  /** The active configuration, innermost last: ["in_progress", "storing"]. */
  path: string[];
  final: boolean;
  tone: Tone;
  family: Family;
  /** 0 is the family's own colour; each inherited level is a tint lighter. */
  tint: number;
  /** Hidden children, by relation, counted by the top-level state each is in — so a tally
   *  says "✓1 ✗1", not "2/2 done" when one of the two failed. */
  summaries: {
    rel: string;
    total: number;
    finals: number;
    /** Per top-level state, and *which* — each folded child named by what it is about (its sample). */
    byState: { state: string; count: number; tone: Tone; items: Badge[] }[];
  }[];
  groups: {
    rel: string;
    mode: "row" | "sequence" | "band";
    children: Box[];
    /** A sequence with links between its boxes, laid out in layers: [[visit A, visit B], [run A, run B], [receipt], [analysis]]. */
    layers?: Box[][];
  }[];
  /** Unit keys this box's hidden associations point at — what travels through it. */
  carries: string[];
}

export interface Sticky {
  event: string;
  count: number;
  /** First occurrence, for travelling to it. */
  seq: number;
  raisers: string[];
  /** Who it happened to, named for a reader: the samples, not the internal instances. */
  badges: Badge[];
  /** Each time it happened: who raised it, the instance holding its substatus (`events.status`),
   *  and its further attributes (`attributes`). */
  occurrences: { raiser: string; seq: number; status?: string; note?: string }[];
  /** ADR 0027: the role that sent the input it came from, and the part that played it — when the
   *  model has roles and one sends it. */
  owner?: { role: string; family: Family; sender?: string };
  /** ADR 0027 §4: owned by another role than the one its box is worked in — from elsewhere. */
  foreign?: { boxRole: string };
  /** With `events.status`: who it happened to, grouped by where that occurrence now stands —
   *  a deviation pending, resolved or confirmed is a state of the status, not an event of its own. */
  statuses?: { state: string; tone: Tone; badges: Badge[] }[];
}

/** A small named pill: `S2`. `key` is what selecting it selects; `note` holds its further
 *  attributes, drawn beside the pill, not in it. */
export interface Badge { key: string; label: string; note?: string }

/** What a badge shows, as text. */
const badgeLook = (b: Badge) => b.label + (b.note ? `(${b.note})` : "");

/** The values of these fields, in plain words; undefined when there is none. */
function attributesIn(values: Record<string, Json> | undefined, fields: string[]): string | undefined {
  const found = fields.map((f) => values?.[f]).filter((v) => v !== undefined && v !== null && v !== "");
  return found.length > 0 ? [...new Set(found.map((v) => String(v).replace(/_/g, " ")))].join(" · ") : undefined;
}

/** Badges that share a note, in the order they first appear: a row each, the note said once. */
export function byNote(items: Badge[]): { note?: string; items: Badge[] }[] {
  const rows = new Map<string | undefined, Badge[]>();
  for (const b of items) (rows.get(b.note) ?? rows.set(b.note, []).get(b.note)!).push(b);
  return [...rows].map(([note, list]) => (note ? { note, items: list } : { items: list }));
}

/** A badge with its note beside it. */
const withNote = (b: Badge, note: string | undefined): Badge => (note ? { ...b, note } : b);

/**
 * How to name an instance on a badge. An association (a handling) is named by what it points at —
 * preferring something in the side lane, a sample — because "S7 haemolysed" is what a reader
 * wants, not "AnalysisHandling#R5-CHEM-run-S7".
 */
export function badgeOf(model: Model, frame: Frame, config: OverviewConfig, key: string): Badge {
  const inst = frame.instances[key];
  const targets = Object.values(inst?.refs ?? {});
  if (targets.length > 0) {
    const preferred = targets.find((t) => matches(model, t.slice(0, t.indexOf("#")), config.side)) ?? targets[0]!;
    return { key: preferred, label: preferred.slice(preferred.indexOf("#") + 1) };
  }
  return { key, label: key.slice(key.indexOf("#") + 1) };
}

export interface Overview {
  /** The lane above the roots (`top:`), in creation order. */
  top: Box[];
  roots: Box[];
  /** The lane under the roots: what stands apart from them (`exceptions:`). */
  exceptions: Box[];
  /** ADR 0039: a unit in the side lane says its type's `label:`, as a box does — empty, it says
   *  nothing — and takes its type's `color:` when the model names one. */
  side: Array<InstanceView & { label?: string; family?: Family }>;
  /** Parentless instances that are neither roots nor in the side lane — listed, not hidden. */
  others: InstanceView[];
  stickies: Record<string, Sticky[]>;
  /** The asks (`events.asks`) by the box they were asked in: open, or answered. */
  asks: Record<string, AskMark[]>;
}

/** One kind of ask on one box: each time it was asked, about whom, and what answered it, if anything has. */
export interface AskMark {
  event: string;
  mark: string;
  icon: string;
  occurrences: { seq: number; subject?: string; label: string; answer?: { event: string; seq: number } }[];
}

/** What the reader chose of the events, on top of the model's configuration. */
export function withEventsMode(config: OverviewConfig, mode: EventsMode): OverviewConfig {
  return { ...config, eventsMode: mode };
}

/** What a state is, judged by its name: the vocabulary every example happens to share. */
export function toneOf(path: string[], final: boolean): Tone {
  const leaf = path.join(".").toLowerCase();
  // Final, but neither a success nor a failure: no longer expected (a sample stopped upstream).
  if (/exclud|skip|left_behind|withdrawn|not_needed/.test(leaf)) return "skipped";
  if (/fail|reject|cancel|refus|escalat/.test(leaf)) return "failed";
  // Waiting for a person's decision — a deviation pending, a step it holds.
  if (/hold|pending/.test(leaf)) return "held";
  if (/partial/.test(leaf)) return "partial";
  if (final) return "done";
  if (/progress|started|open|fulfil|handling|assess|shipping|transit|staged|requested/.test(leaf)) return "active";
  return "neutral";
}

function matches(model: Model, type: string, list: string[]): boolean {
  return list.some((t) => isA(model, type, t));
}

export function labelFor(model: Model, inst: InstanceView, config: OverviewConfig): { label?: string; labelError?: string } {
  // The most specific template wins: the type itself, then its nearest ancestor.
  const lineage = [inst.machine, ...(model.aggregates[inst.machine]?.ancestors ?? [])];
  const tpl = lineage.map((t) => config.label[t]).find((x) => x !== undefined);
  if (tpl === undefined) return {};
  try {
    const id = inst.key.slice(inst.key.indexOf("#") + 1);
    const value = template(tpl, { vars: { ...inst.data, id, type: inst.machine }, active: new Set<string>() });
    return { label: typeof value === "string" ? value : JSON.stringify(value) };
  } catch (err) {
    return { labelError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A named view (ADR 0034), with its units' badges naming the main overview's roots that carry them
 * when it asks for that (`badges: roots`).
 */
export function buildView(model: Model, frame: Frame, log: LogEntry[], config: OverviewConfig, main: OverviewConfig): Overview {
  if (!config.badgesRoots) return buildOverview(model, frame, log, config);
  const carriers = new Map<string, string[]>();
  for (const root of buildOverview(model, frame, log, { ...main, events: "none" }).roots) {
    for (const unit of root.carries) (carriers.get(unit) ?? carriers.set(unit, []).get(unit)!).push(root.id);
  }
  return buildOverview(model, frame, log, config, carriers);
}

export function buildOverview(model: Model, frame: Frame, log: LogEntry[], config: OverviewConfig, carriers?: Map<string, string[]>): Overview {
  const all = Object.values(frame.instances).filter((i) => i.kind === "aggregate");
  // ADR 0034 §2: a parentless instance drawn under the one its field names, while that one exists.
  const placedUnder = new Map<string, { rel: string; key: string }>();
  if (config.under) {
    for (const inst of all) {
      if (inst.parent && frame.instances[inst.parent.key]) continue;
      const t = Object.keys(config.under).find((u) => isA(model, inst.machine, u));
      if (!t) continue;
      const { parent, by } = config.under[t]!;
      const id = inst.data[by];
      if (typeof id !== "string" || id === "") continue;
      const host = all.find((h) => h.key !== inst.key && h.key.slice(h.key.indexOf("#") + 1) === id && isA(model, h.machine, parent));
      if (host) placedUnder.set(inst.key, { rel: t, key: host.key });
    }
  }
  const parentOf = (i: InstanceView) => (i.parent && frame.instances[i.parent.key] ? i.parent : placedUnder.get(i.key));
  const childrenOf = new Map<string, InstanceView[]>();
  for (const inst of all) {
    const p = parentOf(inst);
    if (p) (childrenOf.get(p.key) ?? childrenOf.set(p.key, []).get(p.key)!).push(inst);
  }
  const onTop = (i: InstanceView) => matches(model, i.machine, config.top);
  const hidden = (i: InstanceView) => !onTop(i) && matches(model, i.machine, config.hide);
  const inSide = (i: InstanceView) => matches(model, i.machine, config.side);
  const isException = (i: InstanceView) => matches(model, i.machine, config.exceptions);

  const drawnParent = new Map<string, string | undefined>();
  const bandBoxes = new Set<string>();

  const familyOf = (inst: InstanceView, depth: number, inherited?: { family: Family; tint: number }) => {
    if (Object.keys(config.color).length === 0) return { family: DEPTH_FAMILIES[Math.min(depth, 3)]!, tint: depth >= 3 ? 1 : 0 };
    const lineage = [inst.machine, ...(model.aggregates[inst.machine]?.ancestors ?? [])];
    const own = lineage.map((t) => config.color[t]).find((f) => f !== undefined);
    if (own) return { family: own, tint: 0 };
    if (inherited) return { family: inherited.family, tint: Math.min(2, inherited.tint + 1) };
    return { family: "grey" as Family, tint: 0 };
  };

  const build = (inst: InstanceView, depth: number, parent?: string, inherited?: { family: Family; tint: number }): Box => {
    drawnParent.set(inst.key, parent);
    const colour = familyOf(inst, depth, inherited);
    const machine = model.aggregates[inst.machine]!;
    const path = inst.config[0] ?? [];
    const final = isFinalConfiguration(machine, inst.config);
    // A box drawn on top is not drawn again among its parent's children.
    const kids = (childrenOf.get(inst.key) ?? []).filter((k) => !onTop(k) && !matches(model, k.machine, config.omit) && !takenOverBy(frame, config, k.key));
    const summaries: Box["summaries"] = [];
    const groups: Box["groups"] = [];
    const carries = new Set<string>();
    const rels = [...new Set(kids.map((k) => parentOf(k)!.rel))];
    for (const rel of rels) {
      const members = kids.filter((k) => parentOf(k)!.rel === rel);
      const shown = members.filter((k) => !hidden(k));
      const folded = members.filter(hidden);
      if (folded.length > 0) {
        const byState = new Map<string, { count: number; tone: Tone; items: Badge[] }>();
        for (const f of folded) {
          // Counted by top-level state — except a step on hold, which says so wherever it is held.
          const top = (f.config[0] ?? []).find((seg) => /hold|pending/.test(seg)) ?? f.config[0]?.[0] ?? "?";
          const final = isFinalConfiguration(model.aggregates[f.machine]!, f.config);
          const entry = byState.get(top) ?? { count: 0, tone: toneOf([top], final), items: [] };
          entry.count++;
          entry.items.push(withNote(badgeOf(model, frame, config, f.key), attributesIn(f.data, final ? config.attributes : [...config.attributes, ...config.attributesWhileOpen])));
          byState.set(top, entry);
        }
        summaries.push({
          rel,
          total: folded.length,
          finals: folded.filter((f) => isFinalConfiguration(model.aggregates[f.machine]!, f.config)).length,
          byState: [...byState.entries()].map(([state, v]) => ({ state, ...v })),
        });
        for (const f of folded) for (const target of Object.values(f.refs ?? {})) carries.add(target);
      }
      if (shown.length > 0) {
        const declared = (list: string[]) => list.some((r) => {
          const [t, name] = r.split(".");
          return name === rel && isA(model, inst.machine, t!);
        });
        const mode = declared(config.band) ? "band" : declared(config.sequence) ? "sequence" : "row";
        // A classified relation in the order of its classes, whenever each child was created: a
        // start task added late still comes before the final one.
        const classes = machine.children[rel]?.classify;
        const inOrder = classes
          ? [...shown].sort((a, b) => classes.values.indexOf(String(a.data[classes.by])) - classes.values.indexOf(String(b.data[classes.by])))
          : shown;
        const children = inOrder.map((k) => build(k, depth + 1, inst.key, colour));
        if (mode === "band") for (const c of children) bandBoxes.add(c.key);
        for (const c of children) for (const u of c.carries) carries.add(u);
        const layers = mode === "sequence" ? layered(children) : undefined;
        groups.push(layers ? { rel, mode, children, layers } : { rel, mode, children });
      }
    }
    // Several relations of one box declared as sequences are one sequence, in the order the
    // config names them: `sequence: [Job.stages, Job.checks]` draws the stages, then the checks.
    const seqAt = (rel: string) => config.sequence.findIndex((r) => {
      const [t, name] = r.split(".");
      return name === rel && isA(model, inst.machine, t!);
    });
    const seqs = groups.filter((g) => g.mode === "sequence");
    if (seqs.length > 1) {
      seqs.sort((a, b) => seqAt(a.rel) - seqAt(b.rel));
      const children = seqs.flatMap((g) => g.children);
      const layers = layered(children);
      const merged = { rel: seqs.map((g) => g.rel).join("+"), mode: "sequence" as const, children, ...(layers ? { layers } : {}) };
      const at = groups.indexOf(seqs[0]!);
      for (const g of seqs) groups.splice(groups.indexOf(g), 1);
      groups.splice(Math.min(at, groups.length), 0, merged);
    }
    // Bands first: they sit between the parent and its other children.
    groups.sort((a, b) => Number(b.mode === "band") - Number(a.mode === "band"));
    return {
      key: inst.key, machine: inst.machine, id: inst.key.slice(inst.key.indexOf("#") + 1), depth,
      ...labelFor(model, inst, config),
      path, final, tone: toneOf(path, final), ...colour, summaries, groups, carries: [...carries],
    };
  };

  /** Layers by the longest chain of links before each box; boxes no link mentions go first. */
  function layered(children: Box[]): Box[][] | undefined {
    const f = config.follows;
    if (!f) return undefined;
    const keys = new Set(children.map((c) => c.key));
    const edges = all
      .filter((i) => isA(model, i.machine, f.type))
      .map((i) => [i.refs?.[f.before], i.refs?.[f.after]] as const)
      .filter((e): e is readonly [string, string] => !!e[0] && !!e[1] && keys.has(e[0]) && keys.has(e[1]));
    if (edges.length === 0) return undefined;
    // Where the links say nothing, plan order still does: an activity no link mentions follows
    // the one planned before it, and is followed by the one planned after. A plan that links
    // only its redelivery keeps the rest of its journey in a line. Plan order never overrules a
    // link: a step linked in later (a second attempt, a re-check) is planned last, yet comes
    // where its links put it — so no plan-order edge is added against a path the links already make.
    const mentioned = new Set(edges.flat());
    const reaches = (from: string, to: string): boolean => {
      const seen = new Set<string>();
      const stack = [from];
      while (stack.length > 0) {
        const at = stack.pop()!;
        if (at === to) return true;
        if (seen.has(at)) continue;
        seen.add(at);
        for (const [x, y] of edges) if (x === at) stack.push(y);
      }
      return false;
    };
    for (let i = 1; i < children.length; i++) {
      const [a, b] = [children[i - 1]!.key, children[i]!.key];
      if ((!mentioned.has(a) || !mentioned.has(b)) && !reaches(b, a)) edges.push([a, b]);
    }
    const layer = new Map<string, number>(children.map((c) => [c.key, 0]));
    // Longest path, by relaxing at most n times — a cycle in the plan cannot hang the view.
    for (let round = 0; round < children.length; round++) {
      let moved = false;
      for (const [a, b] of edges) {
        if (layer.get(b)! < layer.get(a)! + 1) { layer.set(b, layer.get(a)! + 1); moved = true; }
      }
      if (!moved) break;
    }
    const out: Box[][] = [];
    for (const c of children) (out[layer.get(c.key)!] ??= []).push(c);
    return out.filter((l) => l && l.length > 0);
  }

  const parentless = all.filter((i) => !parentOf(i));
  const side = parentless.filter(inSide).map((i) => {
    const { label } = labelFor(model, i, config);
    const family = [i.machine, ...(model.aggregates[i.machine]?.ancestors ?? [])].map((t) => config.color[t]).find((f) => f !== undefined);
    return { ...i, ...(label ? { label } : {}), ...(family ? { family } : {}) };
  });
  const candidates = parentless.filter((i) => !inSide(i) && !hidden(i) && !onTop(i) && !isException(i) && !matches(model, i.machine, config.omit));
  const rootList = config.roots ? candidates.filter((i) => matches(model, i.machine, config.roots!)) : candidates;
  const others = config.roots ? candidates.filter((i) => !matches(model, i.machine, config.roots!)) : [];
  const top = all.filter(onTop).map((t) => build(t, 0));
  // Like a band, the top lane shows a state, not the events that moved it: those already sit
  // with the boxes they happened in, and repeated across the whole width they would bury them.
  for (const t of top) bandBoxes.add(t.key);
  // Nothing of the configured root type exists — a run that plans only part of a journey.
  // Draw what is there rather than an empty picture.
  const roots = (rootList.length > 0 ? rootList : others).map((r) => build(r, 0));
  // Bookkeeping until something is under it; built before the events, which may sit on it.
  const exceptions = parentless.filter(isException).map((r) => build(r, 0)).filter((b) => b.groups.length > 0 || b.summaries.length > 0);

  const { stickies: placed, asks } = config.events === "none" ? { stickies: {}, asks: {} } : stickies(model, frame, log, config, drawnParent, bandBoxes);
  for (const list of Object.values(placed)) {
    for (const s of list) {
      const seen = new Set<string>();
      const noteOf = (raiser: string) => {
        const notes = s.occurrences.filter((o) => o.raiser === raiser && o.note).map((o) => o.note!);
        return notes.length > 0 ? [...new Set(notes)].join(" · ") : undefined;
      };
      s.badges = s.raisers.map((r) => withNote(badgeOf(model, frame, config, r), noteOf(r))).filter((b) => !seen.has(b.key) && seen.add(b.key));
      if (!config.eventStatus) continue;
      // Each occurrence where it now stands: the state of the instance it opened.
      const groups = new Map<string, { state: string; tone: Tone; badges: Badge[] }>();
      for (const o of s.occurrences) {
        const inst = o.status ? frame.instances[o.status] : undefined;
        const state = inst?.config[0]?.[0] ?? "reported";
        const final = inst ? isFinalConfiguration(model.aggregates[inst.machine]!, inst.config) : false;
        const g = groups.get(state) ?? groups.set(state, { state, tone: statusTone(state, final), badges: [] }).get(state)!;
        const b = withNote(badgeOf(model, frame, config, o.raiser), o.note);
        const same = g.badges.findIndex((x) => x.key === b.key);
        if (same < 0) g.badges.push(b);
        else if (b.note && g.badges[same]!.note !== b.note) g.badges[same] = withNote(b, [g.badges[same]!.note, b.note].filter(Boolean).join(" · "));
      }
      if (s.occurrences.some((o) => o.status)) s.statuses = [...groups.values()];
    }
  }
  for (const list of Object.values(asks)) for (const a of list) for (const o of a.occurrences) {
    if (o.subject) o.label = badgeOf(model, frame, config, o.subject).label;
  }
  if (carriers) {
    // ADR 0034 §3: each unit named with the main overview's roots that carry it.
    const named = (b: Badge): Badge => (carriers.has(b.key) ? { ...b, label: `${b.label} · ${carriers.get(b.key)!.join(", ")}` } : b);
    const walk = (box: Box) => {
      for (const sm of box.summaries) for (const st of sm.byState) st.items = st.items.map(named);
      for (const g of box.groups) g.children.forEach(walk);
    };
    [...top, ...roots, ...exceptions].forEach(walk);
    for (const list of Object.values(placed)) for (const st of list) {
      st.badges = st.badges.map(named);
      for (const g of st.statuses ?? []) g.badges = g.badges.map(named);
    }
  }
  return { top, roots, exceptions, side, others: rootList.length > 0 ? others : [], stickies: placed, asks };
}

/** The box that took this one over (`takenOver:`), if it did and it exists. */
function takenOverBy(frame: Frame, config: OverviewConfig, key: string): string | undefined {
  if (!config.takenOver) return undefined;
  const by = frame.instances[key]?.data[config.takenOver];
  return typeof by === "string" && by !== "" && frame.instances[by] ? by : undefined;
}

// ---------------------------------------------------------------- where the events go

/** An event's substatus as a tone: pending is on hold; a confirmed deviation happened — a failure. */
export function statusTone(state: string, final: boolean): Tone {
  return /confirm/.test(state) ? "failed" : toneOf([state], final);
}

function stickies(
  model: Model,
  frame: Frame,
  log: LogEntry[],
  config: OverviewConfig,
  drawnParent: Map<string, string | undefined>,
  bandBoxes: Set<string>,
): { stickies: Record<string, Sticky[]>; asks: Record<string, AskMark[]> } {
  const past = log.filter((e) => e.seq <= frame.seq);
  const byCause = new Map<number, LogEntry[]>();
  for (const e of past) (byCause.get(e.cause) ?? byCause.set(e.cause, []).get(e.cause)!).push(e);

  /** The drawn box an instance shows up in: itself, its nearest drawn ancestor, or what took it over. */
  const drawnOf = (key: string): string | undefined => {
    const seen = new Set<string>();
    for (let k: string | undefined = key; k && !seen.has(k); k = takenOverBy(frame, config, k) ?? frame.instances[k]?.parent?.key) {
      seen.add(k);
      if (drawnParent.has(k)) return k;
    }
    return undefined;
  };
  const ancestorsOf = (box: string): Set<string> => {
    const out = new Set<string>();
    for (let p = drawnParent.get(box); p; p = drawnParent.get(p)) out.add(p);
    return out;
  };

  const out: Record<string, Sticky[]> = {};
  // ADR 0027: who owns an event — the role sending the input at the root of its causes — and the
  // role a box is worked in — its type's, or its nearest drawn ancestor's.
  const roles = model.systems?.roles ?? [];
  const bySeq = new Map(log.map((e) => [e.seq, e]));
  const ownerOf = (e: LogEntry): Sticky["owner"] => {
    if (roles.length === 0) return undefined;
    let root = e;
    for (let i = 0; i < 1000 && root.cause !== 0; i++) { const up = bySeq.get(root.cause); if (!up) break; root = up; }
    if (root.kind !== "command") return undefined;
    const type = root.instance.slice(0, root.instance.indexOf("#"));
    const role = roleOfCommand(model, type, root.name, root.payload);
    if (!role) return undefined;
    const sender = senderOfCommand(model, type, root.name, root.payload)?.name;
    const family = role.works.flatMap((t) => [t, ...(model.aggregates[t]?.ancestors ?? [])]).map((t) => config.color[t]).find((f) => f !== undefined) ?? "grey";
    return { role: role.name, family, ...(sender ? { sender } : {}) };
  };
  const roleOfBox = (box: string): string | undefined => {
    for (let k: string | undefined = box; k; k = drawnParent.get(k)) {
      const r = roleOfType(model, k.slice(0, k.indexOf("#")));
      if (r) return r.name;
    }
    return undefined;
  };
  /** The instance of `events.status` this event opened, if it opened one. */
  const statusOf = (seq: number): string | undefined => {
    if (!config.eventStatus) return undefined;
    const queue = [seq];
    for (let i = 0; i < queue.length && i < 200; i++) {
      for (const next of byCause.get(queue[i]!) ?? []) {
        if (next.kind === "created" && isA(model, next.instance.slice(0, next.instance.indexOf("#")), config.eventStatus)) return next.instance;
        queue.push(next.seq);
      }
    }
    return undefined;
  };
  const add = (box: string, e: Extract<LogEntry, { kind: "event" }>) => {
    const list = (out[box] ??= []);
    const s = list.find((x) => x.event === e.event);
    const note = attributesIn(e.payload, [...config.attributes, ...config.attributesWhileOpen]);
    const occurrence = { raiser: e.instance, seq: e.seq, ...(config.eventStatus ? { status: statusOf(e.seq) } : {}), ...(note ? { note } : {}) };
    const owner = ownerOf(e);
    const boxRole = owner ? roleOfBox(box) : undefined;
    const foreign = owner && boxRole && boxRole !== owner.role ? { boxRole } : undefined;
    if (s) {
      s.count++;
      if (!s.raisers.includes(e.instance)) s.raisers.push(e.instance);
      s.occurrences.push(occurrence);
      if (!s.owner && owner) s.owner = owner;
      if (!s.foreign && foreign) { s.foreign = foreign; s.owner = owner; }
    } else list.push({ event: e.event, count: 1, seq: e.seq, raisers: [e.instance], badges: [], occurrences: [occurrence], ...(owner ? { owner } : {}), ...(foreign ? { foreign } : {}) });
  };

  /** The boxes an event is placed on: its raiser's, or the deepest boxes it moved (`events.place`). */
  const boxesOf = (e: Extract<LogEntry, { kind: "event" }>): string[] => {
    const raiser = drawnOf(e.instance);
    if (config.events === "raised" || (config.events === "auto" && raiser)) return raiser ? [raiser] : [];
    // Triggered: everything this event caused, and the deepest drawn boxes it changed.
    const changed = new Set<string>();
    const created = new Set<string>();
    const stayed = new Set<string>();
    const queue = [e.seq];
    const visited = new Set<number>();
    while (queue.length > 0) {
      const seq = queue.shift()!;
      if (visited.has(seq)) continue;
      visited.add(seq);
      for (const next of byCause.get(seq) ?? []) {
        queue.push(next.seq);
        const moved = next.kind === "transition" && !next.internal;
        if (next.kind === "transition" && next.internal) {
          const box = drawnOf(next.instance);
          if (box && !bandBoxes.has(box)) stayed.add(box);
        }
        if (!moved && next.kind !== "created") continue;
        const box = drawnOf(next.instance);
        if (box && !bandBoxes.has(box)) (moved ? changed : created).add(box);
      }
    }
    // Where it moved something; only an event that just creates things sits on what it created.
    // A failure that moves a step and, on the way, plans a follow-up belongs with the step it
    // moved, not once more on each of the follow-up's new tasks.
    const where = changed.size > 0 ? changed : created;
    const placed = [...where].filter((b) => ![...where].some((o) => o !== b && ancestorsOf(o).has(b)));
    // ADR 0027 §4: an event that changed nothing of its own role is also shown where its own role's
    // task heard it — a task hears its own scan where it happens — so it is never only on the other
    // role's side.
    const own = ownerOf(e)?.role;
    if (own && !placed.some((b) => roleOfBox(b) === own)) {
      for (const b of stayed) {
        if (placed.includes(b) || roleOfBox(b) !== own) continue;
        if (placed.some((o) => ancestorsOf(o).has(b)) || [...stayed].some((o) => o !== b && roleOfBox(o) === own && ancestorsOf(o).has(b))) continue;
        placed.push(b);
      }
    }
    return placed;
  };
  const subject = (e: Extract<LogEntry, { kind: "event" }>) => subjectOf(model, config.eventsOf, e);

  const mode = config.eventsMode ?? "requests";
  const asks: Record<string, AskMark[]> = {};
  for (const e of past) {
    if (e.kind !== "event") continue;
    const ask = mode === "all" ? undefined : config.asks[e.event];
    if (ask) {
      // An ask is a marker on the box, not an event in its lane (ADR 0023).
      if (mode !== "requests") continue;
      const about = subject(e);
      const answer = past.find((x) => x.kind === "event" && x.seq > e.seq && ask.answered.includes(x.event)
        && (about ? subject(x) === about : x.instance === e.instance)) as Extract<LogEntry, { kind: "event" }> | undefined;
      for (const box of boxesOf(e)) {
        const list = (asks[box] ??= []);
        const mark = list.find((m) => m.event === e.event) ?? (list.push({ event: e.event, mark: ask.mark, icon: ask.icon, occurrences: [] }), list[list.length - 1]!);
        mark.occurrences.push({ seq: e.seq, ...(about ? { subject: about } : {}), label: about ?? e.instance, ...(answer ? { answer: { event: answer.event, seq: answer.seq } } : {}) });
      }
      continue;
    }
    if (mode !== "all" && !config.showEvents.some((p) => globMatch(p, e.event))) {
      if (config.hideEvents.some((p) => globMatch(p, e.event))) continue;
      if (config.eventsOf && !subject(e)) continue;
    }
    for (const b of boxesOf(e)) add(b, e);
  }
  return { stickies: out, asks };
}

/**
 * Whom an event is about, of the `events.of` types: its raiser, if it is one; else the one it names
 * in a reference its raiser declares. Undefined: it is about none of them (or no `of` is set).
 */
export function subjectOf(model: Model, of: string[] | undefined, e: Extract<LogEntry, { kind: "event" }>): string | undefined {
  if (!of || of.length === 0) return undefined;
  const machine = e.instance.slice(0, e.instance.indexOf("#"));
  if (of.some((t) => isA(model, machine, t))) return e.instance;
  const m = model.aggregates[machine];
  const ref = m ? Object.entries(m.references).find(([name, r]) => of.some((t) => isA(model, r.type, t)) && typeof e.payload[name] === "string" && e.payload[name] !== "") : undefined;
  return ref ? `${ref[1].type}#${String(e.payload[ref[0]])}` : undefined;
}

/** `StabilityExpired` -> `Stability Expired`: the event as it is said out loud. */
export function spoken(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

export function stateWords(path: string[]): string {
  return path.map((p) => p.replace(/_/g, " ")).join(" · ");
}


// ---------------------------------------------------------------- stepping by what you can see

/** What a sticky shows: the event, who it happened to, and — with a substatus — where each stands. */
function stickyLook(s: Sticky): string {
  return `${s.event}:${s.badges.map(badgeLook).join("+")}${s.statuses ? `[${s.statuses.map((g) => `${g.state}=${g.badges.map(badgeLook).join("+")}`).join("/")}]` : ""}`;
}

/** What an ask's marker shows: how often asked, and what has answered. */
function askLook(a: AskMark): string {
  return `${a.event}:${a.occurrences.map((o) => `${o.label}>${o.answer?.event ?? "open"}`).join("+")}`;
}

/** Everything the overview shows, as text: two frames look the same iff these are equal. */
export function overviewSignature(o: Overview): string {
  const parts: string[] = [];
  const walk = (b: Box) => {
    parts.push(`${b.key}=${b.path.join(".")}|${b.label ?? ""}|${b.summaries.map((s) => `${s.rel}:${s.byState.map((x) => `${x.state}:${x.items.map(badgeLook).join("+")}`).join("/")}`).join(",")}`);
    for (const g of b.groups) for (const c of g.children) walk(c);
  };
  [...o.top, ...o.roots, ...o.exceptions].forEach(walk);
  for (const s of o.side) parts.push(`side:${s.key}=${(s.config[0] ?? []).join(".")}`);
  for (const s of o.others) parts.push(`other:${s.key}=${(s.config[0] ?? []).join(".")}`);
  for (const [k, list] of Object.entries(o.stickies)) parts.push(`sticky:${k}=${list.map(stickyLook).join(",")}`);
  for (const [k, list] of Object.entries(o.asks)) parts.push(`ask:${k}=${list.map(askLook).join(",")}`);
  return parts.join(";");
}

interface Frames { frames: Frame[]; world: { log: LogEntry[] } }
const signatures = new WeakMap<Frames, Map<OverviewConfig, string[]>>();

/**
 * The next (or previous) frame at which the overview changes — so stepping follows the picture
 * rather than every internal message. A frame is a stop when it looks different from the frame
 * before it. Signatures are computed as needed and cached per run.
 */
export function visibleStep(model: Model, config: OverviewConfig, run: Frames, from: number, direction: 1 | -1): number {
  const perRun = signatures.get(run) ?? signatures.set(run, new Map()).get(run)!;
  const sigs = perRun.get(config) ?? perRun.set(config, []).get(config)!;
  const sig = (i: number): string =>
    (sigs[i] ??= overviewSignature(buildOverview(model, run.frames[i]!, run.world.log, config)));
  const last = run.frames.length - 1;
  const isStop = (i: number) => i === 0 || sig(i) !== sig(i - 1);
  if (direction > 0) {
    for (let i = from + 1; i <= last; i++) if (isStop(i)) return i;
    return last;
  }
  for (let i = from - 1; i > 0; i--) if (isStop(i)) return i;
  return 0;
}

/** What each box shows, by key — for outlining exactly the boxes that look different. */
function boxLooks(o: Overview): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (b: Box) => {
    const stickies = (o.stickies[b.key] ?? []).map(stickyLook).join(",");
    const marks = (o.asks[b.key] ?? []).map(askLook).join(",");
    out.set(b.key, `${b.path.join(".")}|${b.label ?? ""}|${b.summaries.map((s) => `${s.rel}:${s.byState.map((x) => `${x.state}:${x.items.map(badgeLook).join("+")}`).join("/")}`).join(",")}|${stickies}|${marks}`);
    for (const g of b.groups) for (const c of g.children) walk(c);
  };
  [...o.top, ...o.roots, ...o.exceptions].forEach(walk);
  for (const s of o.side) out.set(s.key, (s.config[0] ?? []).join("."));
  return out;
}

/**
 * Between two overviews: the boxes that look different (state, a tally, its events), and the
 * stickies that are new or grew — so a jump outlines exactly what it changed, including a
 * "1/2 done" that moved because a folded handling did.
 */
export function differences(before: Overview | undefined, after: Overview): { boxes: Set<string>; stickies: Set<string> } {
  const boxes = new Set<string>();
  const stickies = new Set<string>();
  if (!before) return { boxes, stickies };
  const a = boxLooks(before);
  for (const [key, look] of boxLooks(after)) if (a.get(key) !== look) boxes.add(key);
  for (const [key, list] of Object.entries(after.stickies)) {
    for (const s of list) {
      const old = before.stickies[key]?.find((x) => x.event === s.event);
      if (!old || old.count !== s.count || stickyLook(old) !== stickyLook(s)) stickies.add(`${key}:${s.event}`);
    }
  }
  return { boxes, stickies };
}
