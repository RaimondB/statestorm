import type { Model } from "@statestorm/kernel";
import type { Run } from "../session.ts";
import { ChildGrid } from "./ChildGrid.tsx";
import type { Selection } from "../selection.ts";
import { compact, offset } from "../format.ts";

const KIND_GLYPH = { command: "▸", deliver: "◆", timer: "◔", tally: "∑", done: "✓" } as const;

/** The world at the current frame: who exists, in what state, and what is still in flight. */
export function WorldPanel({ model, run, index, selection, select }: {
  model: Model; run: Run; index: number; selection: Selection; select: (s: Selection) => void;
}) {
  const frame = run.frames[index]!;
  const prev = index > 0 ? run.frames[index - 1]! : undefined;
  const all = Object.values(frame.instances);
  // Children are shown in their parent's grid, not as rows of their own — unless the parent
  // does not exist (yet), which is itself worth seeing.
  const instances = all.filter((i) => !i.parent || !frame.instances[i.parent.key]);

  return (
    <>
      <section>
        <h2>In flight ({frame.inflight.length})</h2>
        {frame.inflight.length === 0
          ? <div className="hint">Nothing in flight — the world is quiescent.</div>
          : (
            <ul className="flight">
              {frame.inflight.map((m, i) => (
                <li key={i} className={`k-${m.kind}${i === 0 ? " next" : ""}`}
                  title={i === 0 ? "Next under fifo — other schedules may pick another" : undefined}>
                  {KIND_GLYPH[m.kind]} {m.text}{m.redelivery ? "  ⟳ redelivery" : ""}
                </li>
              ))}
            </ul>
          )}
      </section>

      <section>
        <h2>Instances ({all.length})</h2>
        {instances.length === 0 ? <div className="hint">None yet.</div> : (
          <table className="instances">
            <tbody>
              {instances.map((inst) => {
                const changed = prev && prev.instances[inst.key] !== inst;
                const path = inst.config[0] ?? [];
                return (
                  <tr key={inst.key}
                    className={`${selection?.kind === "instance" && selection.key === inst.key ? "selected" : ""}${changed ? " changed" : ""}`}
                    onClick={() => select({ kind: "instance", key: inst.key })}>
                    <td>
                      <div><b>{inst.key}</b>{inst.kind === "policy" && <span className="hint"> policy</span>}</div>
                      <div className="mono">{path.slice(0, -1).map((p) => `${p}.`).join("")}<b>{path.at(-1)}</b></div>
                      {Object.keys(inst.data).length > 0 && <div className="data">{compact(inst.data)}</div>}
                      {inst.parent && <div className="hint">child of {inst.parent.key}, which does not exist</div>}
                      <ChildGrid model={model} frame={frame} parentKey={inst.key} selection={selection} select={select} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {frame.timers.length > 0 && (
        <section>
          <h2>Deadlines pending</h2>
          <ul className="flight">
            {[...frame.timers].sort((a, b) => a.at - b.at).map((t, i) => (
              <li key={i} className="k-timer">◔ {t.instance} · {t.label} on <code>{t.state}</code> · in {offset(t.at, frame.now) || "0m"}</li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
