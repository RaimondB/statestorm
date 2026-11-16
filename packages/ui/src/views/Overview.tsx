import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { frameOfEntry, type Run } from "../session.ts";
import type { Model } from "@statestorm/kernel";
import type { Selection } from "../selection.ts";
import { buildOverview, byNote, differences, overviewConfig, spoken, stateWords, withEventsMode, type AskMark, type Badge, type Box, type EventsMode, type Sticky, type Tone } from "../overview.ts";

/** The overview's switch: which events the reader sees, beside the model's configuration (ADR 0023). */
const MODES: { mode: EventsMode; label: string; title: string }[] = [
  { mode: "statuses", label: "statuses", title: "Only the events the model's overview shows — no asks" },
  { mode: "requests", label: "+ asks", title: "The statuses, and what was asked and is waited on, as markers on the boxes" },
  { mode: "all", label: "every event", title: "Every event the model raises, nothing hidden — for working out what happened" },
];

const GLYPH: Record<Tone, string> = { neutral: "○", active: "●", done: "✓", partial: "◐", failed: "✗", skipped: "–", held: "‖" };
const WORD: Record<Tone, string> = {
  neutral: "not started", active: "in progress", done: "done", partial: "partly done", failed: "failed", skipped: "not needed",
  held: "on hold",
};

/** States whose glyph already says what they are; a tally of anything else shows the state's name. */
const LIFECYCLE = /^(created|open|in_progress|completed|partially_completed|failed|excluded|not_needed)$/;

interface Props {
  model: Model;
  run: Run;
  index: number;
  /** The frame to compare with: changes since then are outlined. */
  since: number;
  selection: Selection;
  select: (s: Selection) => void;
  onIndex: (i: number) => void;
  /** What the reader chose of the events; it travels in the link. */
  eventsMode: EventsMode;
  onEventsMode: (m: EventsMode) => void;
}

/**
 * The read model, drawn the way the business draws a journey: instances, a parent spanning its
 * children, a sequence left to right, the active state of every box, and the events that moved
 * things underneath them. Every view is a projection of the frame, so stepping through a run
 * moves the colours through the journey.
 */
