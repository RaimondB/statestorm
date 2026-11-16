import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Frame, Model } from "@statestorm/kernel";
import { packageTypes } from "../boundaries.ts";
import { DEFAULT_ERD, ERD, layoutErd, neighbourhood, structureOf, type ErdLayout, type ErdOptions, type PlacedRel } from "../erd.ts";
import { overviewConfig } from "../overview.ts";
import { estimate, type Measure } from "../chart-layout.ts";

const FONTS = { title: "700 14px system-ui, sans-serif", label: "12px system-ui, sans-serif", small: "12px ui-monospace, monospace" };
let ctx: CanvasRenderingContext2D | null | undefined;
const measure: Measure = (text, font) => {
  ctx ??= document.createElement("canvas").getContext("2d");
  if (!ctx) return estimate(text, font);
  ctx.font = FONTS[font];
  return ctx.measureText(text).width;
};

interface Props {
  model: Model;
  frame: Frame;
  /** A type, or `package:<name>` — what the structure is focused on, and what the about panel tells. */
  focus?: string;
  /** Focusing a type or a package selects it too: the inspector shows what the docs say of it. */
  onFocus: (focus?: string) => void;
}

/**
 * Every type of the model and how they hang together, as an ERD: who owns whom (crow's foot at
 * the many end), who points at whom (dashed), who refines whom (hollow triangle). What a box
 * lists is what its type declares; inherited fields are on the supertype.
 */
