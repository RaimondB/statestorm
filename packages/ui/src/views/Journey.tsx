import { useMemo, useState, type ReactNode } from "react";
import type { Model } from "@statestorm/kernel";
import { frameOfEntry, type Run } from "../session.ts";
import type { Selection } from "../selection.ts";
import { buildOverview, overviewConfig, spoken, withEventsMode, type AskMark, type EventsMode, type Tone } from "../overview.ts";
import { buildJourney, stationsOf, type JourneyRow, type Station, type Track } from "../journey.ts";

const GLYPH: Record<Tone, string> = { neutral: "○", active: "●", done: "✓", partial: "◐", failed: "✗", skipped: "–", held: "‖" };
const MODES: { mode: EventsMode; label: string; title: string }[] = [
  { mode: "statuses", label: "statuses", title: "Only the events the model's overview shows — no asks" },
  { mode: "requests", label: "+ asks", title: "The statuses, and what was asked and is waited on, as markers" },
  { mode: "all", label: "every event", title: "Every event the model raises, nothing hidden" },
];

interface Props {
  model: Model;
  run: Run;
  index: number;
  select: (s: Selection) => void;
  onIndex: (i: number) => void;
  eventsMode: EventsMode;
  onEventsMode: (m: EventsMode) => void;
  /** The lines shown, by their root's key; absent: every line, up to three. It travels in the link. */
  lines?: string[];
  onLines: (keys: string[] | undefined) => void;
}

/** `08:40`, and the day above it when it is not the day before it. */
function clock(at: number, prev?: number): { time: string; day?: string } {
  const iso = new Date(at).toISOString();
  const day = iso.slice(5, 10);
  return { time: iso.slice(11, 16), ...(prev === undefined || new Date(prev).toISOString().slice(5, 10) !== day ? { day } : {}) };
}

/**
 * The Journey (ADR 0024): each root of the overview as a metro line down the page.
 * Its steps are stations in plan order, their own steps a thinner line inside them; what runs side
 * by side branches and joins again. A station's colour is how far it has come; under it, the events
 * received there, in order, with whom they were about and when. Several lines stand side by side —
 * an exchange's delivery and its return. The same events as the overview, by the same rules.
 */
