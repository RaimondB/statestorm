import type { Agenda, AgendaStep } from "../agenda.ts";

/**
 * The agenda bar (ADR 0025): where a meeting is — the item and its title, the scenario within it,
 * what to say and what to raise — and ‹ › through every scenario of the agenda, in its order.
 */
export function AgendaBar({ agenda, steps, at, nameOf, onStep, onClose, onRule }: {
  agenda: Agenda;
  steps: AgendaStep[];
  /** The step shown; -1: the scenario open is not on the agenda. */
  at: number;
  nameOf: (file: string) => string;
  onStep: (n: number) => void;
  onClose: () => void;
  /** Open a rule or question in the docs; absent, the ids are plain text. */
  onRule?: (id: string) => void;
}) {
  const step = steps[at];
  const item = step ? agenda.items[step.item]! : undefined;
  const number = (f: string) => f.split("-")[0];
  return (
    <section className="agenda-bar" aria-label={`Agenda: ${agenda.title}`}>
      <div className="agenda-row">
        <span className="agenda-title" title={agenda.date ? `${agenda.title} · ${agenda.date}` : agenda.title}>{agenda.title}</span>
        <button onClick={() => onStep(Math.max(0, at - 1))} disabled={at <= 0} aria-label="Previous scenario on the agenda">‹</button>
        {step && item ? (
          <span className="agenda-where" title={`${step.item + 1} / ${agenda.items.length} ${item.title} — ${nameOf(step.file)}`}>
            <b>{step.item + 1} / {agenda.items.length}</b> {item.title}
            <span className="agenda-scenario" title={nameOf(step.file)}>
              {number(step.file)}{item.scenarios.length > 1 ? ` · ${step.at + 1} of ${item.scenarios.length}` : ""}{step.at > 0 ? " · variant" : ""}
            </span>
          </span>
        ) : (
          <span className="agenda-where hint">not on the agenda — ‹ › go back to it</span>
        )}
        <button onClick={() => onStep(at < 0 ? 0 : Math.min(steps.length - 1, at + 1))} disabled={at >= steps.length - 1} aria-label="Next scenario on the agenda">›</button>
        <span className="agenda-count hint">{at >= 0 ? at + 1 : "–"} / {steps.length}</span>
        <button className="agenda-close" onClick={onClose} title="Leave the agenda — every scenario again">✕</button>
      </div>
      {item && (item.note || item.questions.length > 0) && (
        <div className="agenda-row agenda-detail">
          {item.note && <span className="agenda-note">{item.note}</span>}
          {item.questions.length > 0 && (
            <span className="agenda-questions">
              raise: {item.questions.map((q) => onRule
                ? <button key={q} className="agenda-q" onClick={() => onRule(q)} title={`${q} in the docs`}>{q}</button>
                : <span key={q} className="agenda-q">{q}</span>)}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