export function Structure({ model, frame, focus, onFocus: setFocus }: Props) {
  const structure = useMemo(() => structureOf(model), [model]);
  const [options, setOptions] = useState<ErdOptions>(DEFAULT_ERD);
  const [layout, setLayout] = useState<ErdLayout>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    layoutErd(structure, options, measure).then(
      (l) => { if (live) { setLayout(l); setError(undefined); } },
      (err) => { if (live) setError(String(err)); },
    );
    return () => { live = false; };
  }, [structure, options]);
  const focusPackage = focus?.startsWith("package:") ? focus.slice("package:".length) : undefined;
  const focusType = focus && !focusPackage ? focus : undefined;
  useEffect(() => {
    if (focusType && !model.aggregates[focusType] && !model.values[focusType]) setFocus(undefined);
    if (focusPackage && !model.packages.some((p) => p.name === focusPackage)) setFocus(undefined);
  }, [model, focusType, focusPackage, setFocus]);
  const packaged = useMemo(() => packageTypes(model), [model]);

  // The overview's colour families, so a type looks the same in both views.
  const colours = useMemo(() => overviewConfig(model).config.color, [model]);
  const familyOf = (name: string) => {
    const lineage = [name, ...(model.aggregates[name]?.ancestors ?? [])];
    return lineage.map((t) => colours[t]).find((f) => f !== undefined) ?? "grey";
  };
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const i of Object.values(frame.instances)) out.set(i.machine, (out.get(i.machine) ?? 0) + 1);
    return out;
  }, [frame]);
  // Around a type: it and its neighbours; a package: its types.
  const near = focusType ? neighbourhood(structure, focusType) : focusPackage ? new Set(packaged.get(focusPackage) ?? []) : undefined;

  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [fitted, setFitted] = useState(1);
  const canvas = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const c = canvas.current;
    if (!c || !layout) return;
    const measureFit = () => setFitted(layout.width > 0 ? Math.min(1, (c.clientWidth - 24) / layout.width) : 1);
    measureFit();
    const ro = new ResizeObserver(measureFit);
    ro.observe(c);
    return () => ro.disconnect();
  }, [layout]);
  const scale = zoom === "fit" ? fitted : zoom;

  // A focus that arrives from elsewhere — a link in the docs — is brought into view at full size; one
  // clicked here is already in view, and the picture stays as it is.
  const clicked = useRef(false);
  const focusHere = (f?: string) => { clicked.current = true; setFocus(f); };
  const [arrived, setArrived] = useState<string>();
  useEffect(() => {
    if (clicked.current) { clicked.current = false; return; }
    if (focus) { setArrived(focus); setZoom(1); }
  }, [focus]);
  useLayoutEffect(() => {
    const c = canvas.current;
    if (!arrived || !layout || !c || scale !== 1) return;
    const box = focusPackage ? layout.packages.find((p) => p.name === focusPackage) : layout.types.find((t) => t.name === focusType);
    if (box) c.scrollTo({ left: Math.max(0, box.x + box.width / 2 - c.clientWidth / 2), top: Math.max(0, box.y + (focusPackage ? 0 : box.height / 2 - c.clientHeight / 2)) });
    setArrived(undefined);
  }, [arrived, layout, scale, focusPackage, focusType]);
  const toggle = (k: keyof ErdOptions) => setOptions({ ...options, [k]: !options[k] });

  return (
    <div className="ov erd">
      <div className="ov-head">
        <span className="ov-legend erd-legend">
          <span><svg width="46" height="12"><line x1="2" y1="6" x2="44" y2="6" className="erd-rel owns" /></svg> owns</span>
          <span><svg width="46" height="12"><line x1="2" y1="6" x2="44" y2="6" className="erd-rel refers" /></svg> points at</span>
          <span><svg width="46" height="12"><line x1="2" y1="6" x2="44" y2="6" className="erd-rel extends" /></svg> refines</span>
          <span><svg width="46" height="12"><line x1="2" y1="6" x2="44" y2="6" className="erd-rel uses" /></svg> uses a value</span>
          <span className="erd-key-frame">aggregate boundary</span>
        </span>
        <label className="hint"><input type="checkbox" checked={options.fields} onChange={() => toggle("fields")} /> fields</label>
        <label className="hint"><input type="checkbox" checked={options.states} onChange={() => toggle("states")} /> lifecycle</label>
        <label className="hint"><input type="checkbox" checked={options.inheritance} onChange={() => toggle("inheritance")} /> inheritance</label>
        <label className="hint" title="What a concrete type has from its supertypes: its fields, greyed, and the lines between concrete types">
          <input type="checkbox" checked={options.inherited} onChange={() => toggle("inherited")} /> inherited fields &amp; lines</label>
        {model.packages.length > 0 && (
          <label className="hint"><input type="checkbox" checked={options.packages} onChange={() => toggle("packages")} /> packages</label>
        )}
        {focus && <button onClick={() => focusHere(undefined)}>{focusPackage ? `package ${focusPackage}` : `around ${focusType}`} — show all</button>}
        <span className="zoom" style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          <button onClick={() => setZoom(Math.max(0.2, scale / 1.2))} aria-label="Zoom out">−</button>
          <button onClick={() => setZoom("fit")} className={zoom === "fit" ? "active" : ""}>{zoom === "fit" ? "fit" : `${Math.round(scale * 100)}% · fit`}</button>
          <button onClick={() => setZoom(Math.min(2.5, scale * 1.2))} aria-label="Zoom in">+</button>
        </span>
      </div>
      {error && <div className="error-box" style={{ margin: "6px 12px" }}>Layout failed: {error}</div>}
      {structure.errors.length > 0 && <div className="error-box" style={{ margin: "6px 12px" }}>{structure.errors.join("\n")}</div>}
      <div className="ov-canvas" ref={canvas} onClick={() => focusHere(undefined)}>
        {!layout ? <div className="hint" style={{ padding: 16 }}>Laying out…</div> : (
          <svg width={layout.width * scale} height={layout.height * scale} viewBox={`0 0 ${layout.width} ${layout.height}`}
            role="img" aria-label={`Structure of ${model.context}`}>
            {layout.packages.map((p) => {
              const tab = Math.min(p.width - 8, Math.max(140, p.name.length * 9 + 28));
              return (
                <g key={p.name} className={`erd-package${focusPackage === p.name ? " focus" : ""}${near && focusPackage && focusPackage !== p.name ? " faded" : ""}`}>
                  <path d={`M${p.x},${p.y + 26} V${p.y + 4} Q${p.x},${p.y} ${p.x + 4},${p.y} H${p.x + tab - 4} Q${p.x + tab},${p.y} ${p.x + tab},${p.y + 4} V${p.y + 26}`} className="erd-package-tab"
                    role="button" onClick={(e) => { e.stopPropagation(); focusHere(focusPackage === p.name ? undefined : `package:${p.name}`); }}>
                    <title>{`package ${p.name} — click to focus on it`}</title>
                  </path>
                  <rect x={p.x} y={p.y + 26} width={p.width} height={p.height - 26} rx={4} className="erd-package-body" />
                  <text x={p.x + 10} y={p.y + 18} className="erd-package-name">{p.name}</text>
                  {p.note && <text x={p.x + 10} y={p.y + 42} className="erd-package-note">{fit(p.note, p.width - 20, 6.4)}<title>{p.note}</title></text>}
                </g>
              );
            })}
            {layout.frames.map((f) => (
              <g key={f.name} className={`erd-frame${near && !near.has(f.name) ? " faded" : ""}`}>
                <rect x={f.x} y={f.y} width={f.width} height={f.height} rx={12} />
                <text x={f.x + 14} y={f.y + 21}>{fit(`${f.name} — one aggregate: it and what it owns`, f.width - 28, 6.8)}</text>
              </g>
            ))}
            {layout.rels.map((r) => (
              <g key={r.id} className={`erd-line${near && !(near.has(r.from) && near.has(r.to) && (focusPackage || r.from === focusType || r.to === focusType)) ? " faded" : ""}`}>
                <path d={`M${r.points.map((p) => `${p.x},${p.y}`).join(" L")}`} className={`erd-rel ${r.kind}${r.derivedFrom ? " derived" : ""}`} />
                <Ends rel={r} />
                {r.labelBox && r.label && (
                  <text x={r.labelBox.x + 3} y={r.labelBox.y + 12} className="erd-label">{r.label}</text>
                )}
                <title>{r.kind === "owns" ? `${r.from} owns many ${r.to} (${r.label}${r.derivedFrom ? ` — the relation ${r.derivedFrom} declares, as ${r.from} uses it` : ""})` : r.kind === "refers" ? `each ${r.from} points at one ${r.to} (${r.label})`
                  : r.kind === "uses" ? `${r.from} uses the value object ${r.to} (${r.label})` : `${r.from} refines ${r.to}`}</title>
              </g>
            ))}
            {layout.types.map((t) => {
              const n = counts.get(t.name) ?? 0;
              return (
                <g key={t.name} transform={`translate(${t.x},${t.y})`}
                  className={`erd-box r-${t.role} f-${t.role === "value" ? "value" : familyOf(t.name)}${t.abstract ? " abstract" : ""}${near && !near.has(t.name) ? " faded" : ""}${focusType === t.name ? " focus" : ""}`}
                  onClick={(e) => { e.stopPropagation(); focusHere(focusType === t.name ? undefined : t.name); }} role="button">
                  <title>{`${t.name} — ${ROLE[t.role]}${t.abstract ? "; abstract: a skeleton its subtypes refine, never an instance" : ""}${t.extends ? `; refines ${t.extends}` : ""}. Click to focus on it.`}</title>
                  <rect width={t.width} height={t.height} rx={6} className="erd-body" />
                  <path d={`M0,6 Q0,0 6,0 H${t.width - 6} Q${t.width},0 ${t.width},6 V${ERD.head - 6} H0 Z`} className="erd-head" />
                  <text x={ERD.pad} y={14} className="erd-stereo">«{t.role === "value" ? "value object" : t.role}»{t.abstract ? " abstract" : ""}{t.refinesElsewhere ? ` ▷ ${t.extends}` : ""}</text>
                  <text x={ERD.pad} y={31} className="erd-name">{t.name}</text>
                  {n > 0 && <text x={t.width - ERD.pad} y={31} textAnchor="end" className="erd-count">{n}</text>}
                  {t.lines.map((l, i) => (
                    <text key={i} x={ERD.pad} y={ERD.head + ERD.pad / 2 + 12 + i * ERD.line} className={`erd-field${l.inherited ? " inherited" : ""}`}>
                      {l.text}{l.inherited && <title>{`inherited from ${l.inherited}`}</title>}
                    </text>
                  ))}
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
}

/** Text cut to a width (at about `perChar` px a character), so a label never runs into its neighbour. */
function fit(text: string, width: number, perChar: number): string {
  const max = Math.max(8, Math.floor(width / perChar));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const ROLE = {
  aggregate: "an aggregate: a consistency boundary, with an identity and a lifecycle; commands go to it",
  entity: "an entity: an identity and a lifecycle, inside its aggregate, reached only through it",
  value: "a value object: no identity, no lifecycle — a named set of fields",
} as const;

/** The ends of a line, ERD fashion: a crow's foot at the many end, a bar at the one end; a hollow
 *  triangle at the supertype. */
function Ends({ rel }: { rel: PlacedRel }) {
  const p = rel.points;
  if (p.length < 2) return null;
  const at = (end: "from" | "to") => {
    const [tip, prev] = end === "to" ? [p[p.length - 1]!, p[p.length - 2]!] : [p[0]!, p[1]!];
    const len = Math.hypot(tip.x - prev.x, tip.y - prev.y) || 1;
    const [ux, uy] = [(tip.x - prev.x) / len, (tip.y - prev.y) / len];   // pointing into the box
    return { tip, ux, uy, px: -uy, py: ux };
  };
  const foot = (end: "from" | "to") => {
    const { tip, ux, uy, px, py } = at(end);
    const b = { x: tip.x - ux * 13, y: tip.y - uy * 13 };
    return <path className={`erd-end ${rel.kind}`} d={`M${b.x},${b.y} L${tip.x + px * 7},${tip.y + py * 7} M${b.x},${b.y} L${tip.x},${tip.y} M${b.x},${b.y} L${tip.x - px * 7},${tip.y - py * 7}`} />;
  };
  const bar = (end: "from" | "to") => {
    const { tip, ux, uy, px, py } = at(end);
    const c = { x: tip.x - ux * 9, y: tip.y - uy * 9 };
    return <path className={`erd-end ${rel.kind}`} d={`M${c.x + px * 6},${c.y + py * 6} L${c.x - px * 6},${c.y - py * 6}`} />;
  };
  if (rel.kind === "uses") {
    const { tip, ux, uy, px, py } = at("to");
    const b = { x: tip.x - ux * 10, y: tip.y - uy * 10 };
    return <path className="erd-end uses" d={`M${b.x + px * 6},${b.y + py * 6} L${tip.x},${tip.y} L${b.x - px * 6},${b.y - py * 6}`} />;
  }
  if (rel.kind === "extends") {
    const { tip, ux, uy, px, py } = at("to");
    const b = { x: tip.x - ux * 12, y: tip.y - uy * 12 };
    return <path className="erd-end extends" d={`M${tip.x},${tip.y} L${b.x + px * 7},${b.y + py * 7} L${b.x - px * 7},${b.y - py * 7} Z`} />;
  }
  return rel.kind === "owns" ? <>{bar("from")}{foot("to")}</> : <>{foot("from")}{bar("to")}</>;
}
