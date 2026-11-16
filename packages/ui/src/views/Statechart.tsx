import { useEffect, useMemo, useState } from "react";
import { refOf, type Frame, type LogEntry, type MachineDef, type Model } from "@statestorm/kernel";
import { layoutMachine, type ChartLayout, type Measure } from "../chart-layout.ts";
import { machineOfKey } from "../session.ts";
import type { Selection } from "../selection.ts";

const FONTS = { title: "600 14px system-ui, sans-serif", label: "12px system-ui, sans-serif", small: "12px ui-monospace, monospace" };
let ctx: CanvasRenderingContext2D | null | undefined;
const measure: Measure = (text, font) => {
  ctx ??= document.createElement("canvas").getContext("2d");
  if (!ctx) return text.length * 8;
  ctx.font = FONTS[font];
  return ctx.measureText(text).width;
};

// Layout depends on the machine definition only, so a reloaded model re-lays-out and a new
// frame does not.
const cache = new WeakMap<MachineDef, Promise<ChartLayout>>();
function layoutOf(machine: MachineDef): Promise<ChartLayout> {
  let p = cache.get(machine);
  if (!p) cache.set(machine, (p = layoutMachine(machine, measure)));
  return p;
}

/** Beyond this many aggregates, one picker instead of a tab each. */
const MAX_TABS = 8;

interface Props {
  model: Model;
  machine: string;
  setMachine: (m: string) => void;
  frame: Frame;
  log: LogEntry[];
  /** Log length at the previous frame: entries after it are what *this* step did. */
  prevSeq: number;
  selection: Selection;
  select: (s: Selection) => void;
}

/**
 * R24: one machine, nested states as compound boxes, live instances lit on their *whole*
 * active configuration — every enclosing composite, not just the leaf.
 */
