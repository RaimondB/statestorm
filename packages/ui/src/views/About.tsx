import type { Model } from "@statestorm/kernel";
import { rulesAbout, rulesOfPackage, termsFor, topicsFor, topicsOfPackage, type DocsData } from "../docs-links.ts";
import type { DocPlace } from "./Docs.tsx";

/**
 * What a type or a package is, from the domain's docs (ADR 0016 §9): the glossary's words for it, the
 * topics it is in, and the rules cited on it — each a link into the Docs view. Shown in the inspector,
 * which the reader can fold away.
 */
export function About({ model, type, pkg, docs, onRule, onDoc, onPackage, brief }: {
  model: Model; type?: string; pkg?: string; docs?: DocsData;
  onRule: (id: string) => void; onDoc: (p: DocPlace) => void; onPackage: (name: string) => void;
  /** Beside something else (an instance): the rules folded away, under their count. */
  brief?: boolean;
}) {
  const m = type ? model.aggregates[type] : undefined;
  const home = type ? docs?.packageOf.get(type) : undefined;
  const note = pkg ? model.packages.find((p) => p.name === pkg)?.note : undefined;
  const terms = docs && type ? termsFor(docs, type) : [];
  const topics = docs ? (type ? topicsFor(docs, type) : topicsOfPackage(docs, pkg!)) : [];
  const rules = docs ? (type ? rulesAbout(docs, type) : rulesOfPackage(docs, pkg!)) : [];
  return (
    <div className="about-docs" aria-label={`About ${type ?? `package ${pkg}`}`}>
      <div className="about-docs-head">
        {/* Its name and kind are the inspector's heading; here, where it sits. */}
        {m?.abstract && <span className="hint">abstract · </span>}
        {home && <>in <a onClick={() => onPackage(home)}>package {home}</a></>}
        {topics.length > 0 && <>{home ? " · " : ""}topic {topics.map((tp, i) => <span key={tp.file}>{i ? ", " : ""}<a onClick={() => onDoc({ page: `topic:${tp.file}` })}>{tp.title}</a></span>)}</>}
      </div>
      {note && <p>{note}</p>}
      {terms.map((term) => (
        <p key={term.term}><a onClick={() => onDoc({ page: "glossary", at: term.term })}><b>{term.term}</b></a> — {term.definition}</p>
      ))}
      {!docs ? <p className="hint">This domain has no docs/ — no rules to show.</p>
        : rules.length === 0 ? <p className="hint">No rule is cited on {type ? "it" : "it or its types"}.</p> : (() => {
          const list = (
            <ul className="erd-about-rules">
              {rules.map((r) => (
                <li key={r.id}><a className={`doc-id ${r.status}`} onClick={() => onRule(r.id)}>{r.id}</a> {r.title}
                  {r.status !== "agreed" && <span className={`doc-status ${r.status}`}>{r.status}</span>}</li>
              ))}
            </ul>
          );
          return brief ? <details><summary>{rules.length} rule{rules.length === 1 ? "" : "s"} cited on {type ?? pkg}</summary>{list}</details> : <><h4>Rules ({rules.length})</h4>{list}</>;
        })()}
    </div>
  );
}
