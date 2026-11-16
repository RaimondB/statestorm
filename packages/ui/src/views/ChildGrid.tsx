import { isFinalConfiguration, refOf, type Frame, type Model } from "@statestorm/kernel";
import type { Selection } from "../selection.ts";

/**
 * A parent's children as a table — one row per child, its state and its data — grouped by
 * relation. The tally a quantifier reads, made visible (ADR 0004).
 */
export function ChildGrid({ model, frame, parentKey, selection, select }: {
  model: Model; frame: Frame; parentKey: string; selection: Selection; select: (s: Selection) => void;
}) {
  const children = Object.values(frame.instances).filter((i) => i.parent?.key === parentKey);
  const rels = [...new Set(children.map((c) => c.parent!.rel))];
  return (
    <>
      {rels.map((rel) => {
        const rows = children.filter((c) => c.parent!.rel === rel);
        const types = [...new Set(rows.map((r) => r.machine))];
        const mixed = types.length > 1;
        const fields = [...new Set(types.flatMap((t) => Object.keys(model.aggregates[t]?.data ?? {})))];
        const finalOf = (r: (typeof rows)[number]) => {
          const m = model.aggregates[r.machine];
          return m ? isFinalConfiguration(m, r.config) : false;
        };
        const finals = rows.filter(finalOf).length;
        return (
          <div key={rel} className="child-grid" onClick={(e) => e.stopPropagation()}>
            <div className="child-grid-head">
              <b>{rel}</b> · {rows.length} {mixed ? "of several types" : rows[0]!.machine} · {finals}/{rows.length} final
            </div>
            <table className="grid readonly">
              <thead><tr>{mixed && <th>type</th>}<th>id</th><th>state</th>{fields.map((f) => <th key={f}>{f}</th>)}</tr></thead>
              <tbody>
                {rows.map((c) => {
                  const path = c.config[0] ?? [];
                  const sel = selection?.kind === "instance" && selection.key === c.key;
                  return (
                    <tr key={c.key} className={sel ? "selected" : ""} onClick={() => select({ kind: "instance", key: c.key })}>
                      {mixed && <td>{c.machine}</td>}
                      <td className="mono">{c.key.slice(c.key.indexOf("#") + 1)}</td>
                      <td className="mono" title={refOf(path)}>{finalOf(c) ? "◎ " : ""}{path.at(-1)}</td>
                      {fields.map((f) => <td key={f} className="mono">{c.data[f] === undefined ? "" : typeof c.data[f] === "string" ? c.data[f] as string : JSON.stringify(c.data[f])}</td>)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}
