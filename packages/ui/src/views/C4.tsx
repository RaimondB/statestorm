import type { Selection } from "../selection.ts";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { c4Of, c4ToMermaid, subsystemsInFocus, type C4Diagram, type C4Focus, type C4Node, type Model } from "@statestorm/kernel";
import { C4, layoutC4, type C4Layout } from "../c4.ts";
import { endsOf, type PlacedEdge } from "../context-map.ts";
import { measure, NoSystems } from "./ContextMap.tsx";

/** What the reader chose (ADR 0036 §4): the diagram, and the systems and contexts in focus. Kept in the link. */
export interface C4State { diagram: C4Diagram; systems: string[]; contexts: string[] }

const DIAGRAMS: { diagram: C4Diagram; label: string; title: string }[] = [
  { diagram: "context", label: "system context", title: "The focus as one box, with the systems it exchanges messages with (C4 level 1)" },
  { diagram: "container", label: "containers", title: "The focus's sub-systems inside their system's boundary, with the systems around it (C4 level 2)" },
];

/** The focus a model opens on without a link: its first system of our own, else its first system. */
export function defaultFocus(model: Model): C4Focus {
  const sys = model.systems?.systems ?? [];
  const first = sys.find((s) => !s.external) ?? sys[0];
  return { systems: first ? [first.name] : [], contexts: [] };
}

/** The focus as the model has it: names it no longer has are dropped, so an edited model still draws. */
function known(model: Model, s: C4State): C4Focus {
  const sys = model.systems;
  return {
    systems: s.systems.filter((n) => sys?.systems.some((x) => x.name === n)),
    contexts: s.contexts.filter((n) => sys?.contexts.some((x) => x.name === n)),
  };
}

/**
 * ◎ on a box: a neighbour comes into focus — a system as itself, a part or a context by its context.
 * A box in focus goes out: the focus items that put it there; a part of a system in focus whole leaves
 * the system's other parts in, by their contexts.
 */
export function toggled(model: Model, focus: C4Focus, n: C4Node): C4Focus {
  const sys = model.systems!;
  const without = (xs: string[], x: string) => xs.filter((y) => y !== x);
  const withOne = (xs: string[], x: string) => (xs.includes(x) ? xs : [...xs, x]);
  if (!n.focus) {
    if (n.kind === "system" || n.kind === "external") return { ...focus, systems: withOne(focus.systems, n.name) };
    const context = n.kind === "context" ? n.name : n.context!;
    return { ...focus, contexts: withOne(focus.contexts, context) };
  }
  if (n.kind === "system" || n.kind === "external") return { ...focus, systems: without(focus.systems, n.name) };
  if (n.kind === "context") return { ...focus, contexts: without(focus.contexts, n.name) };
  const system = n.boundary!;
  if (!focus.systems.includes(system)) return { ...focus, contexts: without(focus.contexts, n.context!) };
  const others = sys.subsystems.filter((s) => s.system === system && s.name !== n.name && s.context !== n.context).map((s) => s.context);
  return { systems: without(focus.systems, system), contexts: [...new Set([...without(focus.contexts, n.context!), ...others])] };
}

/**
 * A part in focus (ADR 0036): the systems and bounded contexts the reader picks, and only the parts they
 * exchange messages with — as a C4 system context or container diagram. ◎ on a box takes it into the
 * focus or out of it; a click shows it in the inspector.
 */
