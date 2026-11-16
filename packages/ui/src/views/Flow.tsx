import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Model } from "@statestorm/kernel";
import { parseScenario } from "@statestorm/scenarios";
import { actionsOf, frameOfEntry, logOf, type Run } from "../session.ts";
import type { Selection } from "../selection.ts";
import { buildFlow, flowConfig, layoutFlow, NODE, tagsOf, trailOf } from "../flow.ts";
import { overviewConfig, spoken } from "../overview.ts";
import type { Drawing, DrawingIssue } from "../check/drawings.ts";
import { drawingBoard, type DrawnNode, type Group, type Mark, type MarkedEdge } from "../groups.ts";

interface Props {
  model: Model;
  run: Run;
  index: number;
  /** The example's scenarios: their runs are where the arrows come from. */
  scenarios: { file: string; text: string }[];
  /** The business's drawings of the model, and the scenarios grouped by the drawing they walk. */
  drawings: Drawing[];
  groups: Group[];
  issues: DrawingIssue[];
  select: (s: Selection) => void;
  onIndex: (i: number) => void;
}

/** Where the arrows come from: every scenario, a drawing's group, or the run on screen. */
type Source = "all" | "run" | `group:${string}`;
type Choice = { source: Source; drawAs: string };
function readChoice(): Choice {
  try {
    const v = JSON.parse(localStorage.getItem("statestorm.flow") ?? "null") as Choice | null;
    if (v && typeof v.source === "string" && typeof v.drawAs === "string") return v;
  } catch { /* private mode: fine */ }
  return { source: "all", drawAs: "" };
}

const MARK: Record<Mark, string> = {
  drawn: "drawn, and shown",
  missing: "drawn, not shown by its scenarios — a gap",
  unwalked: "drawn, not in these runs",
  decided: "drawn, decided later / open / no",
  anyway: "decided later / open / no — shown all the same",
  proposed: "shown, not drawn — a change to the drawing",
};

const KIND: Record<string, string> = {
  held: "a deviation — on hold until a person decides",
  done: "moves the journey on",
  failed: "a deviation — something failed",
  active: "starts something",
  neutral: "changes nothing on its own",
};

/**
 * The whole process on one page, for the people who own it: events in lanes by where they
 * happen, an arrow from each to what the scenarios showed can follow. The run being stepped
 * through is lit on top of it.
 */
