import { useState } from "react";

/** Text-first (Q2): the model is a YAML file; the views are how you check it. */
export function ModelEditor({ text, error, onApply, onClose }: {
  text: string; error?: string; onApply: (t: string) => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState(text);
  const dirty = draft !== text;
  return (
    <div className="editor" role="dialog" aria-label="Model source">
      <header>
        <strong>Model source</strong>
        <span className="hint">Applying replays the current steps against the edited model.</span>
        <span className="spacer" />
        <button onClick={() => {
          const blob = new Blob([draft], { type: "text/yaml" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "model.yaml";
          a.click();
          URL.revokeObjectURL(a.href);
        }}>Download</button>
        <button className="primary" disabled={!dirty} onClick={() => onApply(draft)}>Apply</button>
        <button onClick={onClose}>Close</button>
      </header>
      {error && <div className="error-box" style={{ margin: 8 }}>{error}</div>}
      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false}
        onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") onApply(draft); if (e.key === "Escape") onClose(); }} />
    </div>
  );
}