export function Statechart({ model, machine, setMachine, frame, log, prevSeq, selection, select }: Props) {
  const def = model.aggregates[machine] ?? model.policies[machine];
  const [layout, setLayout] = useState<{ def: MachineDef; layout: ChartLayout }>();
  const [error, setError] = useState<string>();
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [boxWidth, setBoxWidth] = useState(800);

  useEffect(() => {
    if (!def) return;
    let live = true;
    layoutOf(def).then(
      (l) => { if (live) { setLayout({ def, layout: l }); setError(undefined); } },
      (err) => { if (live) setError(String(err)); },
    );
    return () => { live = false; };
  }, [def]);

  useEffect(() => {
    if (!box) return;
    const ro = new ResizeObserver(([e]) => setBoxWidth(e!.contentRect.width));
    ro.observe(box);
    return () => ro.disconnect();
  }, [box]);

  const selectedKey = selection?.kind === "instance" ? selection.key : undefined;

  // Who is where: every active ref of every instance of this machine.
  const occupancy = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const inst of Object.values(frame.instances)) {
      if (inst.machine !== machine) continue;
      for (const path of inst.config) {
        for (let i = 1; i <= path.length; i++) {
          const ref = refOf(path.slice(0, i));
          out.set(ref, [...(out.get(ref) ?? []), inst.key]);
        }
      }
    }
    return out;
  }, [frame, machine]);
  const leaves = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const inst of Object.values(frame.instances)) {
      if (inst.machine !== machine) continue;
      for (const path of inst.config) {
        const ref = refOf(path);
        out.set(ref, [...(out.get(ref) ?? []), inst.key]);
      }
    }
    return out;
  }, [frame, machine]);

  // The transitions *this step* took, by id — the log records the winner as `via`.
  const fired = useMemo(() => {
    const out = new Set<string>();
    for (const e of log) {
      if (e.seq <= prevSeq || e.seq > frame.seq) continue;
      if ((e.kind === "transition" || e.kind === "policy") && machineOfKey(e.instance) === machine) out.add(e.via);
    }
    return out;
  }, [log, prevSeq, frame.seq, machine]);

  const tabs = [
    ...Object.values(model.aggregates).map((a) => ({ n: a.name, policy: false, abstract: a.abstract, ancestors: a.ancestors })),
    ...Object.keys(model.policies).map((n) => ({ n, policy: true, abstract: false, ancestors: [] as string[] })),
  ];

  const aggregateTabs = tabs.filter((t) => !t.policy);
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const i of Object.values(frame.instances)) out.set(i.machine, (out.get(i.machine) ?? 0) + 1);
    return out;
  }, [frame]);
  const countOf = (n: string) => counts.get(n) ?? 0;

  const l = layout && layout.def === def ? layout.layout : undefined;
  // Fit to width, but never below the size at which a 12px label stops being readable on a
  // projector — past that, scrolling beats squinting.
  const scale = !l ? 1 : zoom === "fit" ? Math.max(0.7, Math.min(1, (boxWidth - 8) / l.width)) : zoom;

  return (
    <>
      <div className="tabs">
        {/* A tab per type while they fit on a line or two; a real model has dozens, and seven
            rows of tabs left the chart a strip too thin to show anything. */}
        {aggregateTabs.length <= MAX_TABS ? aggregateTabs.map(({ n, abstract, ancestors }) => (
          <button key={n} className={`${n === machine ? "active" : ""}${abstract ? " abstract" : ""}`} onClick={() => setMachine(n)}
            title={abstract ? "abstract — a skeleton its subclasses refine" : ancestors.length ? `extends ${ancestors.join(" → ")}` : "aggregate"}>
            {n}{countOf(n) ? ` · ${countOf(n)}` : ""}
          </button>
        )) : (
          <select className={`type-pick${model.aggregates[machine] ? " active" : ""}`} value={model.aggregates[machine] ? machine : ""}
            onChange={(e) => e.target.value && setMachine(e.target.value)} aria-label="Show an aggregate">
            {!model.aggregates[machine] && <option value="">aggregates ({aggregateTabs.length})</option>}
            <optgroup label="with instances in this run">
              {aggregateTabs.filter((t) => countOf(t.n) > 0).map(({ n, ancestors }) => (
                <option key={n} value={n}>{n} · {countOf(n)}{ancestors.length ? `  (extends ${ancestors[0]})` : ""}</option>
              ))}
            </optgroup>
            <optgroup label="none yet">
              {aggregateTabs.filter((t) => countOf(t.n) === 0).map(({ n, abstract, ancestors }) => (
                <option key={n} value={n}>{abstract ? `${n} — abstract` : n}{!abstract && ancestors.length ? `  (extends ${ancestors[0]})` : ""}</option>
              ))}
            </optgroup>
          </select>
        )}
        {/* Policies are the wiring, and a real model has many: one control, not a tab each. */}
        {tabs.some((t) => t.policy) && (
          <select className={`policy-pick${model.policies[machine] ? " active" : ""}`} value={model.policies[machine] ? machine : ""}
            onChange={(e) => e.target.value && setMachine(e.target.value)} aria-label="Show a policy">
            <option value="">◇ policies ({Object.keys(model.policies).length})</option>
            {tabs.filter((t) => t.policy).map(({ n }) => {
              return <option key={n} value={n}>◇ {n}{countOf(n) ? ` · ${countOf(n)}` : ""}</option>;
            })}
          </select>
        )}
        <span className="zoom">
          <button onClick={() => setZoom(Math.max(0.2, (typeof zoom === "number" ? zoom : scale) / 1.25))} aria-label="Zoom out">−</button>
          <button onClick={() => setZoom("fit")} className={zoom === "fit" ? "active" : ""}>fit</button>
          <button onClick={() => setZoom(Math.min(3, (typeof zoom === "number" ? zoom : scale) * 1.25))} aria-label="Zoom in">+</button>
        </span>
      </div>
      <div className="canvas" ref={setBox}>
        {error && <div className="error-box">Layout failed: {error}</div>}
        {!def && <div className="hint" style={{ padding: 16 }}>Pick a machine.</div>}
        {l && def && (
          <svg width={l.width * scale} height={l.height * scale} viewBox={`0 0 ${l.width} ${l.height}`}
            role="img" aria-label={`Statechart of ${machine}`}>
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" />
              </marker>
              <marker id="arrow-fired" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" />
              </marker>
            </defs>

            {[...l.states].sort((a, b) => a.depth - b.depth).map((s) => {
              const here = occupancy.get(s.ref) ?? [];
              const chips = leaves.get(s.ref) ?? [];
              const active = here.length > 0;
              const isSelState = selection?.kind === "state" && selection.machine === machine && selection.ref === s.ref;
              const holdsSelected = selectedKey !== undefined && here.includes(selectedKey);
              return (
                <g key={s.ref} className={`state${active ? " active" : ""}${holdsSelected ? " selected-inst" : ""}`}
                  onClick={(e) => { e.stopPropagation(); select({ kind: "state", machine, ref: s.ref }); }}>
                  <rect className="box" x={s.x} y={s.y} width={s.width} height={s.height} rx={10}
                    fill={active ? "var(--accent-soft)" : `var(--depth-${Math.min(4, s.depth + 1)})`}
                    strokeWidth={holdsSelected ? 4 : isSelState ? 2.5 : undefined}
                    stroke={isSelState ? "var(--fg)" : undefined} />
                  {s.final && <rect x={s.x + 4} y={s.y + 4} width={s.width - 8} height={s.height - 8} rx={7}
                    fill="none" stroke={active ? "var(--accent)" : "var(--line)"} strokeWidth={1.2} />}
                  <text className="title" x={s.x + 12} y={s.y + 19}>{s.final ? "◎ " : ""}{s.name}</text>
                  {active && (
                    <g className="badge" aria-label={`${here.length} active`}>
                      <rect x={s.x + s.width - 30} y={s.y + 6} width={22} height={17} rx={8} />
                      <text x={s.x + s.width - 19} y={s.y + 19} textAnchor="middle">{here.length}</text>
                    </g>
                  )}
                  {s.internal.map((it, i) => (
                    <text key={it.id} className={`internal${fired.has(it.id) ? " fired" : ""}`}
                      x={s.x + 12} y={s.y + s.bodyTop + 13 + i * 18}
                      onClick={(e) => { e.stopPropagation(); select({ kind: "transition", machine, id: it.id }); }}>
                      {fired.has(it.id) ? "▶ " : "↺ "}{it.text}
                    </text>
                  ))}
                  {!s.composite && chips.length > 0 && (
                    <Chips x={s.x + 10} y={s.y + s.height - 24} width={s.width - 20} keys={chips} selectedKey={selectedKey}
                      onPick={(k) => select({ kind: "instance", key: k })} />
                  )}
                </g>
              );
            })}

            {l.dots.map((d) => <circle key={d.ref} className="dot" cx={d.x + d.width / 2} cy={d.y + d.height / 2} r={d.width / 2} />)}

            {l.edges.map((e) => {
              if (e.points.length < 2) return null;
              const d = e.points.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ");
              const isFired = fired.has(e.id);
              const isSel = selection?.kind === "transition" && selection.id === e.id;
              const pick = e.transition ? (ev: React.MouseEvent) => { ev.stopPropagation(); select({ kind: "transition", machine, id: e.id }); } : undefined;
              return (
                <g key={e.id} className={`edge k-${e.kind}${isFired ? " fired" : ""}${isSel ? " selected" : ""}`} onClick={pick}>
                  <path className="line" d={d} markerEnd={`url(#${isFired ? "arrow-fired" : "arrow"})`} />
                  {pick && <path className="hit" d={d} />}
                  {e.labelBox && e.label && (
                    <>
                      <rect className="label-bg" x={e.labelBox.x - 2} y={e.labelBox.y} width={e.labelBox.width + 4} height={e.labelBox.height} rx={3} />
                      <text x={e.labelBox.x + 2} y={e.labelBox.y + 13}>{isFired ? "▶ " : ""}{e.label}</text>
                    </>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </>
  );
}

function Chips({ x, y, width, keys, selectedKey, onPick }: {
  x: number; y: number; width: number; keys: string[]; selectedKey?: string; onPick: (k: string) => void;
}) {
  // Show ids, not keys: the type is the chart itself. Overflow collapses to a count, but
  // never hides the instance you selected.
  keys = selectedKey && keys.includes(selectedKey) ? [selectedKey, ...keys.filter((k) => k !== selectedKey)] : keys;
  let cx = x;
  const shown: { key: string; label: string; x: number; w: number }[] = [];
  let hidden = 0;
  for (const key of keys) {
    const label = key.slice(key.indexOf("#") + 1);
    const w = Math.max(24, label.length * 7.6 + 12);
    if (cx + w > x + width - 30 && shown.length > 0) { hidden++; continue; }
    shown.push({ key, label, x: cx, w });
    cx += w + 4;
  }
  return (
    <g>
      {shown.map((c) => (
        <g key={c.key} className={`chip${c.key === selectedKey ? " selected" : ""}`}
          onClick={(e) => { e.stopPropagation(); onPick(c.key); }} style={{ cursor: "pointer" }}>
          <rect x={c.x} y={y} width={c.w} height={18} rx={9} />
          <text x={c.x + c.w / 2} y={y + 13} textAnchor="middle">{c.label}</text>
        </g>
      ))}
      {hidden > 0 && <text x={cx} y={y + 13} className="hint" style={{ font: "12px var(--sans)", fill: "var(--muted)" }}>+{hidden}</text>}
    </g>
  );
}
