import { useMemo, useState, type ReactElement } from "react";
import {
  DEPTHS, lifelinesOf, openAt, PERSON, sequenceOf,
  type Depth, type Model, type SequenceItem, type SequenceMarks,
} from "@statestorm/kernel";
import { frameOfEntry, type Run } from "../session.ts";
import { estimate, type Measure } from "../chart-layout.ts";
import { NoSystems } from "./ContextMap.tsx";
import type { Selection } from "../selection.ts";

let ctx: CanvasRenderingContext2D | null | undefined;
const measure: Measure = (text, font) => {
  ctx ??= document.createElement("canvas").getContext("2d");
  if (!ctx) return estimate(text, font);
  ctx.font = font === "title" ? "700 13px system-ui, sans-serif" : "12px system-ui, sans-serif";
  return ctx.measureText(text).width;
};

const ROW = { group: 26, band: 20, box: 36, message: 34, note: 26, frameHead: 30, frameFoot: 10, folded: 30, top: 8 };

/** What the reader chose of the sequence (ADR 0022): it travels in the link, with the model and the scenario. */
export interface SequenceState {
  /** The lifelines opened; absent: opened to system level. */
  open?: string[];
  /** The folds and sections opened or closed against their default. */
  toggled: string[];
  /** Show the commands their receiver ignored. */
  ignored: boolean;
}

interface Props {
  model: Model;
  run: Run;
  index: number;
  onIndex: (i: number) => void;
  state: SequenceState;
  onState: (s: SequenceState) => void;
  /** A lifeline or a message clicked: the inspector says what it is, and what the docs say of it. */
  select: (s: Selection) => void;
}

const DEPTH_LABEL: Record<Depth, { label: string; title: string }> = {
  domain: { label: "domain", title: "Every lifeline closed: a domain, or a system in none" },
  system: { label: "system", title: "Every domain opened into its systems" },
  subsystem: { label: "sub-system", title: "Every system opened into its sub-systems" },
  aggregate: { label: "aggregate", title: "Everything opened, down to the aggregates" },
};

type Frame = Extract<SequenceItem, { kind: "frame" }>;
type Message = Extract<SequenceItem, { kind: "message" }>;
type Prim =
  | { t: "msg"; item: Message; y: number }
  | { t: "note"; item: Extract<SequenceItem, { kind: "note" }>; y: number; after: number }
  | { t: "frame"; item: Frame; y0: number; y1: number; x0: number; x1: number }
  | { t: "folded"; item: Frame; y: number; x0: number; x1: number };

/**
 * The running scenario as a sequence diagram (ADR 0022, revising ADR 0018 §5): what crosses between
 * the open lifelines, each arrow followed by what it caused; what repeats folded into frames. A
 * lifeline's ▸ opens it, an open one's header closes it; a frame's tab folds or unfolds it. Click a
 * message to go to it; what has not happened yet at the current step is faded.
 */
