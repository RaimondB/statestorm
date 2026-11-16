import { Fragment, type ReactNode } from "react";
import { describe, refOf, roleOfCommand, senderOfCommand, type Json, type LogEntry, type Model } from "@statestorm/kernel";
import { allTransitions } from "../chart-layout.ts";
import { frameOfEntry, machineOfKey, type Run } from "../session.ts";
import type { Selection } from "../selection.ts";
import { GLYPH } from "../format.ts";
import { ChildGrid } from "./ChildGrid.tsx";
import { rulesCiting, termsNaming, type DocsData } from "../docs-links.ts";
import { About } from "./About.tsx";
import type { DocPlace } from "./Docs.tsx";
import type { MachineDef, StateDef } from "@statestorm/kernel";

interface Props {
  model: Model;
  run: Run;
  index: number;
  selection: Selection;
  select: (s: Selection) => void;
  onIndex: (i: number) => void;
  /** The domain's docs: the rules a state or a transition cites, beside it (ADR 0016 §9). */
  docs?: DocsData;
  onRule?: (id: string) => void;
  onDoc?: (p: DocPlace) => void;
}

function stateAt(machine: MachineDef, ref: string): StateDef | undefined {
  let states = machine.states;
  let s: StateDef | undefined;
  for (const name of ref.split(".")) { s = states[name]; if (!s) return undefined; states = s.states; }
  return s;
}

/**
 * Shared across views (design §5): select anything and see its definition, its history in
 * this run so far, and — for anything that did not happen — why (R21).
 */
