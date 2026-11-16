import { useRef } from "react";
import type { FieldShape, FormValue, Row } from "../payload.ts";

interface Props {
  shape: FieldShape[];
  /** Existing instance ids per aggregate type, offered in cells that hold such an id. */
  suggestions?: Record<string, string[]>;
  value: FormValue;
  onChange: (v: FormValue) => void;
  /** Enter in a plain field fires; in a grid it adds a row instead. */
  onSubmit: () => void;
}

const TYPE_HINT = { number: "number", string: "text", boolean: "yes/no", any: "" } as const;

/** One input per field the model reads, and a grid for a list of child items. */
export function PayloadForm({ shape, suggestions = {}, value, onChange, onSubmit }: Props) {
  const set = (name: string, v: string | boolean | Row[]) => onChange({ ...value, [name]: v });
  return (
    <div className="stack">
      {shape.map((f) => {
        if (f.kind === "scalar") {
          const v = value[f.name];
          if (f.type === "boolean") {
            return (
              <label key={f.name} className="field check">
                <input type="checkbox" checked={v === true} onChange={(e) => set(f.name, e.target.checked)} />
                <span>{f.name}</span>
              </label>
            );
          }
          if (f.options) {
            return (
              <label key={f.name} className="field">
                <span>{f.name}</span>
                <select value={typeof v === "string" ? v : ""} onChange={(e) => set(f.name, e.target.value)}>
                  <option value="">— choose —</option>
                  {f.options.map((o) => <option key={o}>{o}</option>)}
                </select>
              </label>
            );
          }
          return (
            <label key={f.name} className="field">
              <span>{f.name} {TYPE_HINT[f.type] && <small>{TYPE_HINT[f.type]}</small>}</span>
              <input value={typeof v === "string" ? v : ""} inputMode={f.type === "number" ? "decimal" : undefined}
                onChange={(e) => set(f.name, e.target.value)} onKeyDown={(e) => e.key === "Enter" && onSubmit()} />
            </label>
          );
        }
        const rows = Array.isArray(value[f.name]) ? (value[f.name] as Row[]) : [{}];
        return <Grid key={f.name} field={f} rows={rows} onRows={(r) => set(f.name, r)}
          ids={f.refersTo ? suggestions[f.refersTo] ?? [] : []} suggestions={suggestions} />;
      })}
    </div>
  );
}

/** What one row stands for: the aggregate a row (or one of its cells) identifies, if any. */
function rowMeaning(field: Extract<FieldShape, { kind: "list" }>): string {
  const ref = field.refersTo ?? field.columns.find((c) => c.refersTo)?.refersTo;
  if (ref) return ` — one ${ref} per row`;
  return field.child ? ` — one ${field.child} per row` : " — a list";
}

function Grid({ field, rows, onRows, ids, suggestions }: {
  field: Extract<FieldShape, { kind: "list" }>; rows: Row[]; onRows: (r: Row[]) => void; ids: string[];
  suggestions: Record<string, string[]>;
}) {
  const listId = `ids-${field.name}`;
  const columnList = (c: string) => `ids-${field.name}-${c}`;
  const columnIds = (c: string) => {
    const t = field.columns.find((x) => x.name === c)?.refersTo;
    return t ? suggestions[t] ?? [] : [];
  };
  const body = useRef<HTMLTableSectionElement>(null);
  const columns = field.columns.length > 0 ? field.columns.map((c) => c.name) : [""];
  const types = field.columns.length > 0 ? field.columns.map((c) => c.type) : [field.rowType];
  const focus = (row: number, col: number) => requestAnimationFrame(() => {
    body.current?.querySelectorAll("tr")[row]?.querySelectorAll("input")[col]?.focus();
  });
  const setCell = (r: number, c: string, text: string) => onRows(rows.map((row, i) => (i === r ? { ...row, [c]: text } : row)));

  // Pasting several lines fills several rows; tabs (from a spreadsheet) fill the columns.
  const paste = (r: number, c: number, e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (!/[\n\t]/.test(text)) return;
    e.preventDefault();
    const lines = text.replace(/\r/g, "").split("\n").filter((l, i, all) => l !== "" || i < all.length - 1);
    const next = [...rows];
    lines.forEach((line, i) => {
      const row = { ...(next[r + i] ?? {}) };
      line.split("\t").forEach((cell, j) => { if (columns[c + j] !== undefined) row[columns[c + j]!] = cell; });
      next[r + i] = row;
    });
    onRows(next);
  };

  return (
    <fieldset className="grid-field">
      <legend>
        {field.name}
        <small>{rowMeaning(field)}</small>
      </legend>
      <table className="grid">
        {field.columns.length > 0 && (
          <thead><tr>{field.columns.map((c) => <th key={c.name}>{c.name}{TYPE_HINT[c.type] && <small> {TYPE_HINT[c.type]}</small>}</th>)}<th /></tr></thead>
        )}
        <tbody ref={body}>
          {rows.map((row, r) => (
            <tr key={r}>
              {columns.map((c, ci) => (
                <td key={c}>
                  <input value={row[c] ?? ""} aria-label={`${field.name} row ${r + 1}${c ? ` ${c}` : ""}`}
                    inputMode={types[ci] === "number" ? "decimal" : undefined}
                    list={!c ? (ids.length > 0 ? listId : undefined) : columnIds(c).length > 0 ? columnList(c) : undefined}
                    placeholder={r === 0 && !c ? (field.refersTo ? `a ${field.refersTo} id` : `e.g. ${field.child ? "an id" : "a value"}`) : undefined}
                    onChange={(e) => setCell(r, c, e.target.value)}
                    onPaste={(e) => paste(r, ci, e)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      if (r === rows.length - 1) onRows([...rows, {}]);
                      focus(r + 1, ci);
                    }} />
                </td>
              ))}
              <td className="row-op">
                <button aria-label={`Remove row ${r + 1}`} title="Remove row"
                  onClick={() => onRows(rows.length > 1 ? rows.filter((_, i) => i !== r) : [{}])}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <button className="add-row" onClick={() => { onRows([...rows, {}]); focus(rows.length, 0); }}>+ add row</button>
        {ids.length > 0 && (
          <button className="add-row" title={`One row for each ${field.refersTo} that exists`}
            onClick={() => onRows(ids.map((id) => ({ "": id })))}>all {ids.length} {field.refersTo}s</button>
        )}
      </div>
      {ids.length > 0 && <datalist id={listId}>{ids.map((id) => <option key={id} value={id} />)}</datalist>}
      {field.columns.filter((c) => columnIds(c.name).length > 0).map((c) => (
        <datalist key={c.name} id={columnList(c.name)}>{columnIds(c.name).map((id) => <option key={id} value={id} />)}</datalist>
      ))}
    </fieldset>
  );
}
