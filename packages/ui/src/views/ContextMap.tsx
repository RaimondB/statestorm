import type { Selection } from "../selection.ts";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { contextMap, scopesOf, type Level, type Model } from "@statestorm/kernel";
import { layoutMap, MAP, type MapLayout, type PlacedEdge } from "../context-map.ts";
import { estimate, type Measure } from "../chart-layout.ts";

const FONTS = { title: "700 14px system-ui, sans-serif", label: "12px system-ui, sans-serif", small: "12px ui-monospace, monospace" };
let ctx: CanvasRenderingContext2D | null | undefined;
const measure: Measure = (text, font) => {
  ctx ??= document.createElement("canvas").getContext("2d");
  if (!ctx) return estimate(text, font);
  ctx.font = FONTS[font];
  return ctx.measureText(text).width;
};

export const LEVELS: { level: Level; label: string; title: string }[] = [
  { level: "domain", label: "domains", title: "The domains of the landscape — each a group of systems (ADR 0020)" },
  { level: "system", label: "systems", title: "The software systems, ours and outside" },
  { level: "context", label: "bounded contexts", title: "The bounded contexts — a context may span systems" },
  { level: "subsystem", label: "sub-systems", title: "One system's sub-systems (its C4 containers), with the systems around it" },
];

/**
 * The level and, at sub-system level, which system — one of ours, or a vendor's in parts — shared by
 * the map and the sequence. The domain level shows only when the model names domains.
 */
export function useLevel(model: Model): { level: Level; scope?: string; own: string[]; picker: ReactElement } {
  const own = useMemo(() => scopesOf(model), [model]);
  const levels = LEVELS.filter((l) => l.level !== "domain" || (model.systems?.domains.length ?? 0) > 0);
  const [chosen, setLevel] = useState<Level>("system");
  const level = levels.some((l) => l.level === chosen) ? chosen : "system";
  const [scope, setScope] = useState<string>();
  const current = scope && own.includes(scope) ? scope : own[0];
  const picker = (
    <span className="map-levels" role="radiogroup" aria-label="Level">
      {levels.map((l) => (
        <button key={l.level} role="radio" aria-checked={level === l.level} className={level === l.level ? "active" : ""}
          title={l.title} onClick={() => setLevel(l.level)}>{l.label}</button>
      ))}
      {level === "subsystem" && own.length > 1 && (
        <select value={current} onChange={(e) => setScope(e.target.value)} aria-label="System">
          {own.map((s) => <option key={s}>{s}</option>)}
        </select>
      )}
    </span>
  );
  return { level, ...(level === "subsystem" && current ? { scope: current } : {}), own, picker };
}

/**
 * Who talks to whom (ADR 0018 §4): an edge where a policy carries an event from one system, context
 * or sub-system to another, or an external system sends or is told something. Derived from the
 * model — no run needed.
 */
/**
 * A node or an edge clicked: the inspector says what it is — its note, team, packages, relations,
 * what crosses — and what the domain's docs say of it.
 */
export function ContextMap({ model, select }: { model: Model; select: (s: Selection) => void }) {
  const { level, scope, picker } = useLevel(model);
  const map = useMemo(() => {
    try { return { map: model.systems ? contextMap(model, level, scope) : undefined }; }
    catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
  }, [model, level, scope]);
  const [layout, setLayout] = useState<MapLayout>();
  const [error, setError] = useState<string>();
  const [picked, setPicked] = useState<PlacedEdge>();
  useEffect(() => {
    let live = true;
    setPicked(undefined);
    if (!map.map) { setLayout(undefined); return; }
    layoutMap(map.map, measure).then((l) => { if (live) { setLayout(l); setError(undefined); } }, (err) => { if (live) setError(String(err)); });
    return () => { live = false; };
  }, [map]);

  const canvas = useRef<HTMLDivElement>(null);
  const [fitted, setFitted] = useState(1);
  useLayoutEffect(() => {
    const c = canvas.current;
    if (!c || !layout) return;
    const fit = () => setFitted(layout.width > 0 ? Math.max(0.8, Math.min(1, (c.clientWidth - 24) / layout.width)) : 1);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(c);
    return () => ro.disconnect();
  }, [layout]);

  if (!model.systems) return <NoSystems model={model} />;
  return (
    <div className="ov map">
      <div className="ov-head">
        {picker}
        <span className="ov-legend">
          <span><span className="map-key system" /> ours</span>
          <span><span className="map-key external" /> outside</span>
          <span className="hint">upstream above, downstream below</span>
        </span>
      </div>
      {(map.error || error) && <div className="error-box" style={{ margin: "6px 12px" }}>{map.error ?? `Layout failed: ${error}`}</div>}
      <div className="ov-canvas" ref={canvas} onClick={() => setPicked(undefined)}>
        {!layout ? <div className="hint" style={{ padding: 16 }}>Laying out…</div> : (
          <svg width={layout.width * fitted} height={layout.height * fitted} viewBox={`0 0 ${layout.width} ${layout.height}`}
            role="img" aria-label={`Context map of ${model.context}, at ${level} level`}>
            <defs>
              <marker id="map-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className="map-head" />
              </marker>
            </defs>
            {layout.edges.map((e, i) => (
              <g key={i} className={`map-edge${picked && picked.from === e.from && picked.to === e.to ? " picked" : ""}`} role="button"
                onClick={(ev) => { ev.stopPropagation(); setPicked(e); select({ kind: "flow", from: e.from, to: e.to, events: e.events, commands: e.commands, patterns: e.patterns }); }}>
                <title>{`${e.from} → ${e.to}${e.patterns.length ? ` (${e.patterns.join(", ")})` : ""}\nevents: ${e.events.join(", ") || "—"}\ncommands: ${e.commands.join(", ") || "—"}`}</title>
                <path d={`M${e.points.map((p) => `${p.x},${p.y}`).join(" L")}`} className="map-line" markerEnd="url(#map-head)" />
                {e.label && <text x={e.label.x + 4} y={e.label.y + 12} className="map-label">{e.label.text}</text>}
              </g>
            ))}
            {layout.nodes.map((n) => (
              <g key={n.id} transform={`translate(${n.x},${n.y})`} className={`map-node ${n.kind}`} role="button"
                onClick={(ev) => {
                  ev.stopPropagation();
                  setPicked(undefined);
                  select(n.kind === "external" ? { kind: "place", level: "system", name: n.id }
                    : n.kind === "subsystem" ? { kind: "place", level: "subsystem", name: n.id, ...(scope ? { system: scope } : {}) }
                    : { kind: "place", level: n.kind, name: n.id });
                }}>
                <title>{`${n.id}${n.note ? ` — ${n.note}` : ""} — what it is, in the inspector`}</title>
                <rect width={n.width} height={n.height} rx={n.kind === "context" ? 18 : 6} />
                <text x={n.width / 2} y={MAP.pad + 12} textAnchor="middle" className="map-name">{n.id}</text>
                {n.lines.map((l, j) => (
                  <text key={j} x={n.width / 2} y={MAP.pad + 12 + MAP.line * (j + 1)} textAnchor="middle" className="map-sub">{l}</text>
                ))}
              </g>
            ))}
          </svg>
        )}
      </div>
    </div>
  );
}

export function NoSystems({ model }: { model: Model }) {
  return (
    <div className="ov">
      <div className="hint" style={{ padding: 16, maxWidth: 640 }}>
        {model.context} declares no systems. Group its packages into sub-systems, systems and bounded contexts with a
        <code> systems:</code> section — and name the systems outside it, with what they send and receive (ADR 0018).
      </div>
    </div>
  );
}