export function Inspector({ model, run, index, selection, select, onIndex, docs, onRule, onDoc }: Props) {
  const about = (props: { type?: string; pkg?: string; brief?: boolean }) => (
    <About model={model} docs={docs} onRule={onRule ?? (() => {})} onDoc={onDoc ?? (() => {})}
      onPackage={(name) => select({ kind: "package", name })} {...props} />
  );
  /** The rules an element cites (`why:`), with their titles, each a link into the docs. */
  const Why = ({ ids, title = "Rules it implements" }: { ids?: string[]; title?: string }) => {
    if (!ids?.length) return null;
    return (
      <>
        <h4>{title}</h4>
        <ul className="inspect-rules">{ids.map((id) => {
          const r = docs?.rules.get(id);
          const q = docs?.questions.get(id);
          return <li key={id}>{docs && (r || q) && onRule
            ? <a className={`doc-id ${r?.status ?? q?.status ?? ""}`} onClick={() => onRule(id)}>{id}</a>
            : <code>{id}</code>} {r?.title ?? q?.question ?? (docs ? <span className="hint">— not in the docs</span> : null)}
            {r && r.status !== "agreed" && <span className={`doc-status ${r.status}`}>{r.status}</span>}</li>;
        })}</ul>
      </>
    );
  };
  const frame = run.frames[index]!;
  const past = run.world.log.filter((e) => e.seq <= frame.seq);
  const travel = (e: LogEntry) => { onIndex(frameOfEntry(run, e.seq)); select({ kind: "entry", seq: e.seq }); };
  const History = ({ entries, empty }: { entries: LogEntry[]; empty: string }) =>
    entries.length === 0 ? <div className="hint">{empty}</div> : (
      <ul>{entries.map((e) => (
        <li key={e.seq} style={{ cursor: "pointer" }} onClick={() => travel(e)}>
          <span className="hint">#{e.seq}</span> {GLYPH[e.kind]} {describe(e)}
        </li>
      ))}</ul>
    );

  if (!selection) {
    return (
      <div className="hint">
        <h3 style={{ color: "var(--fg)" }}>Inspector</h3>
        <p>Click a state, a transition, an instance chip or a trace line to see what it is, what it has done in this run so far, and why things did not happen. Click a type or a package in the structure to see what the domain's docs say of it.</p>
        <p>← / → step through the run one input at a time. Firing a command while looking at the past forks the run from there.</p>
      </div>
    );
  }

  /** A list of rules as links, or nothing. */
  const RuleList = ({ rules, title }: { rules: { id: string }[]; title: string }) =>
    rules.length === 0 ? null : <Why ids={rules.map((r) => r.id)} title={title} />;
  const Terms = ({ name }: { name: string }) => !docs ? null : <>{termsNaming(docs, name).map((term) => (
    <p key={term.term} className="about-docs"><a onClick={() => onDoc?.({ page: "glossary", at: term.term })}><b>{term.term}</b></a> — {term.definition}</p>
  ))}</>;

  if (selection.kind === "message") {
    const { event, command, policy } = selection;
    const [ctype, cname] = command ? [command.slice(0, command.indexOf(".")), command.slice(command.indexOf(".") + 1)] : [];
    const raisers = event ? Object.values(model.aggregates).flatMap((m) => allTransitions(m)
      .filter((t) => !t.transition.inheritedFrom && t.transition.emit.some((e) => e.event === event)).map((t) => ({ machine: m.name, t }))) : [];
    const cm = ctype ? model.aggregates[ctype] : undefined;
    const handlers = cm && cname ? allTransitions(cm).filter((t) => t.name.split("#")[0] === cname) : [];
    const pol = policy ? model.policies[policy] : undefined;
    const reacting = !policy && event ? Object.values(model.policies).filter((p) => allTransitions(p).some((t) => t.name.split("#")[0] === event)) : [];
    const outside = event ? (model.systems?.subsystems ?? []).filter((x) => (x.receives ?? []).includes(event)) : [];
    const senders = ctype && cname ? (model.systems?.subsystems ?? []).filter((x) => (x.sends ?? []).some((snd) => snd.type === ctype && snd.command === cname)) : [];
    return (
      <div>
        <span className="kind-tag">{event && command ? "event, and the command it became" : event ? "event" : "command"}</span>
        <h3>{event && command ? <>{event} → {command}</> : event ?? command}</h3>
        {event && (<>
          <h4><b style={{ color: "var(--event)" }}>◆ {event}</b></h4>
          <Terms name={event} />
          {raisers.length > 0 && <><div className="hint">raised by</div><ul>{raisers.map(({ machine, t }) => (
            <li key={t.id}><Link onClick={() => select({ kind: "transition", machine, id: t.id })}>{machine}.{t.ownerRef} on {t.name}</Link>
              {t.transition.why?.length ? <span className="hint"> · {t.transition.why.join(", ")}</span> : null}</li>
          ))}</ul></>}
          {outside.length > 0 && <div className="hint">told to {outside.map((x) => x.system === x.name ? x.name : `${x.system} (${x.name})`).join(", ")}</div>}
          <Why ids={[...new Set(raisers.flatMap(({ t }) => t.transition.why ?? []))]} title="Rules where it is raised" />
        </>)}
        {pol && (<>
          <h4>Policy <code>{pol.name}</code></h4>
          <Why ids={[...new Set([...(pol.why ?? []), ...allTransitions(pol).filter((t) => !event || t.name.split("#")[0] === event).flatMap((t) => t.transition.why ?? [])])]} title="Rules it implements" />
        </>)}
        {reacting.length > 0 && <><div className="hint">policies reacting to it</div><ul>{reacting.map((p) => <li key={p.name}><code>{p.name}</code>{p.why?.length ? <span className="hint"> · {p.why.join(", ")}</span> : null}</li>)}</ul></>}
        {command && (<>
          <h4><b style={{ color: "var(--command)" }}>▸ {command}</b></h4>
          <Terms name={command} />
          {senders.length > 0 && <div className="hint">sent from outside by {senders.map((x) => x.system === x.name ? x.name : `${x.system} (${x.name})`).join(", ")}</div>}
          {handlers.length > 0 && <><div className="hint">handled in</div><ul>{handlers.map((t) => (
            <li key={t.id}><Link onClick={() => select({ kind: "transition", machine: ctype!, id: t.id })}>{ctype}.{t.ownerRef} on {t.name}</Link>
              {t.transition.guard ? <span className="hint"> if <code>{t.transition.guard}</code></span> : null}</li>
          ))}</ul></>}
          <Why ids={[...new Set(handlers.flatMap((t) => t.transition.why ?? []))]} title="Rules where it is handled" />
          {cm && docs && <><h4>About {ctype}</h4>{about({ type: ctype, brief: true })}</>}
        </>)}
      </div>
    );
  }

  if (selection.kind === "place") {
    const sys = model.systems;
    const { level, name } = selection;
    const system = level === "system" ? sys?.systems.find((x) => x.name === name) : undefined;
    const sub = level === "subsystem" ? sys?.subsystems.find((x) => x.name === name && (!selection.system || x.system === selection.system)) : undefined;
    const context = level === "context" ? sys?.contexts.find((x) => x.name === name) : undefined;
    const domain = level === "domain" ? sys?.domains.find((x) => x.name === name) : undefined;
    const subs = level === "system" ? (sys?.subsystems ?? []).filter((x) => x.system === name)
      : level === "context" ? (sys?.subsystems ?? []).filter((x) => x.context === name) : sub ? [sub] : [];
    const packages = [...new Set(subs.flatMap((x) => x.packages))];
    const held = level === "domain" ? (sys?.systems ?? []).filter((x) => x.domain === name) : [];
    const sends = [...new Set(subs.flatMap((x) => (x.sends ?? []).map((snd) => `${snd.type}.${snd.command}`)))];
    const receives = [...new Set(subs.flatMap((x) => x.receives ?? []))];
    const where = level === "subsystem" ? `sub-system ${sub?.system}.${name}` : `${level} ${name}`;
    const relations = (sys?.relations ?? []).filter((r) => r.upstream === name || r.downstream === name);
    const note = system?.note ?? sub?.note ?? context?.note ?? domain?.note;
    const kindName = level === "subsystem" ? "sub-system" : level === "context" ? "bounded context" : level;
    return (
      <div>
        <span className="kind-tag">{system?.external || sub?.external ? `external ${kindName}` : kindName}</span>
        <h3>{name}</h3>
        {note && <p>{note}</p>}
        <dl>
          {context?.team && <><dt>team</dt><dd>{context.team}</dd></>}
          {system?.domain && <><dt>domain</dt><dd><Link onClick={() => select({ kind: "place", level: "domain", name: system.domain! })}>{system.domain}</Link></dd></>}
          {sub && <><dt>system</dt><dd><Link onClick={() => select({ kind: "place", level: "system", name: sub.system })}>{sub.system}</Link></dd>
            <dt>context</dt><dd><Link onClick={() => select({ kind: "place", level: "context", name: sub.context })}>{sub.context}</Link></dd></>}
          {held.length > 0 && <><dt>systems</dt><dd>{held.map((x, i) => <Fragment key={x.name}>{i ? ", " : ""}<Link onClick={() => select({ kind: "place", level: "system", name: x.name })}>{x.name}</Link></Fragment>)}</dd></>}
          {level !== "subsystem" && subs.length > 1 && <><dt>sub-systems</dt><dd>{subs.map((x, i) => <Fragment key={`${x.system}/${x.name}`}>{i ? ", " : ""}<Link onClick={() => select({ kind: "place", level: "subsystem", name: x.name, system: x.system })}>{level === "context" && x.system !== x.name ? `${x.system} · ${x.name}` : x.name}</Link></Fragment>)}</dd></>}
          {packages.length > 0 && <><dt>packages</dt><dd>{packages.map((pk, i) => <Fragment key={pk}>{i ? ", " : ""}<Link onClick={() => select({ kind: "package", name: pk })}>{pk}</Link></Fragment>)}</dd></>}
          {sends.length > 0 && <><dt>sends</dt><dd>{sends.map((c, i) => <Fragment key={c}>{i ? ", " : ""}<Link onClick={() => select({ kind: "message", command: c })}>{c}</Link></Fragment>)}</dd></>}
          {receives.length > 0 && <><dt>is told</dt><dd>{receives.map((e, i) => <Fragment key={e}>{i ? ", " : ""}<Link onClick={() => select({ kind: "message", event: e })}>{e}</Link></Fragment>)}</dd></>}
          {relations.length > 0 && <><dt>relations</dt><dd>{relations.map((r) => <div key={`${r.upstream}-${r.downstream}-${r.pattern}`}>{r.upstream} → {r.downstream} «{r.pattern}»{r.why?.length ? <span className="hint"> · {r.why.join(", ")}</span> : null}</div>)}</dd></>}
        </dl>
        <Terms name={name} />
        {docs && <RuleList rules={rulesCiting(docs, where)} title="Rules about it" />}
        {docs && relations.length > 0 && <RuleList rules={relations.flatMap((r) => rulesCiting(docs, `relation ${r.upstream} → ${r.downstream}`))} title="Rules about its relations" />}
      </div>
    );
  }

  if (selection.kind === "flow") {
    const relations = (model.systems?.relations ?? []).filter((r) => (r.upstream === selection.from && r.downstream === selection.to) || (r.upstream === selection.to && r.downstream === selection.from));
    return (
      <div>
        <span className="kind-tag">what crosses between them</span>
        <h3>{selection.from} → {selection.to}</h3>
        {relations.map((r) => <p key={r.pattern}>«{r.pattern}» — {r.upstream} upstream, {r.downstream} downstream</p>)}
        {docs && <RuleList rules={relations.flatMap((r) => rulesCiting(docs, `relation ${r.upstream} → ${r.downstream}`))} title="Rules about the relation" />}
        {selection.events.length > 0 && <><h4>Events ({selection.events.length})</h4><ul>{selection.events.map((e) => <li key={e}><Link onClick={() => select({ kind: "message", event: e })}>◆ {e}</Link></li>)}</ul></>}
        {selection.commands.length > 0 && <><h4>Commands ({selection.commands.length})</h4><ul>{selection.commands.map((c) => <li key={c}><Link onClick={() => select({ kind: "message", command: c })}>▸ {c}</Link></li>)}</ul></>}
      </div>
    );
  }

  if (selection.kind === "type" || selection.kind === "package") {
    const m = selection.kind === "type" ? model.aggregates[selection.name] : undefined;
    return (
      <div>
        <span className="kind-tag">{selection.kind === "package" ? "package" : m ? m.role : "value object"}</span>
        <h3>{selection.name}</h3>
        {about(selection.kind === "type" ? { type: selection.name } : { pkg: selection.name })}
      </div>
    );
  }

  if (selection.kind === "transition") {
    const machine = model.aggregates[selection.machine] ?? model.policies[selection.machine];
    const t = machine && allTransitions(machine).find((x) => x.id === selection.id);
    if (!machine || !t) return <div className="hint">That transition is no longer in the model.</div>;
    const def = t.transition;
    const taken = past.filter((e) => (e.kind === "transition" || e.kind === "policy") && e.via === def.id);
    const refused = past.filter((e) => e.kind === "rejected" && e.chain.some((r) => r.transition === def.id));
    return (
      <div>
        <span className="kind-tag">{t.kind === "command" ? "command handler" : t.kind === "event" ? "policy reaction" : t.kind === "after" ? "deadline" : t.kind === "done" ? "completion" : "child quantifier"}</span>
        <h3>{t.name}</h3>
        <dl>
          <dt>declared on</dt><dd><Link onClick={() => select({ kind: "state", machine: machine.name, ref: t.ownerRef })}>{t.ownerRef}</Link>
            {t.ownerRef.includes(".") || Object.keys(machine.states[t.ownerRef]?.states ?? {}).length > 0
              ? <span className="hint"> — applies from every substate</span> : null}</dd>
          {def.inheritedFrom && <><dt>inherited</dt><dd>from <code>{def.inheritedFrom}</code> <span className="hint">— every subclass has it</span></dd></>}
          <dt>goes to</dt><dd>{def.target ? <code>{def.target}</code> : <span>stays put <span className="hint">(internal)</span></span>}</dd>
          {def.guard && <><dt>only if</dt><dd><code>{def.guard}</code></dd></>}
          {def.idempotency && <><dt>once per</dt><dd><code>{def.idempotency}</code> <span className="hint">— a repeat is recognised and logged</span></dd></>}
          {Object.keys(def.assign).length > 0 && <><dt>sets</dt><dd>{Object.entries(def.assign).map(([k, v]) => <div key={k}><code>{k} ← {v}</code></div>)}</dd></>}
          {def.emit.length > 0 && <><dt>raises</dt><dd>{def.emit.map((e, i) => <div key={i}><b style={{ color: "var(--event)" }}>◆ {e.event}</b> <Payload p={e.payload} /></div>)}</dd></>}
          {def.command && <><dt>commands</dt><dd><code>{def.command.target}</code> <Payload p={def.command.payload} />{def.forEach && <div className="hint">for each in <code>{def.forEach}</code></div>}</dd></>}
        </dl>
        <Why ids={def.why} />
        <h4>Taken so far ({taken.length})</h4>
        <History entries={taken} empty="Not taken yet in this run." />
        {refused.length > 0 && (<><h4>Refused so far ({refused.length})</h4><History entries={refused} empty="" /></>)}
      </div>
    );
  }

  if (selection.kind === "state") {
    const machine = model.aggregates[selection.machine] ?? model.policies[selection.machine];
    if (!machine) return null;
    const here = allTransitions(machine).filter((t) => t.ownerRef === selection.ref);
    const inside = Object.values(frame.instances).filter((i) => i.machine === machine.name &&
      i.config.some((p) => p.map((_, n) => refOf(p.slice(0, n + 1))).includes(selection.ref)));
    return (
      <div>
        <span className="kind-tag">state of {machine.name}</span>
        <h3>{selection.ref}</h3>
        <Why ids={stateAt(machine, selection.ref)?.why} />
        <h4>Handles here</h4>
        {here.length === 0 ? <div className="hint">Nothing declared on this state itself — commands bubble to its ancestors.</div> : (
          <ul>{here.map((t) => <li key={t.id}><Link onClick={() => select({ kind: "transition", machine: machine.name, id: t.id })}>{t.name}</Link>
            {t.transition.target ? <> → <code>{t.transition.target}</code></> : <span className="hint"> (internal)</span>}</li>)}</ul>
        )}
        <h4>In it now ({inside.length})</h4>
        {inside.length === 0 ? <div className="hint">No instance.</div> :
          <ul>{inside.map((i) => <li key={i.key}><Link onClick={() => select({ kind: "instance", key: i.key })}>{i.key}</Link></li>)}</ul>}
      </div>
    );
  }

  if (selection.kind === "instance") {
    const inst = frame.instances[selection.key];
    const history = past.filter((e) => "instance" in e && e.instance === selection.key && e.kind !== "event");
    if (!inst) {
      return <div><h3>{selection.key}</h3><div className="hint">Does not exist yet at this point in the run.</div>
        <History entries={run.world.log.filter((e) => "instance" in e && e.instance === selection.key).slice(0, 1)} empty="" /></div>;
    }
    const path = inst.config[0] ?? [];
    const children = Object.values(frame.instances).filter((c) => c.parent?.key === inst.key);
    const referrers = Object.values(frame.instances).filter((c) => Object.values(c.refs ?? {}).includes(inst.key));
    return (
      <div>
        <span className="kind-tag">{inst.kind} · {machineOfKey(inst.key)}</span>
        <h3>{inst.key}</h3>
        <h4>Active configuration</h4>
        <div className="mono">{path.map((seg, i) => <div key={i} style={{ paddingLeft: `${i}em` }}>{i === path.length - 1 ? <b>● {seg}</b> : `▾ ${seg}`}</div>)}</div>
        {Object.keys(inst.data).length > 0 && (<>
          <h4>Data</h4>
          <table><tbody>{Object.entries(inst.data).map(([k, v]) => <tr key={k}><td>{k}</td><td className="mono"><JsonValue v={v} /></td></tr>)}</tbody></table>
        </>)}
        {Object.keys(inst.refs ?? {}).length > 0 && (
          <dl>{Object.entries(inst.refs).map(([name, key]) => (
            <Fragment key={name}><dt>{name}</dt><dd>→ <Link onClick={() => select({ kind: "instance", key })}>{key}</Link>
              {!frame.instances[key] && <span className="hint"> (does not exist yet)</span>}</dd></Fragment>
          ))}</dl>
        )}
        {referrers.length > 0 && (<><h4>Pointed at by ({referrers.length})</h4>
          <ul>{referrers.map((r) => <li key={r.key}><Link onClick={() => select({ kind: "instance", key: r.key })}>{r.key}</Link> <span className="hint">{refOf(r.config[0] ?? [])}</span></li>)}</ul></>)}
        {inst.parent && <dl><dt>child of</dt><dd><Link onClick={() => select({ kind: "instance", key: inst.parent!.key })}>{inst.parent.key}</Link> via <code>{inst.parent.rel}</code></dd></dl>}
        {children.length > 0 && (<><h4>Children</h4>
          <ChildGrid model={model} frame={frame} parentKey={inst.key} selection={selection} select={select} /></>)}
        <h4>History so far</h4>
        <History entries={history} empty="Nothing yet." />
        {docs && <><h4>About {inst.machine}</h4>{about({ type: inst.machine, brief: true })}</>}
      </div>
    );
  }

  const entry = run.world.log.find((e) => e.seq === selection.seq);
  if (!entry) return null;
  const causes: LogEntry[] = [];
  for (let c = entry.cause; c > 0;) {
    const e = run.world.log.find((x) => x.seq === c);
    if (!e || causes.includes(e)) break;
    causes.unshift(e);
    c = e.cause;
  }
  const effects = run.world.log.filter((e) => e.cause === entry.seq);
  // Who sent the input this came from (ADR 0020 §4), and the role it played (ADR 0027 §3).
  const root = causes[0] ?? entry;
  const rootType = root.kind === "command" ? root.instance.slice(0, root.instance.indexOf("#")) : "";
  const sender = root.kind === "command" ? senderOfCommand(model, rootType, root.name, root.payload) : undefined;
  const role = root.kind === "command" ? roleOfCommand(model, rootType, root.name, root.payload) : undefined;
  return (
    <div>
      <span className="kind-tag">log entry #{entry.seq} · {entry.kind}</span>
      {/* A command or event's payload is shown below, indented: the heading names it only. */}
      <h3>{GLYPH[entry.kind]} {entry.kind === "command" ? `${entry.instance} ← ${entry.name}${entry.redelivery ? "  [redelivered]" : ""}`
        : entry.kind === "event" ? `${entry.instance} raised ${entry.event}` : describe(entry)}</h3>
      {"instance" in entry && entry.instance && (
        <dl><dt>instance</dt><dd><Link onClick={() => select({ kind: "instance", key: entry.instance! })}>{entry.instance}</Link></dd></dl>
      )}
      {(sender || role) && (
        <dl><dt>sent by</dt><dd>{sender ? sender.name : "a part"}{role ? <> as <b title={role.note ?? `role ${role.name} (ADR 0027)`}>{role.name}</b> — works {role.works.join(", ") || "nothing"}</> : null}</dd></dl>
      )}
      {"payload" in entry && entry.payload && Object.keys(entry.payload).length > 0 && (<>
        <h4>Payload</h4>
        <pre className="json">{JSON.stringify(entry.payload, null, 2)}</pre>
      </>)}
      {entry.kind === "rejected" && (<>
        <h4>Why nothing happened</h4>
        <p className="hint">The command bubbled outward through the active configuration; every candidate's guard was false.</p>
        <table>
          <thead><tr><th>state</th><th>wanted</th><th>saw</th></tr></thead>
          <tbody>{entry.chain.map((r, i) => (
            <tr key={i}><td className="mono">{r.state}</td><td className="mono">{r.guard}</td>
              <td className="mono">{r.error ? <span style={{ color: "var(--error)" }}>{r.error}</span> : r.values}</td></tr>
          ))}</tbody>
        </table>
      </>)}
      {entry.kind === "unhandled" && <><h4>Why nothing happened</h4><p>{entry.reason}</p></>}
      {(entry.kind === "transition" || entry.kind === "policy") && (
        <dl><dt>won by</dt><dd><Link onClick={() => select({ kind: "transition", machine: machineOfKey(entry.instance), id: entry.via })}>{entry.via}</Link></dd></dl>
      )}
      <h4>Because of</h4>
      {causes.length === 0 ? <div className="hint">Something a person did.</div> : <History entries={causes} empty="" />}
      <h4>Led to</h4>
      <History entries={effects} empty="Nothing directly." />
    </div>
  );
}

function Link({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return <a href="#" onClick={(e) => { e.preventDefault(); onClick(); }}>{children}</a>;
}

/** A rule's payload template: a short one on its line, a longer one as an indented block. */
function Payload({ p }: { p: Record<string, Json> }) {
  const keys = Object.keys(p);
  if (keys.length === 0) return null;
  const line = `{ ${keys.map((k) => `${k}: ${JSON.stringify(p[k])}`).join(", ")} }`;
  return line.length <= 60 ? <code className="hint">{line}</code> : <pre className="json">{JSON.stringify(p, null, 2)}</pre>;
}

/** A data value: a string, number or flag as it is; a list or a record as indented JSON, for reading. */
function JsonValue({ v }: { v: Json }) {
  if (v === null || typeof v !== "object") return <>{JSON.stringify(v)}</>;
  if (Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0) return <>{JSON.stringify(v)}</>;
  return <pre className="json">{JSON.stringify(v, null, 2)}</pre>;
}