export function Overview({ model, run, index, since, selection, select, onIndex, eventsMode, onEventsMode }: Props) {
  const read = useMemo(() => overviewConfig(model), [model]);
  const errors = read.errors;
  const config = useMemo(() => withEventsMode(read.config, eventsMode), [read, eventsMode]);
  const asking = Object.keys(read.config.asks).length > 0;
  // A model that asks nothing has no "+ asks": what it shows by default is its statuses.
  const shownMode: EventsMode = !asking && eventsMode === "requests" ? "statuses" : eventsMode;
  const frame = run.frames[index]!;
  const prevFrame = since >= 0 ? run.frames[since] : undefined;
  const overview = useMemo(() => buildOverview(model, frame, run.world.log, config), [model, frame, run, config]);
  const before = useMemo(() => (prevFrame ? buildOverview(model, prevFrame, run.world.log, config) : undefined), [model, prevFrame, run, config]);
  const diff = useMemo(() => differences(before, overview), [before, overview]);
  const [unit, setUnit] = useState<string>();
  // ADR 0027 §4: only the events that move a box worked in another role.
  const hasRoles = (model.systems?.roles.length ?? 0) > 0;
  const [onlyForeign, setOnlyForeign] = useState(false);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [fitted, setFitted] = useState(1);
  const canvas = useRef<HTMLDivElement>(null);
  const roots = useRef<HTMLDivElement>(null);
  // Fit to width, down to the size at which a label stays readable; past that, scroll.
  useLayoutEffect(() => {
    const c = canvas.current;
    const r = roots.current;
    if (!c || !r) return;
    const measure = () => {
      // The row is max-content wide, so its on-screen width over the zoom applied is its
      // natural width — not the canvas it would otherwise stretch to (which fed back).
      const applied = Number(r.style.zoom) || 1;
      const natural = r.getBoundingClientRect().width / applied;
      // Fit the width, however small that makes it: manual zoom and Ctrl+wheel are for detail.
      setFitted(natural > 0 ? Math.min(1, (c.clientWidth - 24) / natural) : 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(c);
    return () => ro.disconnect();
  }, [overview]);
  const scaleRef = useRef(1);
  // Ctrl/⌘ + wheel (and a trackpad pinch, which browsers report the same way) zooms the picture.
  useLayoutEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom(Math.max(0.2, Math.min(2.5, scaleRef.current * Math.exp(-e.deltaY / 300))));
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
  }, []);
  const scale = zoom === "fit" ? fitted : zoom;
  scaleRef.current = scale;

  const ctx: Ctx = {
    changed: (key) => diff.boxes.has(key),
    fresh: (box, event) => diff.stickies.has(`${box}:${event}`),
    selected: selection?.kind === "instance" ? selection.key : undefined,
    unit,
    onlyForeign: hasRoles && onlyForeign,
    stickies: overview.stickies,
    asks: overview.asks,
    pick: (key) => select({ kind: "instance", key }),
    travel: (s) => { onIndex(frameOfEntry(run, s.seq)); select({ kind: "entry", seq: s.seq }); },
    travelTo: (seq) => { onIndex(frameOfEntry(run, seq)); select({ kind: "entry", seq }); },
  };

  return (
    <div className="ov">
      <div className="ov-head">
        <span className="ov-legend">
          {(Object.keys(GLYPH) as Tone[]).map((t) => <span key={t} className={`ov-pill t-${t}`}>{GLYPH[t]} {WORD[t]}</span>)}
          <span className="ov-sticky-key">event</span>
          {hasRoles && <span className="ov-sticky-key foreign" title="An event sent by another role than the one this box is worked in (ADR 0027)">↗ from elsewhere</span>}
          {asking && eventsMode === "requests" && <span className="ov-ask-key"><span className="ov-ask open">? asked</span> waiting · <span className="ov-ask answered">? asked</span> answered</span>}
        </span>
        <span className="map-levels" role="radiogroup" aria-label="Which events">
          {MODES.filter((m) => m.mode !== "requests" || asking).map((m) => (
            <button key={m.mode} role="radio" aria-checked={shownMode === m.mode} className={shownMode === m.mode ? "active" : ""}
              title={m.title} onClick={() => onEventsMode(m.mode)}>{m.label}</button>
          ))}
        </span>
        {hasRoles && (
          <button className={onlyForeign ? "active" : ""} aria-pressed={onlyForeign} onClick={() => setOnlyForeign(!onlyForeign)}
            title="Show only the events that move a box worked in another role — whose app sent them is in each one's tooltip">↗ only from elsewhere</button>
        )}
        {unit && <button onClick={() => setUnit(undefined)}>showing {unit.slice(unit.indexOf("#") + 1)} only — show all</button>}
        <span className="zoom" style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          <button onClick={() => setZoom(Math.max(0.2, scale / 1.2))} aria-label="Zoom out">−</button>
          <button onClick={() => setZoom("fit")} className={zoom === "fit" ? "active" : ""}
            title="Fit the width — Ctrl/⌘ + wheel zooms">{zoom === "fit" ? "fit" : `${Math.round(scale * 100)}% · fit`}</button>
          <button onClick={() => setZoom(Math.min(2.5, scale * 1.2))} aria-label="Zoom in">+</button>
        </span>
      </div>
      {errors.length > 0 && <div className="error-box" style={{ margin: "6px 12px" }}>{errors.join("\n")}</div>}
      <div className="ov-body">
        {overview.side.length > 0 && (
          <aside className="ov-side" aria-label="Things the journey is about">
            {overview.side.map((s) => {
              const path = s.config[0] ?? [];
              return (
                <button key={s.key} className={`ov-unit${unit === s.key ? " on" : ""}${ctx.selected === s.key ? " selected" : ""}`}
                  title="Show only where this one travels"
                  onClick={() => { setUnit(unit === s.key ? undefined : s.key); select({ kind: "instance", key: s.key }); }}>
                  <b>{s.key.slice(s.key.indexOf("#") + 1)}</b>
                  <small>{stateWords(path)}</small>
                </button>
              );
            })}
          </aside>
        )}
        <div className="ov-canvas" ref={canvas}>
          {overview.roots.length === 0 && overview.exceptions.length === 0 && <div className="hint" style={{ padding: 16 }}>Nothing to show yet — fire a command, or pick a scenario.</div>}
          <div className="ov-roots" ref={roots} style={{ zoom: scale }}>
            {overview.top.length > 0 && (
              <div className="ov-top" aria-label="On top">
                {overview.top.map((b) => <BoxView key={b.key} box={b} ctx={ctx} leafOnly />)}
              </div>
            )}
            <div className="ov-root-row">
              {overview.roots.map((b) => <Column key={b.key} box={b} ctx={ctx} />)}
            </div>
            {overview.exceptions.length > 0 && (
              <div className="ov-exceptions" aria-label={config.exceptionsTitle ?? "Exceptions"}>
                {config.exceptionsTitle && <div className="ov-exceptions-title">{config.exceptionsTitle}</div>}
                <div className="ov-root-row">
                  {overview.exceptions.map((b) => <Column key={b.key} box={b} ctx={ctx} />)}
                </div>
              </div>
            )}
          </div>
          {overview.others.length > 0 && (
            <div className="ov-others hint">
              also: {overview.others.map((o) => (
                <a key={o.key} href="#" onClick={(e) => { e.preventDefault(); ctx.pick(o.key); }}>
                  {o.key} <small>({stateWords(o.config[0] ?? [])})</small>
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface Ctx {
  changed: (key: string) => boolean;
  fresh: (box: string, event: string) => boolean;
  selected?: string;
  unit?: string;
  onlyForeign: boolean;
  stickies: Record<string, Sticky[]>;
  asks: Record<string, AskMark[]>;
  pick: (key: string) => void;
  travel: (s: Sticky) => void;
  travelTo: (seq: number) => void;
}

function Column({ box, ctx }: { box: Box; ctx: Ctx }) {
  const bands = box.groups.filter((g) => g.mode === "band");
  const rows = box.groups.filter((g) => g.mode !== "band");
  const leaf = rows.length === 0;
  const stickies = (ctx.stickies[box.key] ?? []).filter((s) => (!ctx.unit || s.raisers.includes(ctx.unit)) && (!ctx.onlyForeign || s.foreign));
  return (
    <div className={`ov-col${leaf ? " leaf" : ""}`}>
      <BoxView box={box} ctx={ctx} />
      {!leaf && stickies.length > 0 && <Stickies box={box.key} list={stickies} ctx={ctx} />}
      {bands.map((g) => (
        <div key={g.rel} className="ov-band" aria-label={g.rel}>
          {g.children.map((c) => <BoxView key={c.key} box={c} ctx={ctx} small />)}
        </div>
      ))}
      {rows.map((g) => (
        g.layers
          // Linked by which follows which: a column per layer, so a merge reads as one.
          ? <div key={g.rel} className="ov-row sequence layered" aria-label={g.rel}>
              {g.layers.map((layer, i) => (
                <div key={i} className="ov-layer">
                  {layer.map((c) => <Column key={c.key} box={c} ctx={ctx} />)}
                </div>
              ))}
            </div>
          : <div key={g.rel} className={`ov-row ${g.mode}`} aria-label={g.rel}>
              {g.children.map((c) => <Column key={c.key} box={c} ctx={ctx} />)}
            </div>
      ))}
      {leaf && <div className="ov-lane">{stickies.length > 0 && <Stickies box={box.key} list={stickies} ctx={ctx} />}</div>}
    </div>
  );
}

/** `leafOnly`: the top lane says where the reader is ("ordered"), not how the chart nests it. */
function BoxView({ box, ctx, small, leafOnly }: { box: Box; ctx: Ctx; small?: boolean; leafOnly?: boolean }) {
  const dim = ctx.unit !== undefined && box.carries.length > 0 && !box.carries.includes(ctx.unit);
  return (
    <button
      className={`ov-box f-${box.family} k-${box.tint} t-${box.tone}${small ? " small" : ""}${ctx.changed(box.key) ? " changed" : ""}${ctx.selected === box.key ? " selected" : ""}${dim ? " dim" : ""}`}
      onClick={() => ctx.pick(box.key)}
      title={`${box.key} — ${stateWords(box.path)}`}
    >
      {/* The label says what this one is; the id is in the tooltip and the inspector. */}
      <span className="ov-type">{box.machine}{!box.label && <> <span className="ov-id">{box.id}</span></>}</span>
      {box.label && <span className="ov-label">{box.label}</span>}
      {box.labelError && <span className="ov-label error" title={box.labelError}>⚠ {box.labelError}</span>}
      <span className={`ov-pill t-${box.tone}`}>{GLYPH[box.tone]} {stateWords(leafOnly ? box.path.slice(-1) : box.path)}</span>
      {(ctx.asks[box.key] ?? []).map((a) => <AskView key={a.event} mark={a} ctx={ctx} />)}
      {box.summaries.map((s) => (
        <span key={s.rel} className="ov-summary" title={s.byState.map((x) => `${x.state.replace(/_/g, " ")}: ${x.items.map((i) => i.label).join(", ")}`).join("; ")}>
          {s.byState.flatMap((x) => byNote(x.items).map((row) => (
            // Which samples, per outcome — "✓ S6 ✗ S7", not "✓1 ✗1" — and any further attributes.
            <span key={`${x.state}:${row.note ?? ""}`} className="ov-note-row">
              <span className={`ov-outcome t-${x.tone}`}>
                <span className="ov-glyph">{GLYPH[x.tone]}</span>
                {/* The glyph says enough for a lifecycle outcome; any other state names itself. */}
                {!LIFECYCLE.test(x.state) && <span className="ov-word">{x.state.replace(/_/g, " ")}</span>}
                <Badges items={row.items} ctx={ctx} />
              </span>
              {row.note && <span className="ov-note">{row.note}</span>}
            </span>
          )))}
        </span>
      ))}
    </button>
  );
}

/**
 * An ask on a box (ADR 0023): amber while any is waiting, grey once all are answered — with what
 * answered, when it is one thing. Clicking it travels to the ask.
 */
function AskView({ mark, ctx }: { mark: AskMark; ctx: Ctx }) {
  const mine = mark.occurrences.filter((o) => !ctx.unit || o.subject === ctx.unit);
  if (mine.length === 0) return null;
  const open = mine.filter((o) => !o.answer);
  const answers = [...new Set(mine.flatMap((o) => (o.answer ? [o.answer.event] : [])))];
  const said = open.length === 0 && answers.length === 1 ? `: ${spoken(answers[0]!).toLowerCase()}`
    : open.length > 0 && open.length < mine.length ? ` · ${open.length} waiting` : "";
  const first = open[0] ?? mine[mine.length - 1]!;
  return (
    <span role="button" tabIndex={0} className={`ov-ask ${open.length > 0 ? "open" : "answered"}`}
      title={`${spoken(mark.event)}${mine.length > 1 ? ` — ${mine.length}×` : ""}\n${mine.map((o) => `${o.label}: ${o.answer ? `answered — ${spoken(o.answer.event)}` : "waiting"}`).join("\n")}\nClick to travel to ${open.length > 0 ? "the one waiting" : "it"}.`}
      onClick={(e) => { e.stopPropagation(); ctx.travelTo(first.seq); }}
      onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); ctx.travelTo(first.seq); } }}>
      {mark.icon} {mark.mark}{mine.length > 1 ? ` ×${mine.length}` : ""}{said}
    </span>
  );
}

/** Named pills; clicking one selects what it names. A long list folds into "+n". */
function Badges({ items, ctx }: { items: Badge[]; ctx: Ctx }) {
  const shown = items.slice(0, 6);
  return (
    <span className="ov-badges">
      {shown.map((b) => (
        <span key={b.key} role="button" tabIndex={0} className={`ov-badge${ctx.unit === b.key ? " on" : ""}`}
          onClick={(e) => { e.stopPropagation(); ctx.pick(b.key); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); ctx.pick(b.key); } }}>{b.label}</span>
      ))}
      {items.length > shown.length && <span className="ov-badge more">+{items.length - shown.length}</span>}
    </span>
  );
}

/** Who owns an event (ADR 0027): its role and the part that sent it, and where it reached over to. */
function ownerWords(s: Sticky): string {
  if (!s.owner) return "";
  const who = `sent by ${s.owner.sender ?? "a part"} as ${s.owner.role}`;
  return s.foreign ? ` — ${who}; moves this step, worked in ${s.foreign.boxRole}` : ` — ${who}`;
}

function Stickies({ box, list, ctx }: { box: string; list: Sticky[]; ctx: Ctx }) {
  return (
    <div className="ov-stickies">
      {list.map((s) => (
        <div key={s.event} className={`ov-sticky${ctx.fresh(box, s.event) ? " fresh" : ""}${s.foreign && s.owner ? ` foreign f-${s.owner.family}` : ""}`}>
          <button className="ov-sticky-name" onClick={() => ctx.travel(s)}
            title={`${s.event} — ${s.count}×, for ${s.badges.map((b) => b.label).join(", ")}${s.statuses ? ` — ${s.statuses.map((g) => `${g.state}: ${g.badges.map((b) => b.label).join(", ")}`).join("; ")}` : ""}${ownerWords(s)}. Click to travel to the first.`}>
            {spoken(s.event)}
          </button>
          {s.foreign && s.owner && <span className="ov-from" title={ownerWords(s).replace(/^ — /, "")}>↗ {s.owner.role}</span>}
          {s.statuses
            // A deviation's substatus is a state of the status itself: pending, resolved, confirmed.
            ? s.statuses.flatMap((g) => byNote(g.badges).map((row) => (
                <span key={`${g.state}:${row.note ?? ""}`} className="ov-note-row">
                  <span className={`ov-outcome ov-status t-${g.tone}`}>
                    <span className="ov-glyph">{GLYPH[g.tone]}</span>
                    <span className="ov-word">{g.state.replace(/_/g, " ")}</span>
                    <Badges items={row.items} ctx={ctx} />
                  </span>
                  {row.note && <span className="ov-note">{row.note}</span>}
                </span>
              )))
            : byNote(s.badges).map((row) => (
                <span key={row.note ?? ""} className="ov-note-row">
                  <Badges items={row.items} ctx={ctx} />
                  {row.note && <span className="ov-note">{row.note}</span>}
                </span>
              ))}
        </div>
      ))}
    </div>
  );
}
