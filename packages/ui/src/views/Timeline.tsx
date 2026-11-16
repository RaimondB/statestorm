import { useMemo } from "react";
import { frameOfEntry, type Run } from "../session.ts";
import { clock, offset } from "../format.ts";
import { spoken } from "../overview.ts";

/**
 * R20: scrub to any point and see the whole world as it was then — and jump straight to the
 * part that matters: a scenario's phases ("Planning", "Execution"), or the first time an event
 * happened, so the dozens of planning steps do not have to be stepped through.
 */
export function Timeline({ run, index, since, onIndex, onChange, startedAt }: {
  run: Run; index: number; since: number; onIndex: (i: number) => void;
  /** Jump to the next / previous change the overview shows. */
  onChange: (direction: 1 | -1) => void;
  startedAt: number;
}) {
  const last = run.frames.length - 1;
  const frame = run.frames[index]!;
  const current = [...run.phases].reverse().find((p) => p.frame <= index);
  // The first occurrence of every event, in the order they first happened.
  const firsts = useMemo(() => {
    const seen = new Map<string, number>();
    for (const e of run.world.log) if (e.kind === "event" && !seen.has(e.event)) seen.set(e.event, e.seq);
    return [...seen.entries()];
  }, [run]);

  const notes = [
    ...(index - since > 1 ? [`${index - since} messages in this step`] : []),
    ...(frame.inflight.length > 0 ? [`${frame.inflight.length} in flight — the world is between consistent states`] : []),
  ];
  return (
    <>
      <div className="scrub">
        <button onClick={() => onIndex(0)} disabled={index === 0} aria-label="To the start" title="Home">⇤</button>
        <button onClick={() => onChange(-1)} disabled={index === 0} aria-label="Previous change"
          title="Back to the previous change you can see (←)">◀</button>
        <button className="step-btn" onClick={() => onIndex(Math.max(0, index - 1))} disabled={index === 0} aria-label="One message back"
          title="One message back — every internal step (Shift+←)">‹</button>
        <span className="scrub-track">
          <input type="range" min={0} max={last} value={index} onChange={(e) => onIndex(Number(e.target.value))} aria-label="Time travel" />
          {last > 0 && run.phases.map((p) => (
            <span key={`${p.name}-${p.frame}`} className="phase-tick" style={{ left: `${(p.frame / last) * 100}%` }} title={p.name} />
          ))}
        </span>
        <button className="step-btn" onClick={() => onIndex(Math.min(last, index + 1))} disabled={index === last} aria-label="One message forward"
          title="One message forward — every internal step (Shift+→)">›</button>
        <button onClick={() => onChange(1)} disabled={index === last} aria-label="Next change"
          title="On to the next change you can see (→)">▶</button>
        <button onClick={() => onIndex(last)} disabled={index === last} aria-label="To the end" title="End">⇥</button>
        <span className="pos">{index} / {last}</span>
      </div>
      {/* Two rows of fixed height, so jumping never moves the buttons or the splitter above:
          what you can jump to (the same for the whole run), then what just happened — one
          line, cut short, the full text on hover. */}
      {(run.phases.length > 0 || firsts.length > 0) && (
        <div className="step-nav">
          {run.phases.length > 0 && (
            <span className="phases" role="group" aria-label="Jump to a phase">
              {run.phases.map((p) => (
                <button key={`${p.name}-${p.frame}`} className={current === p ? "active" : ""} onClick={() => onIndex(p.frame)}
                  title={`Jump to where “${p.name}” begins`}>{p.name}</button>
              ))}
            </span>
          )}
          {firsts.length > 0 && (
            <select value="" aria-label="Jump to the first time an event happened"
              onChange={(e) => e.target.value && onIndex(frameOfEntry(run, Number(e.target.value)))}>
              <option value="">jump to the first…</option>
              {firsts.map(([name, seq]) => <option key={name} value={seq}>{spoken(name)}</option>)}
            </select>
          )}
        </div>
      )}
      <div className="step-now" title={[frame.step, ...notes].join(" · ")}>
        <span className="clock">{clock(frame.now)} · +{offset(frame.now, startedAt) || "0"}</span>
        <span className="what">{frame.step}</span>
        {notes.map((n) => <span key={n} className="hint">· {n}</span>)}
      </div>
    </>
  );
}
