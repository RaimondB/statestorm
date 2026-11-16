import { useMemo, useRef, useState } from "react";

export interface PickerGroup { id: string; label: string; files: string[] }

/**
 * The scenario picker: a field you can type in. Closed, it shows the scenario chosen; open, a list
 * grouped as the drawings group them, narrowed to what matches what is typed — a number ("39a"),
 * a reference among its tags ("WOM-12"), or any part of a scenario's file name or title. ↑/↓ move,
 * Enter opens, Esc closes.
 */
export function ScenarioPicker({ groups, value, label, nameOf, onChoose }: {
  groups: PickerGroup[];
  value: string;
  label: (file: string) => string;
  nameOf: (file: string) => string;
  onChoose: (file: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const q = query.trim().toLowerCase();
  const matches = (f: string) => !q || label(f).toLowerCase().includes(q) || nameOf(f).toLowerCase().includes(q);
  const shown = useMemo(
    () => groups.map((g) => ({ ...g, files: g.files.filter(matches) })).filter((g) => g.files.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, q],
  );
  // One row per choice, in the order shown; a file under two drawings is one choice, first place.
  const choices = useMemo(() => {
    const seen = new Set<string>();
    const all = ["", ...shown.flatMap((g) => g.files)].filter((f) => (seen.has(f) ? false : (seen.add(f), true)));
    // A file named exactly comes first: typing a whole name opens that one.
    const exact = all.find((f) => q && f.toLowerCase() === q);
    return exact ? [exact, ...all.filter((f) => f !== exact)] : q ? all.filter((f) => f !== "") : all;
  }, [shown, q]);

  const choose = (f: string) => {
    onChoose(f);
    setOpen(false);
    setQuery("");
    input.current?.blur();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, choices.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const f = choices[active]; if (f !== undefined) choose(f); }
    else if (e.key === "Escape") { setOpen(false); setQuery(""); input.current?.blur(); }
  };

  const activeFile = choices[active];
  const row = (f: string, text: string) => (
    <li
      key={f || "free"} role="option" aria-selected={f === activeFile}
      className={`${f === activeFile ? "active" : ""}${f === value ? " chosen" : ""}`}
      title={f ? nameOf(f) : undefined}
      onMouseDown={(e) => { e.preventDefault(); choose(f); }}
      onMouseEnter={() => setActive(choices.indexOf(f))}
    >
      {text}
    </li>
  );

  return (
    <span className="scenario-picker">
      <input
        ref={input}
        role="combobox" aria-expanded={open} aria-label="Scenario — type a number or part of its name"
        placeholder={open ? "type: 39a, cancel, reverse pick…" : undefined}
        value={open ? query : value ? label(value) : "— free run —"}
        onFocus={() => { setOpen(true); setQuery(""); setActive(Math.max(0, choices.indexOf(value))); }}
        onBlur={() => { setOpen(false); setQuery(""); }}
        onChange={(e) => { setQuery(e.target.value); setActive(0); setOpen(true); }}
        onKeyDown={onKey}
      />
      {open && (
        <ul role="listbox" className="scenario-picker-list">
          {!q && row("", "— free run —")}
          {shown.map((g) => (
            <li key={g.id} className="group" role="presentation">
              <span>{g.label}</span>
              <ul>{g.files.map((f) => row(f, label(f)))}</ul>
            </li>
          ))}
          {q && shown.length === 0 && <li className="none">no scenario matches “{query}”</li>}
        </ul>
      )}
    </span>
  );
}
