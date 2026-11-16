import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Model } from "@statestorm/kernel";
import type { Question, Rule, Term, Topic } from "../check/docs-core.ts";
import { targetOf, topicTypes, type DocsData, type Target } from "../docs-links.ts";

/** Where the reader is in the docs: a page, and the rule, question or term on it. It travels in the link. */
export interface DocPlace {
  /** `index`, `topic:<file>`, `glossary`, `questions`, `session:<n>`. */
  page: string;
  /** A rule's or question's id, a term — scrolled to and marked. */
  at?: string;
}

/** Where a link in the docs goes: elsewhere in the workbench. */
export interface DocLinks {
  /** A rule, a question or a session, here in the docs. */
  place: (p: DocPlace) => void;
  /** A citation's target: a type or a package in the structure, a state or rule in its statechart. */
  target: (t: Target) => void;
  scenario: (file: string) => void;
}

interface Props {
  model: Model;
  data: DocsData;
  place: DocPlace;
  links: DocLinks;
  /** The scenarios that can be opened, by file name without `.yaml`. */
  scenarios: Set<string>;
}

const STATUS: Record<Rule["status"], string> = { agreed: "agreed", "to-confirm": "to confirm", deferred: "deferred", superseded: "superseded" };

/**
 * The domain's docs (ADR 0016 §9): every topic with its purpose and its rules, the glossary, the
 * questions and the sessions' logs — read from docs/, as the rulebook is. A rule says what in the
 * model and which scenarios cite it, and each is a link: a type or a package opens the structure
 * on it, a state or a rule its statechart, a scenario runs. The structure and the inspector link
 * back here.
 */