export function Flow({ model, run, index, scenarios, drawings, groups, issues, select, onIndex }: Props) {
  const overview = useMemo(() => overviewConfig(model).config, [model]);
  const { flow, errors } = useMemo(() => flowConfig(model), [model]);
  // Every scenario's run, read once per model: the arrows are what they showed.
  const logs = useMemo(() => new Map(scenarios.flatMap((s) => {
    try {
      const sc = parseScenario(s.text, s.file);
      return [[s.file, logOf(model, actionsOf(sc), { kind: "fifo" }, sc.given.at)] as const];
    } catch {
      return [];
    }
  })), [model, scenarios]);

  const [choice, setChoice] = useState<Choice>(readChoice);
  const choose = (c: Choice) => {
    setChoice(c);
    try { localStorage.setItem("statestorm.flow", JSON.stringify(c)); } catch { /* fine */ }
  };
  const group = choice.source.startsWith("group:") ? groups.find((g) => g.id === choice.source.slice(6)) : undefined;
  const source: Source = choice.source.startsWith("group:") && !group ? "all" : choice.source;
  const drawing = drawings.find((d) => d.file.replace(/\.yaml$/, "") === choice.drawAs);
  // The runs the arrows come from. Every scenario: the run on screen counts too — what you just
  // tried is on the board.
  const chosen = useMemo(() => source === "run" ? [run.world.log]
    : group ? group.files.map((f) => logs.get(f)).filter((l): l is NonNullable<typeof l> => !!l)
    : [...logs.values(), run.world.log], [source, group, logs, run]);
  const shown = useMemo(() => buildFlow(model, overview, flow, chosen), [model, overview, flow, chosen]);
  // A path drawn on many drawings (a referral, say) names the scenarios that show it: judged by those.
  const byPath = useMemo(() => drawing ? Object.fromEntries(Object.entries(drawing.paths).filter(([, p]) => p.scenarios.length > 0).map(([name, p]) =>
    [name, buildFlow(model, overview, flow, [...logs].filter(([f]) => p.scenarios.some((x) => f.startsWith(x))).map(([, l]) => l))])) : {},
  [drawing, model, overview, flow, logs]);
  const graph = useMemo(() => drawing ? drawingBoard(drawing, shown, !!group && group.id === choice.drawAs, issues, byPath) : shown,
    [drawing, shown, group, choice.drawAs, issues, byPath]);
  const board = drawing ? (graph as ReturnType<typeof drawingBoard>) : undefined;
  const layout = useMemo(() => layoutFlow(graph), [graph]);
  const [only, setOnly] = useState<string>();
  const frame = run.frames[index]!;
  const trail = useMemo(() => trailOf(model, overview, flow, run.world.log, frame.seq, only), [model, overview, flow, run, frame, only]);
  const lit = trail.first.size > 0;
  // On a drawing, a box is lit when the run did its status, wherever the board put it.
  const evOf = (id: string) => id.slice(0, id.lastIndexOf("@"));
  const litEvents = useMemo(() => new Set([...trail.first.keys()].map(evOf)), [trail]);
  const walkedPairs = useMemo(() => new Set([...trail.edges].map((k) => { const [a, b] = k.split("→"); return `${evOf(a!)} ${evOf(b!)}`; })), [trail]);
  const seenAt = (id: string) => drawing ? litEvents.has(evOf(id)) : trail.first.has(id);
  const walkedEdge = (from: string, to: string) => drawing ? walkedPairs.has(`${evOf(from)} ${evOf(to)}`) : trail.edges.has(`${from}→${to}`);
  const isNow = (id: string) => trail.last !== undefined && (drawing ? evOf(trail.last) === evOf(id) : trail.last === id);

  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [fitted, setFitted] = useState(1);
  const canvas = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const measure = () => setFitted(layout.width > 0 ? Math.min(1, (c.clientWidth - 24) / layout.width) : 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(c);
    return () => ro.disconnect();
  }, [layout]);
  const scale = zoom === "fit" ? fitted : zoom;

  const travel = (id: string, event: string) => {
    const seq = trail.first.get(id) ?? [...trail.first].find(([k]) => evOf(k) === event)?.[1]
      ?? run.world.log.find((e) => e.kind === "event" && e.event === event)?.seq;
    if (seq === undefined) return;
    onIndex(frameOfEntry(run, seq));
    select({ kind: "entry", seq });
  };

  return (
    <div className="ov flow">
      <div className="ov-head flow-controls">
        <label className="hint">arrows of{" "}
          <select value={source} onChange={(e) => {
            const v = e.target.value as Source;
            // A drawing's group is best read on that drawing.
            const id = v.startsWith("group:") ? v.slice(6) : "";
            choose({ source: v, drawAs: id && drawings.some((d) => d.file === `${id}.yaml`) ? id : v.startsWith("group:") ? "" : choice.drawAs });
          }}>
            <option value="all">every scenario ({logs.size})</option>
            <option value="run">this run only</option>
            {groups.some((g) => !g.id.startsWith("#")) && (
              <optgroup label="the scenarios that walk a drawing">
                {groups.filter((g) => !g.id.startsWith("#")).map((g) => <option key={g.id} value={`group:${g.id}`}>{g.title} ({g.files.length})</option>)}
              </optgroup>
            )}
            {groups.some((g) => g.id.startsWith("#")) && (
              <optgroup label="the scenarios tagged">
                {groups.filter((g) => g.id.startsWith("#")).map((g) => <option key={g.id} value={`group:${g.id}`}>{g.title} ({g.files.length})</option>)}
              </optgroup>
            )}
          </select>
        </label>
        {drawings.length > 0 && (
          <label className="hint">draw as{" "}
            <select value={drawing ? choice.drawAs : ""} onChange={(e) => choose({ ...choice, drawAs: e.target.value })}>
              <option value="">the model's board</option>
              {drawings.map((d) => <option key={d.file} value={d.file.replace(/\.yaml$/, "")}>{d.title}</option>)}
            </select>
          </label>
        )}
        {trail.subjects.length > 1 && (
          <label className="hint">follow{" "}
            <select value={only ?? ""} onChange={(e) => setOnly(e.target.value || undefined)}>
              <option value="">every one</option>
              {trail.subjects.map((s) => <option key={s} value={s}>{s.slice(s.indexOf("#") + 1)}</option>)}
            </select>
          </label>
        )}
        <span className="zoom" style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          <button onClick={() => setZoom(Math.max(0.2, scale / 1.2))} aria-label="Zoom out">−</button>
          <button onClick={() => setZoom("fit")} className={zoom === "fit" ? "active" : ""}>{zoom === "fit" ? "fit" : `${Math.round(scale * 100)}% · fit`}</button>
          <button onClick={() => setZoom(Math.min(2.5, scale * 1.2))} aria-label="Zoom in">+</button>
        </span>
      </div>
      <div className="ov-head flow-legend">
        <span className="ov-legend">
          {Object.entries(KIND).map(([t, words]) => <span key={t} className={`flow-key t-${t}`}>{words}</span>)}
          <span className="flow-key unseen">{drawing ? "not in these runs" : "no scenario shows this"}</span>
          {drawing && <span className="flow-key extra">not on the drawing</span>}
        </span>
        {drawing && (
          <span className="ov-legend">
            {(Object.keys(MARK) as Mark[]).filter((m) => (graph.edges as MarkedEdge[]).some((e) => e.mark === m)).map((m) => (
              <span key={m} className={`flow-mark m-${m}`}><svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" /></svg>{MARK[m]}</span>
            ))}
          </span>
        )}
      </div>
      {errors.length > 0 && <div className="error-box" style={{ margin: "6px 12px" }}>{errors.join("\n")}</div>}
      <div className="ov-canvas" ref={canvas}>
        <div className="hint flow-note">
          Arrows: what followed what{flow.of ? ` for each ${flow.of.join(" / ")}` : ""}, {source === "run" ? "in this run" : group ? `over the ${group.files.length} scenario${group.files.length === 1 ? "" : "s"} ${group.id.startsWith("#") ? `tagged ${group.title}` : `that walk ${group.id ? `“${group.title}”` : "no drawing"}`}` : `over ${logs.size} scenario${logs.size === 1 ? "" : "s"} and this run`}
          {drawing ? `, laid over “${drawing.title}” in its own lanes and words.` : "."}
          {lit ? " Lit: what this run has done so far." : ""}
          {!drawing && graph.left.length > 0 && ` Not on the board (no lane): ${graph.left.map(spoken).join(", ")}.`}
          {board && board.outside > 0 && ` ${board.outside} drawn arrow${board.outside === 1 ? "" : "s"} from a trigger outside the lanes or an unmodelled box: not drawn here.`}
          {group && group.files.length > 0 && <span className="flow-files"> Scenarios: {group.files.join(", ")}.</span>}
        </div>
        {graph.nodes.length === 0
          ? <div className="hint" style={{ padding: 16 }}>Nothing to draw yet — no scenario raises an event the board shows.</div>
          : (
            <svg width={layout.width * scale} height={layout.height * scale} viewBox={`0 0 ${layout.width} ${layout.height}`}
              role="img" aria-label="Flow board">
              <defs>
                {["", ...Object.keys(MARK).map((m) => `-${m}`)].map((m) => (
                  <marker key={m} id={`flow-arrow${m}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                    <path d="M0,0 L10,5 L0,10 z" className={`flow-head${m ? ` m${m}` : ""}`} />
                  </marker>
                ))}
              </defs>
              {layout.lanes.map((l, i) => (
                <g key={l.name} className="flow-lane">
                  <rect x={l.x} y={0} width={l.width} height={layout.height} className={i % 2 ? "odd" : "even"} />
                  {i > 0 && <line x1={l.x} y1={0} x2={l.x} y2={layout.height} className="flow-sep" />}
                  <text x={l.x + l.width / 2} y={24} textAnchor="middle" className="flow-lane-name">{l.name}</text>
                </g>
              ))}
              {layout.edges.map((e) => {
                const walked = walkedEdge(e.from, e.to);
                const mark = (e as Partial<MarkedEdge>).mark;
                const why = (e as Partial<MarkedEdge>).why;
                const name = (id: string) => (graph.nodes.find((n) => n.id === id) as Partial<DrawnNode> | undefined)?.label || spoken(evOf(id));
                return (
                  <path key={`${e.from}→${e.to}`} d={e.path} markerEnd={`url(#flow-arrow${mark ? `-${mark}` : ""})`}
                    className={`flow-edge${e.back ? " back" : ""}${mark ? ` m-${mark}` : ""}${lit ? (walked ? " walked" : " faded") : ""}`}
                    strokeWidth={1.2 + Math.min(2.4, Math.log2(Math.max(1, e.count)))}>
                    <title>{`${name(e.from)} → ${name(e.to)}: ${e.count ? `${e.count}× in these runs` : "not in these runs"}${mark ? ` — ${MARK[mark]}` : ""}${why ? ` (${why})` : ""}`}</title>
                  </path>
                );
              })}
              {layout.nodes.map((n) => {
                const seen = seenAt(n.id);
                const drawn = n as Partial<DrawnNode>;
                const label = drawn.label || spoken(n.event);
                return (
                  <g key={n.id} className={`flow-node t-${n.tone}${n.count === 0 ? " unseen" : ""}${drawn.extra ? " extra" : ""}${lit ? (seen ? " seen" : " faded") : ""}${isNow(n.id) ? " now" : ""}`}
                    transform={`translate(${n.x},${n.y})`} onClick={() => travel(n.id, n.event)} role="button">
                    <title>{`${label}${drawing && label !== spoken(n.event) ? ` (${spoken(n.event)})` : ""} — ${drawn.extra ? "not on the drawing; " : ""}${n.count === 0 ? "not in these runs" : `${n.count}× in these runs; ${KIND[n.tone] ?? n.tone}`}${seen ? ". Click: to where this run first did it." : ""}`}</title>
                    <rect width={NODE.w} height={NODE.h} rx={NODE.h / 2} className={tagsOf(flow, n.event).length ? "tagged" : ""} />
                    <text x={NODE.w / 2} y={NODE.h / 2 + 4} textAnchor="middle">{label}</text>
                    {tagsOf(flow, n.event).map((tag, i) => (
                      <text key={tag} x={NODE.w - 10} y={-4 - i * 11} textAnchor="end" className="flow-tag">{tag}</text>
                    ))}
                  </g>
                );
              })}
            </svg>
          )}
        {board && board.issues.length > 0 && (
          <details className="flow-issues" open>
            <summary>Changes to this drawing, agreed or open (issues.yaml): {board.issues.length}</summary>
            <ul>
              {board.issues.map((i) => (
                <li key={i.id}><b>{i.id}</b> <span className={`issue-status s-${i.status.replace(" ", "-")}`}>{i.status}</span> {i.should}{i.why ? <span className="hint"> — {i.why}</span> : null}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
