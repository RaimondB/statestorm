import { useEffect, useMemo, useState } from "react";
import { parse as parseYaml, stringify } from "yaml";
import { parseDuration, type Frame, type Json, type Model } from "@statestorm/kernel";
import { commandsOf, describeAction, fireableTypes, typeToFire, type Action, type Run } from "../session.ts";
import { emptyForm, fromPayload, payloadShape, toPayload, type FormValue } from "../payload.ts";
import { offset } from "../format.ts";
import { PayloadForm } from "./PayloadForm.tsx";

interface Props {
  model: Model;
  frame: Frame;
  actions: Action[];
  run: Run;
  index: number;
  last: number;
  onAct: (a: Action) => void;
  onIndex: (i: number) => void;
  onClear: () => void;
}

/**
 * "Fire this command" is the interaction a stakeholder needs (Q2: text-first, the
 * board becomes clickable for running long before it is editable).
 */
export function Fire({ model, frame, actions, run, index, last, onAct, onIndex, onClear }: Props) {
  const types = useMemo(() => fireableTypes(model), [model]);
  const [type, setType] = useState(() => typeToFire(model, ""));
  const machine = model.aggregates[type];
  const commands = useMemo(() => (machine ? commandsOf(machine) : []), [machine]);
  const [command, setCommand] = useState(commands[0] ?? "");
  const [id, setId] = useState("A1");
  const [payload, setPayload] = useState("");
  const [mode, setMode] = useState<"form" | "yaml">("form");
  const [form, setForm] = useState<FormValue>({});
  const [sentWithout, setSentWithout] = useState<string[]>([]);
  const [duration, setDuration] = useState("1d");
  const [problem, setProblem] = useState<string>();

  useEffect(() => { const t = typeToFire(model, type); if (t !== type) setType(t); }, [model, type]);
  useEffect(() => { if (!commands.includes(command)) setCommand(commands[0] ?? ""); }, [commands, command]);

  const shape = useMemo(() => (type && command ? payloadShape(model, type, command) : []), [model, type, command]);
  useEffect(() => { setForm(emptyForm(shape)); setPayload(""); setSentWithout([]); }, [shape]);
  const suggestions = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const i of Object.values(frame.instances)) (out[i.machine] ??= []).push(i.key.slice(i.machine.length + 1));
    return out;
  }, [frame]);
  const existing = Object.values(frame.instances).filter((i) => i.machine === type).map((i) => i.key.slice(type.length + 1));
  const behind = index < last;
  const dropped = behind ? actions.length - 1 - (run.actionOf[index] ?? -1) : 0;

  const parseRaw = (): Record<string, Json> => {
    if (!payload.trim()) return {};
    const value = parseYaml(payload.trim().startsWith("{") ? payload : `{${payload}}`);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected fields, like  amount: 100");
    return value as Record<string, Json>;
  };

  const fire = () => {
    let parsed: Record<string, Json>;
    let missing: string[] = [];
    try {
      if (mode === "yaml") parsed = parseRaw();
      else ({ payload: parsed, missing } = toPayload(shape, form));
    } catch (err) {
      setProblem(`payload: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    setProblem(undefined);
    setSentWithout(missing);
    onAct({ kind: "send", ref: `${type}#${id}.${command}`, payload: parsed });
  };

  const switchMode = () => {
    try {
      if (mode === "form") {
        const { payload: p } = toPayload(shape, form);
        setPayload(Object.keys(p).length ? stringify(p, { flow: true }).trim().replace(/^\{\s*|\s*\}$/g, "") : "");
        setMode("yaml");
      } else {
        setForm(fromPayload(shape, parseRaw()));
        setMode("form");
      }
      setProblem(undefined);
    } catch (err) {
      setProblem(`cannot switch: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const advanceBy = (text: string) => {
    try {
      onAct({ kind: "advance", ms: parseDuration(text), label: text });
      setProblem(undefined);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    }
  };

  const nextTimer = [...frame.timers].sort((a, b) => a.at - b.at)[0];

  return (
    <>
      <section>
        <h2>Fire a command</h2>
        <div className="panel stack">
          <div className="row">
            <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Aggregate type">
              {types.map((t) => <option key={t}>{t}</option>)}
            </select>
            <span>#</span>
            <input value={id} onChange={(e) => setId(e.target.value)} list="instance-ids" aria-label="Instance id" style={{ maxWidth: "6em" }} />
            <datalist id="instance-ids">{existing.map((x) => <option key={x} value={x} />)}</datalist>
          </div>
          <div className="row">
            <select value={command} onChange={(e) => setCommand(e.target.value)} aria-label="Command">
              {commands.map((c) => <option key={c}>{c}{machine?.creators.includes(c) ? "  (creates)" : ""}</option>)}
            </select>
          </div>
          {mode === "form" ? (
            shape.length > 0
              ? <PayloadForm shape={shape} value={form} onChange={setForm} onSubmit={fire} suggestions={suggestions} />
              : <div className="hint">The model reads nothing from this command’s payload.</div>
          ) : (
            <input className="mono" value={payload} onChange={(e) => setPayload(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && fire()} aria-label="Payload as YAML"
              placeholder={shape.map((f) => `${f.name}: …`).join(", ") || "no payload read"} />
          )}
          <div className="hint row" style={{ justifyContent: "space-between" }}>
            <span>{shape.length > 0 && mode === "form" ? "Fields are what the model reads." : ""}</span>
            <a href="#" onClick={(e) => { e.preventDefault(); switchMode(); }}>{mode === "form" ? "edit as YAML" : "back to the form"}</a>
          </div>
          <button className="primary" onClick={fire} disabled={!type || !command}>
            ▸ {type}#{id}.{command}
          </button>
          <div className="row">
            <input value={duration} onChange={(e) => setDuration(e.target.value)} onKeyDown={(e) => e.key === "Enter" && advanceBy(duration)}
              aria-label="Advance the clock by" style={{ flex: "0 0 4.5em" }} />
            <button onClick={() => advanceBy(duration)} style={{ flex: 1 }}>» advance the clock</button>
          </div>
          <button disabled={!nextTimer}
            title={nextTimer ? `${nextTimer.instance}: ${nextTimer.label} on ${nextTimer.state}` : undefined}
            onClick={() => nextTimer && onAct({ kind: "advance", ms: nextTimer.at - frame.now, label: offset(nextTimer.at, frame.now) || "0m" })}>
            {nextTimer ? `◔ to the next deadline (+${offset(nextTimer.at, frame.now) || "0m"})` : "◔ no deadline pending"}
          </button>
          {behind && dropped > 0 && (
            <div className="notice">You are looking at the past. Acting here forks the run and drops the {dropped} later step{dropped === 1 ? "" : "s"}.</div>
          )}
          {problem && <div className="error-box">{problem}</div>}
          {sentWithout.length > 0 && !problem && (
            <div className="notice">Sent without {sentWithout.join(", ")} — the model sees {sentWithout.length === 1 ? "it" : "them"} as missing.</div>
          )}
          {run.error && <div className="error-box">step {run.error.action + 1} failed: {run.error.message}</div>}
        </div>
      </section>

      <section>
        <h2>Steps <button style={{ float: "right", fontSize: "0.75rem", padding: "0 6px" }} onClick={onClear} disabled={actions.length === 0}>clear</button></h2>
        {actions.length === 0 ? <div className="hint">Nothing yet. Fire a command, or pick a scenario.</div> : (
          <ol className="steps">
            {actions.map((a, i) => {
              const owner = run.actionOf[index] ?? -1;
              const lastFrame = run.actionOf.lastIndexOf(i);
              return (
                a.kind === "phase"
                  ? <li key={i} className="phase-step" onClick={() => { const p = run.phases.find((x) => x.name === a.name); if (p) onIndex(p.frame); }}
                      title="Jump to where this phase begins">{a.name}</li>
                  :
                <li key={i} className={i === owner ? "current" : i > owner ? "future" : ""}
                  onClick={() => lastFrame >= 0 && onIndex(lastFrame)} title="Jump to where this step settled">
                  {describeAction(a)}
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </>
  );
}