export function Docs({ model, data, place, links, scenarios }: Props) {
  const { docs, t } = data;
  const [query, setQuery] = useState("");
  const article = useRef<HTMLElement>(null);
  const topicOf = useMemo(() => new Map(docs.topics.flatMap((tp) => tp.rules.map((r) => [r.id, tp.file] as const))), [docs]);
  const open = docs.questions.filter((q) => q.status === "open");
  const toConfirm = [...data.rules.values()].filter((r) => r.status === "to-confirm");
  const sessions = [...docs.sessions].sort((a, b) => b[0] - a[0]);

  /** Go to an id: a rule on its topic's page, a question on the questions'. */
  const goId = (id: string) => {
    const kind = t.ids.get(id)?.kind;
    if (kind === "rule") links.place({ page: `topic:${topicOf.get(id)}`, at: id });
    else if (kind === "question") links.place({ page: "questions", at: id });
  };
  const Id = ({ id }: { id: string }) => {
    const known = t.ids.get(id);
    if (!known || known.kind === "issue") return <code className="doc-id plain">{id}</code>;
    const title = known.rule?.title ?? known.question?.question ?? "";
    const status = known.rule?.status ?? known.question?.status;
    return <a className={`doc-id ${status ?? ""}`} title={`${id} — ${title}`} onClick={() => goId(id)}>{id}</a>;
  };
  /** Prose with the ids it names made links. */
  const Prose = ({ text }: { text: string }) => {
    const parts = text.split(/(\b[A-Z][A-Za-z]*-?\d+[a-z]?\b)/g);
    return <>{parts.map((p, i) => (i % 2 === 1 && t.ids.has(p) ? <Id key={i} id={p} /> : <Fragment key={i}>{p}</Fragment>))}</>;
  };
  const Chip = ({ where }: { where: string }) => {
    const target = targetOf(model, where);
    if (target.kind === "none") return <span className="doc-chip plain">{where}</span>;
    const what = target.kind === "type" ? "the structure, around it" : target.kind === "package" ? "the structure, its package" : "its statechart";
    return <a className={`doc-chip ${target.kind}`} title={`${where} — open ${what}`} onClick={() => links.target(target)}>{where}</a>;
  };

  // The marked rule, question or term in view when the place changes.
  useEffect(() => {
    const el = place.at ? article.current?.querySelector(`[data-doc="${CSS.escape(place.at)}"]`) : undefined;
    if (el) el.scrollIntoView({ block: "start" });
    else article.current?.scrollTo({ top: 0 });
  }, [place]);

  const RuleCard = ({ r }: { r: Rule }) => {
    const cited = t.cited.get(r.id);
    const since = t.changedBy.get(r.id) ?? [];
    const extra = Object.entries(docs.profile.fields?.rule ?? {}).filter(([k]) => r[k] !== undefined);
    return (
      <section className={`doc-rule ${r.status}${place.at === r.id ? " marked" : ""}`} data-doc={r.id}>
        <header>
          <code className="doc-rule-id">{r.id}</code>
          <h4>{r.title}</h4>
          <span className={`doc-status ${r.status}`}>{STATUS[r.status]}</span>
          <span className="doc-kind">{r.kind}</span>
        </header>
        <div className="doc-text">{r.text.split(/\n\s*\n/).map((para, i) => <p key={i}><Inline text={para} Prose={Prose} /></p>)}</div>
        {r.table && (
          <table className="doc-table">
            <thead><tr>{r.table.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>{r.table.rows.map((row, i) => <tr key={i}>{row.map((v, j) => <td key={j}>{String(v)}</td>)}</tr>)}</tbody>
          </table>
        )}
        <dl className="doc-meta">
          {r.decided && <><dt>decided</dt><dd>
            {r.decided.session !== undefined && docs.sessions.has(r.decided.session)
              ? <a onClick={() => links.place({ page: `session:${r.decided!.session}` })}>session {r.decided.session}</a>
              : r.decided.session !== undefined ? `session ${r.decided.session}` : null}
            {r.decided.date ? `, ${r.decided.date}` : ""}
            {r.decided.questions?.length ? <>, answering {r.decided.questions.map((q, i) => <Fragment key={q}>{i ? ", " : ""}<Id id={q} /></Fragment>)}</> : null}
          </dd></>}
          {(["refines", "revises", "supersedes"] as const).map((how) => r[how]?.length ? (
            <Fragment key={how}><dt>{how}</dt><dd>{r[how]!.map((id, i) => <Fragment key={id}>{i ? ", " : ""}<Id id={id} /></Fragment>)}</dd></Fragment>
          ) : null)}
          {since.length > 0 && <><dt>since</dt><dd>{since.map((s, i) => <Fragment key={s.by}>{i ? ", " : ""}{s.how === "refines" ? "refined" : s.how === "revises" ? "revised" : "superseded"} by <Id id={s.by} /></Fragment>)}</dd></>}
          {extra.map(([k]) => <Fragment key={k}><dt>{k}</dt><dd>{Array.isArray(r[k]) ? (r[k] as unknown[]).join(", ") : String(r[k])}</dd></Fragment>)}
          <dt>in the model</dt><dd>{cited?.model.length ? cited.model.map((w) => <Chip key={w} where={w} />) : <span className="hint">{r.untraced ? `untraced: ${r.untraced}` : "nothing cites it"}</span>}</dd>
          <dt>scenarios</dt><dd>{cited?.scenarios.length ? cited.scenarios.map((s) => scenarios.has(s)
            ? <a key={s} className="doc-chip scenario" title={`run ${s}`} onClick={() => links.scenario(s)}>{s}</a>
            : <span key={s} className="doc-chip plain">{s}</span>) : <span className="hint">none</span>}</dd>
          {cited?.issues.length ? <><dt>drawing issues</dt><dd>{cited.issues.map((i) => <span key={i} className="doc-chip plain">{i}</span>)}</dd></> : null}
        </dl>
      </section>
    );
  };

  const TopicPage = ({ topic }: { topic: Topic }) => {
    const types = topicTypes(data, topic);
    return (
      <>
        <h2>{topic.title}</h2>
        {topic.canvas?.purpose && <p className="doc-purpose"><Prose text={topic.canvas.purpose} /></p>}
        {(topic.canvas?.packages?.length || types.length) ? (
          <dl className="doc-meta">
            {topic.canvas?.packages?.length ? <><dt>packages</dt><dd>{topic.canvas.packages.map((p) => <Chip key={p} where={`package ${p}`} />)}</dd></> : null}
            {types.length ? <><dt>types</dt><dd>{types.map((ty) => <Chip key={ty} where={ty} />)}</dd></> : null}
          </dl>
        ) : null}
        {topic.rules.map((r) => <RuleCard key={r.id} r={r} />)}
      </>
    );
  };

  const TermCard = ({ term }: { term: Term }) => (
    <section className={`doc-term${place.at === term.term ? " marked" : ""}`} data-doc={term.term}>
      <h4>{term.term}{term.aka?.length ? <span className="hint"> · also {term.aka.join(", ")}</span> : null}</h4>
      <p><Prose text={term.definition} /></p>
      {term.avoid?.length ? <p className="hint">Avoid: {term.avoid.map((a) => `“${a.word}” — ${a.why}`).join("; ")}</p> : null}
      {term.model?.length ? <div>{term.model.map((m) => <Chip key={m} where={m} />)}</div> : null}
    </section>
  );

  const QuestionCard = ({ q }: { q: Question }) => (
    <section className={`doc-rule question ${q.status}${place.at === q.id ? " marked" : ""}`} data-doc={q.id}>
      <header><code className="doc-rule-id">{q.id}</code><h4><Prose text={q.question} /></h4><span className={`doc-status ${q.status}`}>{q.status}</span></header>
      <p><b>Leaning:</b> <Prose text={q.leaning} /></p>
      {q.options?.length ? <ul>{q.options.map((o) => <li key={o.option}><b>{o.option}</b> — <Prose text={o.consequence} /></li>)}</ul> : null}
      {q.answer && <p><b>Answer:</b> <Prose text={q.answer} /></p>}
      <dl className="doc-meta">
        <dt>asked</dt><dd>{q.asked.session !== undefined && docs.sessions.has(q.asked.session)
          ? <a onClick={() => links.place({ page: `session:${q.asked.session}` })}>session {q.asked.session}</a> : q.asked.session !== undefined ? `session ${q.asked.session}` : ""}{q.asked.date ? `, ${q.asked.date}` : ""}</dd>
        {q.answeredBy?.length ? <><dt>answered by</dt><dd>{q.answeredBy.map((id, i) => <Fragment key={id}>{i ? ", " : ""}<Id id={id} /></Fragment>)}</dd></> : null}
        {q.about?.length ? <><dt>about</dt><dd>{q.about.map((a) => (t.ids.has(a) ? <Id key={a} id={a} /> : <Chip key={a} where={a} />))}</dd></> : null}
      </dl>
    </section>
  );

  const found = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return undefined;
    return [...data.rules.values()].filter((r) => `${r.id} ${r.title} ${r.text}`.toLowerCase().includes(q));
  }, [query, data]);

  const page = (() => {
    if (found) return (
      <>
        <h2>{found.length} rule{found.length === 1 ? "" : "s"} with “{query.trim()}”</h2>
        {found.map((r) => <RuleCard key={r.id} r={r} />)}
      </>
    );
    if (place.page.startsWith("topic:")) {
      const topic = docs.topics.find((tp) => tp.file === place.page.slice("topic:".length));
      if (topic) return <TopicPage topic={topic} />;
    }
    if (place.page === "glossary") return (
      <>
        <h2>Glossary</h2>
        {[...(docs.glossary ?? [])].sort((a, b) => a.term.localeCompare(b.term)).map((term) => <TermCard key={term.term} term={term} />)}
      </>
    );
    if (place.page === "questions") return (
      <>
        <h2>Questions</h2>
        <h3>Open ({open.length})</h3>
        {open.map((q) => <QuestionCard key={q.id} q={q} />)}
        <h3>Answered or withdrawn</h3>
        {docs.questions.filter((q) => q.status !== "open").map((q) => <QuestionCard key={q.id} q={q} />)}
      </>
    );
    if (place.page.startsWith("session:")) {
      const file = docs.sessions.get(Number(place.page.slice("session:".length)));
      if (file) return <><p className="hint">docs/decisions/{file}</p><Markdown text={docs.logs[file] ?? ""} Prose={Prose} /></>;
    }
    return (
      <>
        <h2>{model.context}: the domain's decisions</h2>
        <p className="hint">{data.rules.size} rules in {docs.topics.length} topics · {docs.glossary?.length ?? 0} terms · {docs.questions.length} questions · {docs.sessions.size} sessions</p>
        {(toConfirm.length > 0 || open.length > 0) && (
          <section className="doc-waiting">
            <h3>Waiting on the owner</h3>
            {toConfirm.length > 0 && <p>To confirm: {toConfirm.map((r, i) => <Fragment key={r.id}>{i ? ", " : ""}<Id id={r.id} /></Fragment>)}</p>}
            {open.length > 0 && <p>Open questions: {open.map((q, i) => <Fragment key={q.id}>{i ? ", " : ""}<Id id={q.id} /></Fragment>)}</p>}
          </section>
        )}
        {docs.topics.map((tp) => (
          <section key={tp.file} className="doc-topic-line">
            <h3><a onClick={() => links.place({ page: `topic:${tp.file}` })}>{tp.title}</a> <span className="hint">· {tp.rules.length} rule{tp.rules.length === 1 ? "" : "s"}</span></h3>
            {tp.canvas?.purpose && <p><Prose text={tp.canvas.purpose} /></p>}
            {tp.canvas?.packages?.length ? <div>{tp.canvas.packages.map((p) => <Chip key={p} where={`package ${p}`} />)}</div> : null}
          </section>
        ))}
      </>
    );
  })();

  const Nav = ({ to, children, count }: { to: string; children: ReactNode; count?: number }) => (
    <li className={place.page === to && !found ? "active" : ""}><a onClick={() => { setQuery(""); links.place({ page: to }); }}>{children}</a>{count !== undefined && <span className="hint"> {count}</span>}</li>
  );

  return (
    <div className="ov docs">
      <div className="ov-head">
        <input className="doc-search" type="search" placeholder="search the rules: an id, a word…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the rules" />
        <span className="hint">{data.rules.size} rule{data.rules.size === 1 ? "" : "s"} · {open.length} open question{open.length === 1 ? "" : "s"}{t.findings.some((f) => f.severity === "error") ? " · the docs check has errors (statestorm check --docs)" : ""}</span>
      </div>
      <div className="doc-body">
        <nav className="doc-nav" aria-label="The docs">
          <ul>
            <Nav to="index">Overview</Nav>
            <li className="doc-nav-head">Topics</li>
            {docs.topics.map((tp) => <Nav key={tp.file} to={`topic:${tp.file}`} count={tp.rules.length}>{tp.title}</Nav>)}
            <li className="doc-nav-head">Reference</li>
            {docs.glossary && <Nav to="glossary" count={docs.glossary.length}>Glossary</Nav>}
            <Nav to="questions" count={open.length}>Questions</Nav>
            {sessions.length > 0 && <li className="doc-nav-head">Sessions</li>}
            {sessions.map(([n, f]) => <Nav key={n} to={`session:${n}`}><span title={f}>{n} · {f.replace(/^\d+-\d{4}-\d{2}-\d{2}-/, "").replace(/\.md$/, "").replace(/-/g, " ")}</span></Nav>)}
          </ul>
        </nav>
        <article className="doc-page" ref={article}>{page}</article>
      </div>
    </div>
  );
}