export function Journey({ model, run, index, select, onIndex, eventsMode, onEventsMode, lines: chosen, onLines }: Props) {
  const read = useMemo(() => overviewConfig(model), [model]);
  const config = useMemo(() => withEventsMode(read.config, eventsMode), [read, eventsMode]);
  const asking = Object.keys(read.config.asks).length > 0;
  const shownMode: EventsMode = !asking && eventsMode === "requests" ? "statuses" : eventsMode;
  const frame = run.frames[index]!;
  const journey = useMemo(() => buildJourney(model, frame, run.world.log, config, buildOverview(model, frame, run.world.log, config)), [model, frame, run, config]);
  const [unit, setUnit] = useState<string>();

  const all = journey.lines;
  // With `journey.together`, lines come in groups — say, one customer's orders — and the first group shows.
  const groups = useMemo(() => {
    const out: { name: string; keys: string[] }[] = [];
    for (const l of all) {
      const name = l.together ?? l.id;
      const g = out.find((x) => x.name === name);
      if (g) g.keys.push(l.key); else out.push({ name, keys: [l.key] });
    }
    return out;
  }, [all]);
  const grouped = all.some((l) => l.together);
  // Lines chosen for another run that are not in this one fall back to the first there are.
  const kept = chosen?.filter((k) => all.some((l) => l.key === k)) ?? [];
  const shownKeys = kept.length > 0 ? kept : grouped ? (groups[0]?.keys ?? []) : all.slice(0, 3).map((l) => l.key);
  const shown = all.filter((l) => shownKeys.includes(l.key));
  const toggleLine = (key: string) => {
    const next = shownKeys.includes(key) ? shownKeys.filter((k) => k !== key) : [...shownKeys, key];
    onLines(next.length === 0 ? [key] : next);
  };

  // The clock where it moves: a row says its time when it is not the time of the row before it.
  const times = useMemo(() => {
    const rows = shown.flatMap(stationsOf).flatMap((s) => s.rows).sort((a, b) => a.seq - b.seq);
    const out = new Map<number, { time: string; day?: string }>();
    let prev: number | undefined;
    for (const r of rows) {
      if (prev === undefined || Math.floor(r.at / 60000) !== Math.floor(prev / 60000)) out.set(r.seq, clock(r.at, prev));
      prev = r.at;
    }
    return out;
  }, [shown]);

  const ctx: Ctx = {
    unit,
    now: journey.now,
    times,
    pick: (key) => select({ kind: "instance", key }),
    travel: (seq) => { onIndex(frameOfEntry(run, seq)); select({ kind: "entry", seq }); },
  };

  return (
    <div className="ov journey">
      <div className="ov-head">
        {grouped && groups.length > 1 && (
          <span className="jr-pick" role="group" aria-label="Which group of lines">
            {groups.map((g) => {
              const on = g.keys.every((k) => shownKeys.includes(k));
              return (
                <button key={g.name} className={on ? "active" : ""} onClick={() => onLines(g.keys)}
                  title={`${g.name}: ${g.keys.map((k) => k.slice(k.indexOf("#") + 1)).join(", ")} — show them together`}>
                  {g.name}{g.keys.length > 1 ? ` · ${g.keys.length}` : ""}
                </button>
              );
            })}
          </span>
        )}
        {all.length > 1 && (
          <span className="jr-pick" role="group" aria-label="Which lines">
            {all.map((l) => (
              <button key={l.key} className={shownKeys.includes(l.key) ? "active" : ""} onClick={() => toggleLine(l.key)}
                title={`${l.machine} ${l.id}${l.label ? ` — ${l.label}` : ""}: ${shownKeys.includes(l.key) ? "hide" : "show"} its line`}>
                {l.id}
              </button>
            ))}
          </span>
        )}
        {journey.units.length > 1 && (
          <span className="jr-pick" role="group" aria-label="Show one unit">
            {journey.units.map((u) => (
              <button key={u.key} className={unit === u.key ? "active" : ""} onClick={() => setUnit(unit === u.key ? undefined : u.key)}
                title={unit === u.key ? "show every unit again" : `show only where ${u.label} travels`}>{u.label}</button>
            ))}
          </span>
        )}
        <span className="map-levels" role="radiogroup" aria-label="Which events">
          {MODES.filter((m) => m.mode !== "requests" || asking).map((m) => (
            <button key={m.mode} role="radio" aria-checked={shownMode === m.mode} className={shownMode === m.mode ? "active" : ""}
              title={m.title} onClick={() => onEventsMode(m.mode)}>{m.label}</button>
          ))}
        </span>
      </div>
      <div className="ov-canvas">
        {shown.length === 0 ? <div className="hint" style={{ padding: 16 }}>Nothing to show yet — fire a command, or pick a scenario.</div> : (
          <div className="jr-lines">
            {shown.map((l) => (
              <section key={l.key} className="jr-line" aria-label={`${l.machine} ${l.id}`}>
                <StationView s={l} ctx={ctx} />
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface Ctx {
  unit?: string;
  now?: number;
  times: Map<number, { time: string; day?: string }>;
  pick: (key: string) => void;
  travel: (seq: number) => void;
}

function StationView({ s, ctx }: { s: Station; ctx: Ctx }) {
  const dim = ctx.unit !== undefined && s.carries.length > 0 && !s.carries.includes(ctx.unit);
  const rows = s.rows.filter((r) => !ctx.unit || r.badges.some((b) => b.key === ctx.unit));
  const tally = s.summaries.flatMap((x) => x.byState.map((b) => `${GLYPH[b.tone]} ${b.items.map((i) => i.label).join(" ")}`));
  return (
    <div className={`jr-st d${Math.min(s.depth, 3)} t-${s.tone}${dim ? " dim" : ""}`}>
      <span className="jr-dot" aria-hidden="true" />
      <div className="jr-head">
        <button className="jr-name" onClick={() => ctx.pick(s.key)} title={`${s.key} — ${s.state}`}>
          {s.label ?? s.machine}
        </button>
        <span className="jr-id" title={s.machine}>{s.machine === (s.label ?? s.machine) ? "" : `${s.machine} `}{s.id}</span>
        <span className={`ov-pill t-${s.tone}`}>{GLYPH[s.tone]} {s.state}</span>
        {s.asks.map((a) => <Ask key={a.event} mark={a} ctx={ctx} />)}
        {tally.length > 0 && <span className="jr-tally" title={s.summaries.map((x) => x.rel).join(", ")}>{tally.join("  ")}</span>}
      </div>
      {s.band.length > 0 && (
        <div className="jr-band">
          {s.band.map((b) => (
            <button key={b.key} className={`jr-chip t-${b.tone}`} onClick={() => ctx.pick(b.key)} title={`${b.key} — ${b.state}`}>
              {GLYPH[b.tone]} {b.label ?? b.machine}
            </button>
          ))}
        </div>
      )}
      {rows.length > 0 && <Rows rows={rows} ctx={ctx} />}
      {s.tracks.map((t, i) => <TrackView key={i} track={t} ctx={ctx} />)}
    </div>
  );
}

function TrackView({ track, ctx }: { track: Track; ctx: Ctx }): ReactNode {
  if (track.kind === "line") {
    return <div className={`jr-track${track.inner ? " inner" : ""}`}>{track.stations.map((s) => <StationView key={s.key} s={s} ctx={ctx} />)}</div>;
  }
  // Side by side: what runs at once, branching off the line and joining it again.
  return (
    <div className="jr-branch">
      {track.columns.map((col, i) => (
        <div key={i} className="jr-track">{col.map((s) => <StationView key={s.key} s={s} ctx={ctx} />)}</div>
      ))}
    </div>
  );
}

function Rows({ rows, ctx }: { rows: JourneyRow[]; ctx: Ctx }) {
  return (
    <ol className="jr-rows">
      {rows.map((r) => {
        const now = ctx.now !== undefined && r.seqs.includes(ctx.now);
        return (
          <li key={r.seq} className={now ? "now" : ""}>
            <span className="jr-time">{(() => {
              const t = ctx.times.get(r.seq);
              return t ? <>{t.day && <small>{t.day}</small>}{t.time}</> : null;
            })()}</span>
            <button className="jr-event" onClick={() => ctx.travel(r.seq)} title={`${r.event} — go to it`}>{spoken(r.event)}</button>
            <span className="jr-who">
              {r.badges.map((b) => <span key={b.key} className={`ov-badge${ctx.unit === b.key ? " on" : ""}`}>{b.label}</span>)}
              {r.statuses.map((x) => <span key={x.state} className={`ov-pill t-${x.tone}`}>{GLYPH[x.tone]} {x.state.replace(/_/g, " ")}</span>)}
              {r.notes.length > 0 && <span className="jr-notes">{r.notes.join(" · ")}</span>}
              {now && <span className="jr-now">◀ now</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Ask({ mark, ctx }: { mark: AskMark; ctx: Ctx }) {
  const mine = mark.occurrences.filter((o) => !ctx.unit || o.subject === ctx.unit);
  if (mine.length === 0) return null;
  const open = mine.filter((o) => !o.answer);
  const answers = [...new Set(mine.flatMap((o) => (o.answer ? [o.answer.event] : [])))];
  const said = open.length === 0 && answers.length === 1 ? `: ${spoken(answers[0]!).toLowerCase()}` : open.length > 0 && open.length < mine.length ? ` · ${open.length} waiting` : "";
  const first = open[0] ?? mine[mine.length - 1]!;
  return (
    <button className={`ov-ask ${open.length > 0 ? "open" : "answered"}`} onClick={() => ctx.travel(first.seq)}
      title={`${spoken(mark.event)}\n${mine.map((o) => `${o.label}: ${o.answer ? `answered — ${spoken(o.answer.event)}` : "waiting"}`).join("\n")}`}>
      {mark.icon} {mark.mark}{mine.length > 1 ? ` ×${mine.length}` : ""}{said}
    </button>
  );
}

