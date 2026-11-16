import { useEffect, useMemo, useRef, useState } from "react";
import { describe } from "@statestorm/kernel";
import { depths } from "@statestorm/scenarios";
import { frameOfEntry, type Run } from "../session.ts";
import type { Selection } from "../selection.ts";
import { GLYPH, offset } from "../format.ts";

/**
 * R26 + R27: the ordered log, indented by causation, readable aloud. The entries the current
 * step wrote are marked; what has not happened yet stays visible but faded, so the cursor
 * reads as "now" in a story whose end you can see.
 */
export function Trace({ run, index, since, onIndex, selection, select, startedAt }: {
  run: Run; index: number; since: number; onIndex: (i: number) => void; selection: Selection;
  select: (s: Selection) => void; startedAt: number;
}) {
  const [filter, setFilter] = useState("");
  const [hideFuture, setHideFuture] = useState(false);
  // A broadcast reaches everything that points at its source and most of it has no answer:
  // kept in the log, folded away here unless asked for (ADR 0007 §5).
  const [showIgnored, setShowIgnored] = useState(false);
  const log = run.world.log;
  const depth = useMemo(() => depths(log), [log]);
  const lines = useMemo(() => log.map((e) => ({ e, text: describe(e) })), [log]);
  const frame = run.frames[index]!;
  const prevSeq = since >= 0 ? run.frames[since]!.seq : 0;
  const nowRef = useRef<HTMLLIElement>(null);

  // Keep "now" in view inside the trace's own scroll area. On a phone the trace is part of the
  // page, and scrolling it there would yank the whole page away from the chart.
  useEffect(() => {
    const li = nowRef.current;
    const box = li?.closest<HTMLElement>(".trace");
    if (!li || !box || box.scrollHeight <= box.clientHeight) return;
    const top = li.offsetTop - box.offsetTop;
    if (top < box.scrollTop + 40 || top > box.scrollTop + box.clientHeight - 40) box.scrollTop = top - box.clientHeight / 3;
  }, [index]);

  const needle = filter.trim().toLowerCase();
  const ignoredCount = log.filter((e) => e.kind === "ignored").length;
  const shown = lines.filter(({ e, text }) =>
    (!needle || text.toLowerCase().includes(needle)) && (!hideFuture || e.seq <= frame.seq) &&
    (showIgnored || e.kind !== "ignored" || (selection?.kind === "entry" && selection.seq === e.seq)));
  const firstNow = shown.find(({ e }) => e.seq > prevSeq && e.seq <= frame.seq)?.e.seq;

  return (
    <>
      <div className="trace-head">
        <strong>Trace</strong>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter: an instance, an event, a command…" aria-label="Filter the trace" />
        <label className="hint"><input type="checkbox" checked={hideFuture} onChange={(e) => setHideFuture(e.target.checked)} /> hide what has not happened yet</label>
        {ignoredCount > 0 && (
          <label className="hint" title="Broadcasts that reached an instance they meant nothing to">
            <input type="checkbox" checked={showIgnored} onChange={(e) => setShowIgnored(e.target.checked)} /> show {ignoredCount} ignored
          </label>
        )}
        <span className="hint" style={{ marginLeft: "auto" }}>{log.length} entries · click one to travel there</span>
      </div>
      <ol className="log">
        {shown.map(({ e, text }) => {
          const when = e.seq > frame.seq ? "future" : e.seq > prevSeq ? "now" : "past";
          const sel = selection?.kind === "entry" && selection.seq === e.seq;
          return (
            <li key={e.seq} ref={e.seq === firstNow ? nowRef : undefined}
              className={`k-${e.kind} ${when}${e.kind === "finding" ? ` s-${e.severity}` : ""}${sel ? " selected" : ""}`}
              onClick={() => { onIndex(frameOfEntry(run, e.seq)); select({ kind: "entry", seq: e.seq }); }}>
              <span className="seq">{e.seq}</span>
              <span className="at">{offset(e.at, startedAt) || "0"}</span>
              <span aria-hidden>{GLYPH[e.kind]}</span>
              <span className="text" style={{ paddingLeft: `${(depth.get(e.seq) ?? 0) * 1.1}em` }}>
                {text}
                {e.kind === "transition" && !e.internal && <span className="hint"> · via {e.via.replace(/^\S+\./, "")}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </>
  );
}