/** `code`, **bold** and *emphasis*; the rest is prose, its ids links. */
function Inline({ text, Prose }: { text: string; Prose: (p: { text: string }) => ReactNode }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g);
  return <>{parts.map((p, i) => {
    if (i % 2 === 0) return <Prose key={i} text={p} />;
    if (p.startsWith("`")) return <code key={i}>{p.slice(1, -1)}</code>;
    if (p.startsWith("**")) return <b key={i}><Prose text={p.slice(2, -2)} /></b>;
    return <em key={i}><Prose text={p.slice(1, -1)} /></em>;
  })}</>;
}

/** A session's log: headings, lists, quotes, code blocks and paragraphs — enough Markdown for what we write. */
function Markdown({ text, Prose }: { text: string; Prose: (p: { text: string }) => ReactNode }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    if (line.startsWith("```")) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith("```"); i++) code.push(lines[i]!);
      i++;
      blocks.push(<pre key={i}>{code.join("\n")}</pre>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { const H = `h${Math.min(4, h[1]!.length + 1)}` as "h2"; blocks.push(<H key={i}><Inline text={h[2]!} Prose={Prose} /></H>); i++; continue; }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && lines[i]!.trim() && (/^\s*([-*]|\d+\.)\s+/.test(lines[i]!) || /^\s{2,}\S/.test(lines[i]!))) {
        if (/^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) items.push(lines[i]!.replace(/^\s*([-*]|\d+\.)\s+/, ""));
        else items[items.length - 1] += ` ${lines[i]!.trim()}`;
        i++;
      }
      const L = ordered ? "ol" : "ul";
      blocks.push(<L key={i}>{items.map((it, k) => <li key={k}><Inline text={it} Prose={Prose} /></li>)}</L>);
      continue;
    }
    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) quote.push(lines[i++]!.replace(/^>\s?/, ""));
      blocks.push(<blockquote key={i}><Inline text={quote.join(" ")} Prose={Prose} /></blockquote>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,4}\s|```|>|\s*([-*]|\d+\.)\s+)/.test(lines[i]!)) para.push(lines[i++]!);
    blocks.push(<p key={i}><Inline text={para.join(" ")} Prose={Prose} /></p>);
  }
  return <div className="doc-md">{blocks}</div>;
}