export function Sequence({ model, run, index, onIndex, state, onState, select }: Props) {
  const lines = useMemo(() => (model.systems ? lifelinesOf(model) : undefined), [model]);
  const open = useMemo(() => state.open ?? (lines ? openAt(lines, "system") : []), [state.open, lines]);
  const marks = useMemo((): SequenceMarks => ({
    phases: run.phases.map((p) => ({ name: p.name, after: run.frames[p.frame]?.seq ?? 0 })),
    ...(run.setup !== undefined ? { setup: run.setup } : {}),
  }), [run]);
  const result = useMemo(() => {
    try { return { seq: model.systems ? sequenceOf(model, run.world.log, { open, toggled: state.toggled, ignored: state.ignored }, marks) : undefined }; }
    catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
  }, [model, run, open, state.toggled, state.ignored, marks]);
  const s = result.seq;
  const now = run.frames[index]?.seq ?? Infinity;
  const [copied, setCopied] = useState(false);

  const toggled = useMemo(() => new Set(state.toggled), [state.toggled]);
  const set = (patch: Partial<SequenceState>) => onState({ ...state, open, ...patch });
  const toggle = (id: string) => set({ toggled: toggled.has(id) ? state.toggled.filter((t) => t !== id) : [...state.toggled, id] });
  const openNode = (id: string) => set({ open: [...open.filter((o) => o !== id), id] });
  const closeNode = (id: string) => set({ open: open.filter((o) => o !== id) });
  const depths = DEPTHS.filter((d) => d !== "domain" || (model.systems?.domains.length ?? 0) > 0);
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  const preset = lines ? depths.find((d) => same(openAt(lines, d), open)) : undefined;

  const layout = useMemo(() => {
    if (!s) return undefined;
    const labelOf = (i: SequenceItem) => (i.kind === "message" ? `${i.label}${i.times ? ` ×${i.times}  ▸` : ""}` : i.kind === "note" ? i.text : "");
    const all = (its: SequenceItem[]): SequenceItem[] => its.flatMap((i) => (i.kind === "frame" ? all(i.items) : [i]));
    const widest = Math.max(0, ...all(s.items).map((i) => measure(labelOf(i), "label")));
    const name = Math.max(0, ...s.participants.map((p) => measure(s.lifelines[p]!.name, "title") + 44));
    const col = Math.max(name, Math.min(340, Math.max(170, widest + 36)));
    const x = new Map(s.participants.map((p, i) => [p, 24 + col / 2 + i * col]));
    const width = 48 + col * Math.max(1, s.participants.length);

    // The heads: an open node above the lifelines it opened into; a band where a context says more.
    const chain = (id: string): string[] => { const c: string[] = []; for (let n = s.lifelines[id]?.parent; n; n = s.lifelines[n]?.parent) c.unshift(n); return c; };
    const depthOf = new Map(s.participants.map((p) => [p, chain(p)]));
    const maxDepth = Math.max(0, ...[...depthOf.values()].map((c) => c.length));
    const bands = s.participants.some((p) => s.lifelines[p]!.band);
    const groups: { id: string; depth: number; x0: number; x1: number }[] = [];
    const seen = new Set<string>();
    for (const p of s.participants) {
      depthOf.get(p)!.forEach((g, d) => {
        if (seen.has(g)) return;
        seen.add(g);
        const under = s.participants.filter((q) => depthOf.get(q)!.includes(g)).map((q) => x.get(q)!);
        groups.push({ id: g, depth: d, x0: Math.min(...under) - col / 2 + 4 + d * 3, x1: Math.max(...under) + col / 2 - 4 - d * 3 });
      });
    }
    const bandRuns: { band: string; x0: number; x1: number }[] = [];
    for (const p of s.participants) {
      const l = s.lifelines[p]!;
      const last = bandRuns[bandRuns.length - 1];
      const px = x.get(p)!;
      if (l.band && last && last.band === l.band && Math.abs(last.x1 - (px - col / 2 + 6)) < 20) last.x1 = px + col / 2 - 6;
      else if (l.band) bandRuns.push({ band: l.band, x0: px - col / 2 + 6, x1: px + col / 2 - 6 });
    }
    const boxTop = ROW.top + maxDepth * ROW.group + (bands ? ROW.band : 0);
    const bodyTop = boxTop + ROW.box + 18;

    // The body: arrows, notes and frames, in order, each frame around what it holds.
    const prims: Prim[] = [];
    let y = bodyTop;
    let lastSeq = 0;
    const touched = (its: SequenceItem[]): number[] => its.flatMap((i) =>
      i.kind === "message" ? [x.get(i.from)!, x.get(i.to)!] : i.kind === "note" ? [x.get(i.over)!] : touched(i.items));
    const place = (its: SequenceItem[], nest: number) => {
      for (const it of its) {
        if (it.kind === "message") { prims.push({ t: "msg", item: it, y }); lastSeq = it.seq; y += it.from === it.to ? ROW.message + 12 : ROW.message; continue; }
        if (it.kind === "note") { prims.push({ t: "note", item: it, y, after: lastSeq }); y += ROW.note; continue; }
        const wide = it.frame === "section" || it.frame === "setup";
        const xs = touched(it.items);
        const pad = Math.max(26, col * 0.44 - nest * 10);
        const x0 = wide || xs.length === 0 ? 6 + nest * 6 : Math.max(6 + nest * 6, Math.min(...xs) - pad);
        const x1 = wide || xs.length === 0 ? width - 6 - nest * 6 : Math.min(width - 6 - nest * 6, Math.max(...xs) + pad);
        if (wide && it.folded) { prims.push({ t: "folded", item: it, y, x0, x1 }); y += ROW.folded; lastSeq = it.seq; continue; }
        const y0 = y;
        y += ROW.frameHead;
        place(it.items, nest + 1);
        y += ROW.frameFoot;
        prims.push({ t: "frame", item: it, y0, y1: y, x0, x1 });
        y += 10;   // the next arrow's label clear of the frame's edge
      }
    };
    place(s.items, 0);
    // The heads end just above the body's first row: they are what stays in view.
    return { col, x, width: Math.max(width, 420), height: y + 16, head: boxTop + ROW.box + 6, groups, bandRuns, maxDepth, bands, boxTop, prims };
  }, [s]);

  if (!model.systems) return <NoSystems model={model} />;

  /** What a lifeline is, for the inspector: an aggregate, or a part of the landscape. */
  const pick = (id: string): Selection => {
    const l = s?.lifelines[id];
    if (!l) return undefined;
    if (l.kind === "aggregate") return { kind: "type", name: l.name };
    if (l.kind === "domain" || l.kind === "system") return { kind: "place", level: l.kind, name: l.name };
    if (l.kind === "subsystem") return { kind: "place", level: "subsystem", name: l.name, system: id.slice("subsystem:".length, id.lastIndexOf("/")) };
    return undefined;
  };

  const copyLink = () => {
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1600); };
    if (navigator.clipboard) navigator.clipboard.writeText(window.location.href).then(done, () => window.prompt("The link to this view:", window.location.href));
    else window.prompt("The link to this view:", window.location.href);
  };

  return (
    <div className="ov sequence">
      <div className="ov-head">
        <span className="map-levels" role="group" aria-label="Open every lifeline to">
          {depths.map((d) => (
            <button key={d} className={preset === d ? "active" : ""} title={DEPTH_LABEL[d].title} onClick={() => set({ open: openAt(lines!, d) })}>{DEPTH_LABEL[d].label}</button>
          ))}
        </span>
        {state.toggled.length > 0 && <button onClick={() => set({ toggled: [] })} title="Fold every loop, repeat and set-up again">fold again</button>}
        <label className="seq-switch" title="Commands their receiver had no answer to (a broadcast nobody handled) — left out by default">
          <input type="checkbox" checked={state.ignored} onChange={(e) => set({ ignored: e.target.checked })} />
          {" "}show ignored{s && !state.ignored && s.hidden.ignored > 0 ? ` (${s.hidden.ignored})` : ""}
        </label>
        <button onClick={copyLink} title="This view — the model, the scenario, what is open and unfolded — as a link">{copied ? "link copied" : "copy link"}</button>
        <span className="ov-legend">
          <span><svg width="40" height="10"><line x1="2" y1="5" x2="38" y2="5" className="seq-arrow command" /></svg> command</span>
          <span><svg width="40" height="10"><line x1="2" y1="5" x2="38" y2="5" className="seq-arrow event" /></svg> event, and what it became</span>
          <span><span className="seq-key loop" /> a model loop</span>
          <span><span className="seq-key repeat" /> the run repeating itself</span>
          <span className="hint">▸ opens a lifeline or a fold · click a message or a lifeline to see it in the inspector</span>
        </span>
      </div>
      {result.error && <div className="error-box" style={{ margin: "6px 12px" }}>{result.error}</div>}
      {s && layout && (
        <div className="ov-canvas">
          {s.items.length === 0 ? <div className="hint" style={{ padding: 16 }}>Nothing crosses between these lifelines.</div> : (
            <>
            {/* The heads stay in view while the body scrolls under them; both scroll sideways together. */}
            <div className="seq-heads" style={{ width: layout.width }}>
            <svg width={layout.width} height={layout.head} role="img" aria-label="Lifelines">
              {layout.groups.map((g) => (
                <rect key={g.id} x={g.x0} y={ROW.top + g.depth * ROW.group} width={g.x1 - g.x0} height={layout.head - (ROW.top + g.depth * ROW.group)} className="seq-group-area" />
              ))}
              {layout.groups.map((g) => {
                const l = s.lifelines[g.id]!;
                return (
                  <g key={g.id} className={`seq-group ${l.kind}${l.external ? " external" : ""}`}>
                    <g role="button" onClick={() => select(pick(g.id))} className="seq-group-toggle">
                      <title>{`${l.name} — what it is, in the inspector`}</title>
                      <rect x={g.x0} y={ROW.top + g.depth * ROW.group} width={g.x1 - g.x0} height={ROW.group - 4} rx={6} className="seq-group-head" />
                      <text x={g.x0 + 26} y={ROW.top + g.depth * ROW.group + 16} className="seq-group-name">{l.name}<tspan className="seq-kind"> {l.kind === "subsystem" ? "sub-system" : l.kind}</tspan></text>
                    </g>
                    <g role="button" className="seq-toggle" onClick={() => closeNode(g.id)}>
                      <title>{`close ${l.name} into one lifeline`}</title>
                      <rect x={g.x0 + 2} y={ROW.top + g.depth * ROW.group + 1} width={20} height={ROW.group - 6} rx={4} />
                      <text x={g.x0 + 12} y={ROW.top + g.depth * ROW.group + 16} textAnchor="middle">▾</text>
                    </g>
                  </g>
                );
              })}
              {layout.bandRuns.map((b, k) => (
                <g key={k} className="seq-band">
                  <title>{`bounded context ${b.band}`}</title>
                  <rect x={b.x0} y={ROW.top + layout.maxDepth * ROW.group} width={b.x1 - b.x0} height={ROW.band - 5} rx={3} />
                  <text x={(b.x0 + b.x1) / 2} y={ROW.top + layout.maxDepth * ROW.group + 11} textAnchor="middle">{b.band}</text>
                </g>
              ))}
              {s.participants.map((p) => {
                const cx = layout.x.get(p)!;
                const l = s.lifelines[p]!;
                const kind = p === PERSON ? "person" : l.external ? "external" : l.kind === "domain" ? "domain" : "ours";
                const opens = l.children.length > 0;
                const text = `${opens ? "▸ " : ""}${l.name}`;
                const w = Math.min(layout.col - 12, measure(text, "title") + 24);
                const what = pick(p);
                return (
                  <g key={p} className={`seq-participant ${kind}${what ? " picks" : ""}`}>
                    <line x1={cx} y1={layout.boxTop + ROW.box - 6} x2={cx} y2={layout.head} className="seq-life" />
                    <g {...(what ? { role: "button", onClick: () => select(what) } : {})}>
                      {what && <title>{`${l.name} — what it is, in the inspector`}</title>}
                      <rect x={cx - w / 2} y={layout.boxTop} width={w} height={ROW.box - 6} rx={kind === "person" ? 15 : 6} />
                      <text x={cx + (opens ? 8 : 0)} y={layout.boxTop + 20} textAnchor="middle" className="seq-name">{l.name}</text>
                    </g>
                    {opens && (
                      <g role="button" className="seq-toggle" onClick={() => openNode(p)}>
                        <title>{`open ${l.name} into its ${l.kind === "domain" ? "systems" : l.kind === "system" ? "parts" : "aggregates"}`}</title>
                        <rect x={cx - w / 2 + 3} y={layout.boxTop + 3} width={20} height={ROW.box - 12} rx={4} />
                        <text x={cx - w / 2 + 13} y={layout.boxTop + 20} textAnchor="middle">▸</text>
                      </g>
                    )}
                  </g>
                );
              })}
            </svg>
            </div>
            <svg width={layout.width} height={layout.height - layout.head} role="img" aria-label="Sequence">
              <defs>
                <marker id="seq-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" className="seq-head" /></marker>
                <marker id="seq-open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10" className="seq-open" /></marker>
              </defs>
              <g transform={`translate(0 ${-layout.head})`}>
              {layout.groups.map((g) => (
                <rect key={g.id} x={g.x0} y={layout.head} width={g.x1 - g.x0} height={layout.height - layout.head - 6} className="seq-group-area" />
              ))}
              {s.participants.map((p) => (
                <line key={p} x1={layout.x.get(p)!} y1={layout.head} x2={layout.x.get(p)!} y2={layout.height - 8} className="seq-life" />
              ))}
              {layout.prims.filter((p) => p.t === "frame").map((p) => {
                const f = p.item;
                const foldable = f.folded || toggled.has(f.id) || f.frame !== "loop";
                const word = f.frame === "loop" ? "loop" : "";
                const tab = `${foldable ? "▾ " : ""}${word ? `${word} · ` : ""}${f.label}${f.folded ? " (folded)" : ""}`;
                const tw = measure(tab, "label") * 1.08 + 18;   // the tab's text is semibold
                const past = f.seq <= now;
                return (
                  <g key={`${f.id}-${p.y0}`} className={`seq-frame ${f.frame}${past ? "" : " future"}`}>
                    <rect x={p.x0} y={p.y0} width={p.x1 - p.x0} height={p.y1 - p.y0} rx={4} className="seq-frame-box" />
                    <g {...(foldable ? { role: "button", onClick: () => toggle(f.id) } : {})} className={foldable ? "seq-tab toggles" : "seq-tab"}>
                      <title>{foldable ? (f.folded ? `${f.label}: one of ${f.messages} arrows' pictures — unfold to see each` : "fold it again") : `${f.label}: its iterations differ, so each is drawn`}</title>
                      <path d={`M${p.x0},${p.y0} h${tw} v${ROW.frameHead - 14} l-8,8 h${-(tw - 8)} z`} />
                      <text x={p.x0 + 8} y={p.y0 + 15}>{tab}</text>
                    </g>
                  </g>
                );
              })}
              {layout.prims.map((p, k) => {
                if (p.t === "frame") return null;
                if (p.t === "folded") {
                  const f = p.item;
                  return (
                    <g key={k} className={`seq-folded${f.seq <= now ? "" : " future"}`} role="button" onClick={() => toggle(f.id)}>
                      <title>{`${f.label} — open it`}</title>
                      <rect x={p.x0} y={p.y + 2} width={p.x1 - p.x0} height={ROW.folded - 6} rx={4} />
                      <text x={p.x0 + 10} y={p.y + 19}>{`▸ ${f.label} · ${f.messages} message${f.messages === 1 ? "" : "s"}`}</text>
                    </g>
                  );
                }
                if (p.t === "note") {
                  const cx = layout.x.get(p.item.over)!;
                  const w = measure(p.item.text, "label") + 16;
                  return (
                    <g key={k} className={`seq-note${p.after <= now ? "" : " future"}`}>
                      <rect x={cx - w / 2} y={p.y - 2} width={w} height={20} rx={3} />
                      <text x={cx} y={p.y + 12} textAnchor="middle">{p.item.text}</text>
                    </g>
                  );
                }
                return <Arrow key={k} item={p.item} y={p.y} x1={layout.x.get(p.item.from)!} x2={layout.x.get(p.item.to)!}
                  past={p.item.seq <= now} name={(id) => s.lifelines[id]?.name ?? id}
                  onGo={() => {
                    onIndex(frameOfEntry(run, p.item.seq));
                    select({ kind: "message", ...(p.item.event ? { event: p.item.event } : {}), ...(p.item.command ? { command: p.item.command } : {}), ...(p.item.policy ? { policy: p.item.policy } : {}) });
                  }} onFold={p.item.fold ? () => toggle(p.item.fold!) : undefined} />;
              })}
              </g>
            </svg>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Arrow({ item, y, x1, x2, past, name, onGo, onFold }: {
  item: Message; y: number; x1: number; x2: number; past: boolean;
  name: (id: string) => string; onGo: () => void; onFold?: () => void;
}): ReactElement {
  const marker = item.style === "command" ? "url(#seq-head)" : "url(#seq-open)";
  const label = `${item.label}${item.times ? ` ×${item.times}` : ""}`;
  const who = [...new Set(item.instances)];
  const tip = `${name(item.from)} → ${name(item.to)}: ${label}${who.length > 1 ? ` — ${who.join(", ")}` : who.length ? ` — ${who[0]}` : ""} — go to it, and see it in the inspector`;
  const self = x1 === x2;
  const lx = self ? x1 + 48 : (x1 + x2) / 2;
  const w = measure(label, "label");
  return (
    <g className={`seq-message${past ? "" : " future"}`}>
      <g role="button" onClick={onGo}>
        <title>{tip}</title>
        {self
          ? <path d={`M${x1},${y + 10} h40 v16 h-38`} className={`seq-arrow ${item.style}`} markerEnd={marker} />
          : <line x1={x1} y1={y + 14} x2={x2 - (x2 > x1 ? 2 : -2)} y2={y + 14} className={`seq-arrow ${item.style}`} markerEnd={marker} />}
        <text x={lx} y={y + 8} textAnchor={self ? "start" : "middle"} className="seq-label">{label}</text>
      </g>
      {onFold && (
        <g role="button" onClick={onFold} className="seq-unfold">
          <title>{`${item.times} alike arrows, folded — show each`}</title>
          <text x={self ? lx + w + 8 : lx + w / 2 + 8} y={y + 8} className="seq-label">▸</text>
        </g>
      )}
    </g>
  );
}
