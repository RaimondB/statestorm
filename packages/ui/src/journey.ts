/**
 * The Journey (ADR 0024): the overview's boxes as a metro line — time down the page, each step a
 * station on its parent's line, its own steps a thinner line inside it, what runs side by side a
 * branch — and under each station the events received there, in order, with whom they were about
 * and when. Read from the overview the same frame builds, so both views show the same things by the
 * same rules (ADR 0023): only a subject's events, the asks as markers.
 */
import { isA, isFinalConfiguration, type Frame, type LogEntry, type Model } from "@statestorm/kernel";
import { badgeOf, labelFor, statusTone, stateWords, type AskMark, type Badge, type Box, type Overview, type OverviewConfig, type Tone } from "./overview.ts";

export interface JourneyRow {
  event: string;
  /** The first log entry it stands for, and all of them. */
  seq: number;
  seqs: number[];
  /** The simulated clock when it was received, ms since epoch. */
  at: number;
  /** Whom it was about — the samples, the units. */
  badges: Badge[];
  /** Further fields worth reading beside it (`journey.attributes`, `attributes`). */
  notes: string[];
  /** A status's substatus (`events.status`): where each occurrence now stands. */
  statuses: { state: string; tone: Tone }[];
}

export interface Station {
  key: string;
  machine: string;
  id: string;
  label?: string;
  tone: Tone;
  /** Its active state, in words. */
  state: string;
  final: boolean;
  /** 0: the line itself (a root of the overview); deeper: a station on it, a step inside a station. */
  depth: number;
  rows: JourneyRow[];
  asks: AskMark[];
  /** Its hidden children's tallies, as the overview reads them. */
  summaries: Box["summaries"];
  /** Children drawn as a strip on the station (`band:` — a route's end-to-end tasks). */
  band: Station[];
  /** What continues under it, in order: a line of stations, or a branch of lines side by side. */
  tracks: Track[];
  /** The units that travel through it. */
  carries: string[];
  /** A line's value of `journey.together` — the lines that share it are shown together (say, one customer's orders). */
  together?: string;
}

export type Track =
  | { kind: "line"; stations: Station[]; /** a station's own steps: drawn inside it */ inner: boolean }
  | { kind: "branch"; columns: Station[][] };

export interface Journey {
  /** Every line there is to show: the overview's roots, then what stands outside the plan. */
  lines: Station[];
  /** The units the journey is about (the overview's side lane), for showing one at a time. */
  units: Badge[];
  /** The latest row: where the run is now. */
  now?: number;
}

/** The Journey of a frame, from the overview built for it. */
export function buildJourney(model: Model, frame: Frame, log: LogEntry[], config: OverviewConfig, o: Overview): Journey {
  const bySeq = new Map(log.map((e) => [e.seq, e]));
  const words = { ...config, label: { ...config.label, ...config.journey.label } };
  const fields = [...config.journey.attributes, ...config.attributes.filter((a) => !config.journey.attributes.includes(a))];
  let now: number | undefined;

  const rowsOf = (box: Box): JourneyRow[] => {
    const out: JourneyRow[] = [];
    for (const s of o.stickies[box.key] ?? []) {
      // One row per moment: what arrived at once (a cascade to several units) reads as one line.
      const occ = [...s.occurrences].sort((a, b) => a.seq - b.seq);
      let row: JourneyRow | undefined;
      for (const oc of occ) {
        const entry = bySeq.get(oc.seq);
        const at = entry?.at ?? 0;
        if (!row || row.at !== at) {
          row = { event: s.event, seq: oc.seq, seqs: [], at, badges: [], notes: [], statuses: [] };
          out.push(row);
        }
        row.seqs.push(oc.seq);
        const b = badgeOf(model, frame, config, oc.raiser);
        if (!row.badges.some((x) => x.key === b.key)) row.badges.push(b);
        const payload = entry?.kind === "event" ? entry.payload : {};
        for (const f of fields) {
          const v = payload[f];
          if (v !== undefined && v !== null && v !== "" && typeof v !== "object") {
            const said = String(v).replace(/_/g, " ");
            if (!row.notes.includes(said)) row.notes.push(said);
          }
        }
        if (oc.status) {
          const inst = frame.instances[oc.status];
          const state = inst?.config[0]?.[0] ?? "reported";
          const final = inst && model.aggregates[inst.machine] ? isFinalConfiguration(model.aggregates[inst.machine]!, inst.config) : false;
          if (!row.statuses.some((x) => x.state === state)) row.statuses.push({ state, tone: statusTone(state, final) });
        }
        if (now === undefined || oc.seq > now) now = oc.seq;
      }
    }
    return out.sort((a, b) => a.seq - b.seq);
  };

  const station = (box: Box): Station => {
    const inst = frame.instances[box.key];
    const named = inst ? labelFor(model, inst, words) : {};
    const tracks: Track[] = [];
    const band: Station[] = [];
    let line: Extract<Track, { kind: "line" }> | undefined;
    const onLine = (s: Station, inner: boolean) => {
      if (!line || line.inner !== inner) { line = { kind: "line", stations: [], inner }; tracks.push(line); }
      line.stations.push(s);
    };
    for (const g of box.groups) {
      if (g.mode === "band") { band.push(...g.children.map(station)); continue; }
      if (g.layers) {
        // Laid out by which follows which: one after the other, side by side where they run at once.
        for (const layer of g.layers) {
          if (layer.length === 1) onLine(station(layer[0]!), false);
          else { line = undefined; tracks.push({ kind: "branch", columns: layer.map((c) => [station(c)]) }); }
        }
        line = undefined;
        continue;
      }
      // A sequence is the line going on; a row is a station's own steps, inside it.
      for (const c of g.children) onLine(station(c), g.mode === "row");
      line = undefined;
    }
    return {
      key: box.key, machine: box.machine, id: box.id,
      ...(named.label ?? box.label ? { label: named.label ?? box.label } : {}),
      tone: box.tone, state: stateWords(box.path), final: box.final, depth: box.depth,
      rows: rowsOf(box), asks: o.asks[box.key] ?? [], summaries: box.summaries, band, tracks, carries: box.carries,
      ...(config.journey.together && box.depth === 0 && inst && typeof inst.data[config.journey.together] === "string" && inst.data[config.journey.together] !== ""
        ? { together: String(inst.data[config.journey.together]) } : {}),
    };
  };

  const lines = [...o.roots, ...o.exceptions].map(station);
  // The units to follow one at a time: what the events are about (`events.of`), else the side lane.
  const of = config.eventsOf;
  const units = o.side.filter((s) => !of || of.some((t) => isA(model, s.machine, t)))
    .map((s) => ({ key: s.key, label: s.key.slice(s.key.indexOf("#") + 1) }));
  return { lines, units, ...(now !== undefined ? { now } : {}) };
}

/** Every station of a line, depth first: for counting and finding. */
export function stationsOf(s: Station): Station[] {
  return [s, ...s.band.flatMap(stationsOf), ...s.tracks.flatMap((t) => (t.kind === "line" ? t.stations : t.columns.flat()).flatMap(stationsOf))];
}