export function C4View({ model, state, onState, select }: { model: Model; state: C4State; onState: (s: C4State) => void; select: (s: Selection) => void }) {
  const focus = useMemo(() => known(model, state), [model, state]);
  const empty = focus.systems.length + focus.contexts.length === 0;
  const view = useMemo(() => {
    if (!model.systems || empty) return {};
    try { return { view: c4Of(model, state.diagram, focus) }; }
    catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
  }, [model, state.diagram, focus, empty]);
  const [layout, setLayout] = useState<C4Layout>();
  const [error, setError] = useState<string>();
  const [picked, setPicked] = useState<PlacedEdge>();
  const [copied, setCopied] = useState<"link" | "mermaid">();
  useEffect(() => {
    let live = true;
    setPicked(undefined);
    if (!view.view) { setLayout(undefined); return; }
    layoutC4(view.view, measure).then((l) => { if (live) { setLayout(l); setError(undefined); } }, (err) => { if (live) setError(String(err)); });
    return () => { live = false; };
  }, [view]);

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
  const sys = model.systems;
  const set = (f: C4Focus) => onState({ ...state, ...f });
  const names = new Map((layout?.nodes ?? []).map((n) => [n.id, n.name]));
  const nameOf = (id: string) => names.get(id) ?? id;
  const inFocus = new Set(subsystemsInFocus(model, focus).map((s) => s.name));
  const ours = sys.systems.filter((s) => !s.external), theirs = sys.systems.filter((s) => s.external);
  // A context worth picking on its own: not just another name for a system of one part.
  const contexts = sys.contexts.filter((c) => !sys.systems.some((s) => s.name === c.name));

  const copy = (what: "link" | "mermaid") => {
    const text = what === "link" ? window.location.href : view.view ? c4ToMermaid(view.view) : "";
    const done = () => { setCopied(what); setTimeout(() => setCopied(undefined), 1600); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => window.prompt(what === "link" ? "The link to this view:" : "Mermaid:", text));
    else window.prompt(what === "link" ? "The link to this view:" : "Mermaid:", text);
  };
  const pick = (n: C4Node): Selection =>
    n.kind === "context" ? { kind: "place", level: "context", name: n.name }
    : n.kind === "subsystem" ? { kind: "place", level: "subsystem", name: n.name, system: n.boundary! }
    : { kind: "place", level: "system", name: n.name };

  return (
    <div className="ov map c4">
      <div className="ov-head">
        <span className="map-levels" role="radiogroup" aria-label="Diagram">
          {DIAGRAMS.map((d) => (
            <button key={d.diagram} role="radio" aria-checked={state.diagram === d.diagram} className={state.diagram === d.diagram ? "active" : ""}
              title={d.title} onClick={() => onState({ ...state, diagram: d.diagram })}>{d.label}</button>
          ))}
        </span>
        <span className="c4-focus" aria-label="In focus">
          <span className="hint">focus</span>
          {focus.systems.map((s) => (
            <span key={`s:${s}`} className="c4-chip" title={`the system ${s}`}>{s}
              <button aria-label={`take ${s} out of focus`} onClick={() => set({ ...focus, systems: focus.systems.filter((x) => x !== s) })}>×</button></span>
          ))}
          {focus.contexts.map((c) => (
            <span key={`c:${c}`} className="c4-chip context" title={`the bounded context ${c}`}>{c}
              <button aria-label={`take ${c} out of focus`} onClick={() => set({ ...focus, contexts: focus.contexts.filter((x) => x !== c) })}>×</button></span>
          ))}
          <select value="" aria-label="Add to the focus" onChange={(e) => {
            const [kind, name] = [e.target.value.slice(0, 2), e.target.value.slice(2)];
            if (kind === "s:") set({ ...focus, systems: [...focus.systems, name] });
            if (kind === "c:") set({ ...focus, contexts: [...focus.contexts, name] });
          }}>
            <option value="">+ add…</option>
            <optgroup label="Our systems">{ours.filter((s) => !focus.systems.includes(s.name)).map((s) => <option key={s.name} value={`s:${s.name}`}>{s.name}</option>)}</optgroup>
            {contexts.length > 0 && <optgroup label="Bounded contexts">{contexts.filter((c) => !focus.contexts.includes(c.name)).map((c) => <option key={c.name} value={`c:${c.name}`}>{c.name}{c.team ? ` (team ${c.team})` : ""}</option>)}</optgroup>}
            <optgroup label="Systems outside">{theirs.filter((s) => !focus.systems.includes(s.name)).map((s) => <option key={s.name} value={`s:${s.name}`}>{s.name}</option>)}</optgroup>
          </select>
        </span>
        <button onClick={() => copy("link")} title="This diagram and its focus, as a link">{copied === "link" ? "link copied" : "copy link"}</button>
        <button onClick={() => copy("mermaid")} disabled={!view.view} title="This diagram as Mermaid C4, for a document — `statestorm c4` prints the same">{copied === "mermaid" ? "Mermaid copied" : "copy Mermaid"}</button>
        <span className="ov-legend">
          <span><span className="map-key c4-in" /> in focus</span>
          <span><span className="map-key system" /> ours, around it</span>
          <span><span className="map-key external" /> outside</span>
          <span className="hint" title="Where a policy runs says who depends on whom (ADR 0035)"><b className="map-end-key">U</b> upstream, <b className="map-end-key">D</b> downstream</span>
          <span className="hint">◎ takes a box into the focus or out</span>
        </span>
      </div>
      {(view.error || error) && <div className="error-box" style={{ margin: "6px 12px" }}>{view.error ?? `Layout failed: ${error}`}</div>}
      <div className="ov-canvas" ref={canvas} onClick={() => setPicked(undefined)}>
        {empty ? <div className="hint" style={{ padding: 16 }}>Nothing in focus — add a system or a bounded context above.</div>
        : !layout ? <div className="hint" style={{ padding: 16 }}>Laying out…</div> : (
          <svg width={layout.width * fitted} height={layout.height * fitted} viewBox={`0 0 ${layout.width} ${layout.height}`}
            role="img" aria-label={`${state.diagram === "context" ? "System context" : "Container"} diagram of ${[...focus.systems, ...focus.contexts].join(", ")}`}>
            <defs>
              <marker id="c4-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className="map-head" />
              </marker>
            </defs>
            {layout.boundaries.map((b) => (
              <g key={b.name} className={`c4-boundary${b.external ? " external" : ""}`} transform={`translate(${b.x},${b.y})`}>
                <title>{`${b.name}${b.note ? ` — ${b.note}` : ""}`}</title>
                <rect width={b.width} height={b.height} rx={10} />
                <text x={14} y={22} className="c4-boundary-name">{b.name} <tspan className="c4-boundary-kind">[{b.external ? "External system" : "Software system"}]</tspan></text>
              </g>
            ))}
            {layout.edges.map((e, i) => (
              <g key={i} className={`map-edge${e.mutual ? " mutual" : ""}${picked && picked.from === e.from && picked.to === e.to ? " picked" : ""}`} role="button"
                onClick={(ev) => {
                  ev.stopPropagation(); setPicked(e);
                  select({ kind: "flow", from: nameOf(e.from), to: nameOf(e.to), events: e.events, commands: e.commands, patterns: e.patterns, policies: e.policies,
                    downstream: e.downstream.map(nameOf), ...(e.mutual ? { mutual: true } : {}) });
                }}>
                <title>{`${nameOf(e.from)} → ${nameOf(e.to)}${e.patterns.length ? ` (${e.patterns.join(", ")})` : ""}${e.downstream.length ? `\ndownstream: ${e.downstream.map(nameOf).join(" and ")}${e.mutual ? " — each depends on the other" : ""}` : ""}\nevents: ${e.events.join(", ") || "—"}\ncommands: ${e.commands.join(", ") || "—"}`}</title>
                <path d={`M${e.points.map((p) => `${p.x},${p.y}`).join(" L")}`} className="map-line" markerEnd="url(#c4-head)" />
                {e.label && <text x={e.label.x + 4} y={e.label.y + 12} className="map-label">{e.label.text}</text>}
                {endsOf(e).map((end, j) => (
                  <g key={j} className={`map-end ${end.text === "U" ? "up" : "down"}`} transform={`translate(${end.x},${end.y})`}>
                    <circle r={7.5} /><text y={4} textAnchor="middle">{end.text}</text>
                  </g>
                ))}
              </g>
            ))}
            {layout.nodes.map((n) => {
              const next = toggled(model, focus, n);
              const last = next.systems.length + next.contexts.length === 0;
              return (
                <g key={n.id} transform={`translate(${n.x},${n.y})`} className={`map-node c4-node ${n.kind}${n.external ? " external" : ""}${n.focus ? " in" : ""}${n.unmodelled ? " unmodelled" : ""}`} role="button"
                  onClick={(ev) => { ev.stopPropagation(); setPicked(undefined); select(pick(n)); }}>
                  <title>{`${n.name}${n.note ? ` — ${n.note}` : ""} — what it is, in the inspector`}</title>
                  <rect width={n.width} height={n.height} rx={n.kind === "context" ? 18 : 6} />
                  <text x={n.width / 2} y={C4.pad + 12} textAnchor="middle" className="map-name">{n.name}</text>
                  {n.lines.map((l, j) => (
                    <text key={j} x={n.width / 2} y={C4.pad + 12 + C4.line * (j + 1)} textAnchor="middle" className="map-sub">{l}</text>
                  ))}
                  {n.notes.map((l, j) => (
                    <text key={`n${j}`} x={n.width / 2} y={C4.pad + 16 + C4.line * (n.lines.length + j + 1)} textAnchor="middle" className="c4-note">{l}</text>
                  ))}
                  {!(n.focus && last) && n.name !== "(no system)" && (
                    <g role="button" className="c4-toggle" transform={`translate(${n.width - 13},13)`}
                      onClick={(ev) => { ev.stopPropagation(); set(next); }}>
                      <title>{n.focus ? `take ${n.name} out of the focus` : `put ${n.kind === "subsystem" ? `its context, ${n.context},` : n.name} in the focus too`}</title>
                      <circle r={9} /><text y={4} textAnchor="middle">{n.focus ? "−" : "◎"}</text>
                    </g>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </div>
      {inFocus.size > 0 && layout && <div className="hint c4-foot">In focus: {[...inFocus].join(", ")} — {layout.nodes.filter((n) => !n.focus).length} part{layout.nodes.filter((n) => !n.focus).length === 1 ? "" : "s"} around it, every other part left out (ADR 0036)</div>}
    </div>
  );
}
