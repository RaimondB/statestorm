/**
 * Asking the docs instead of reading them (ADR 0016 §11): every rule on a line, one id with
 * everything that cites it, one topic with what the model derives for it, and what waits on the
 * domain owner — as text for a reader, or `--json` for a tool. Small enough for an agent's context.
 */
import type { Model } from "@statestorm/kernel";
import { packageTypes } from "../boundaries.ts";
import type { Docs, Question, Rule, Trace } from "./docs.ts";
import { derived } from "./rulebook.ts";

export type Query = { kind: "index" } | { kind: "id"; id: string } | { kind: "topic"; topic: string } | { kind: "open" };
export interface Answer { text: string; json: unknown; found: boolean }

const PAST = { refines: "refined", revises: "revised", supersedes: "superseded" } as const;
const list = (xs: string[] | undefined) => (xs?.length ? xs.join(", ") : "—");

export function query(docs: Docs, model: Model, t: Trace, q: Query): Answer {
  const rules = docs.topics.flatMap((tp) => tp.rules);
  const cites = (id: string) => t.cited.get(id) ?? { model: [], scenarios: [], issues: [], comments: [] };
  const counts = (id: string) => { const c = cites(id); return `model ${c.model.length} · scenarios ${c.scenarios.length}`; };
  const extras = (o: Record<string, unknown>, fields: Record<string, unknown> | undefined) =>
    Object.fromEntries(Object.keys(fields ?? {}).filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
  const ruleJson = (r: Rule) => ({
    id: r.id, topic: r.topic, title: r.title, kind: r.kind, status: r.status, text: r.text.trim(),
    ...(r.table ? { table: r.table } : {}),
    ...Object.fromEntries((["refines", "revises", "supersedes"] as const).filter((h) => r[h]?.length).map((h) => [h, r[h]])),
    ...(r.decided ? { decided: r.decided } : {}), ...(r.untraced ? { untraced: r.untraced } : {}),
    ...extras(r, docs.profile.fields?.rule),
    since: t.changedBy.get(r.id) ?? [],
    cited: cites(r.id),
    openQuestions: docs.questions.filter((x) => x.status === "open" && x.about?.includes(r.id)).map((x) => x.id),
  });
  const questionJson = (x: Question) => ({ ...x, cited: cites(x.id) });

  if (q.kind === "index") {
    const by = (s: string) => rules.filter((r) => r.status === s).length;
    const open = docs.questions.filter((x) => x.status === "open").length;
    const width = Math.max(0, ...rules.map((r) => r.id.length));
    const lines = [
      `${rules.length} rules in ${docs.topics.length} topics: ${by("agreed")} agreed, ${by("to-confirm")} to confirm, ${by("deferred")} deferred, ${by("superseded")} superseded · ${open} open question${open === 1 ? "" : "s"}`,
    ];
    for (const tp of docs.topics) {
      lines.push("", `${tp.file} — ${tp.title}`);
      for (const r of tp.rules) lines.push(`  ${r.id.padEnd(width)}  ${r.status.padEnd(10)}  ${r.title}  (${counts(r.id)})`);
    }
    const json = docs.topics.map((tp) => ({ topic: tp.file, title: tp.title, rules: tp.rules.map((r) => ({ id: r.id, status: r.status, title: r.title, model: cites(r.id).model.length, scenarios: cites(r.id).scenarios.length })) }));
    return { text: lines.join("\n"), json, found: true };
  }

  if (q.kind === "id") {
    const what = t.ids.get(q.id);
    if (what?.rule) {
      const r = what.rule;
      const c = cites(r.id);
      const j = ruleJson(r);
      const lines = [
        `${r.id} — ${r.title}`,
        [r.status, r.kind, `topic ${r.topic}`,
          r.decided && `decided ${r.decided.session !== undefined ? `in session ${r.decided.session}, ` : ""}${r.decided.date}${r.decided.questions?.length ? `, answering ${r.decided.questions.join(", ")}` : ""}`,
          ...(["refines", "revises", "supersedes"] as const).filter((h) => r[h]?.length).map((h) => `${h} ${r[h]!.join(", ")}`)].filter(Boolean).join(" · "),
        ...Object.entries(extras(r, docs.profile.fields?.rule)).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`),
        "",
        r.text.trim(),
        ...(r.table ? ["", r.table.columns.join(" | "), ...r.table.rows.map((row) => row.join(" | "))] : []),
        "",
        `since:      ${list(j.since.map((s) => `${PAST[s.how]} by ${s.by}`))}`,
        `model:      ${list(c.model)}`,
        `scenarios:  ${list(c.scenarios)}`,
        `issues:     ${list(c.issues)}`,
        ...(c.comments.length ? [`comments:   model lines ${c.comments.join(", ")}`] : []),
        ...(j.openQuestions.length ? [`questions:  ${j.openQuestions.join(", ")} (open)`] : []),
        ...(r.untraced ? [`untraced:   ${r.untraced}`] : []),
      ];
      return { text: lines.join("\n"), json: j, found: true };
    }
    if (what?.question) {
      const x = what.question;
      const c = cites(x.id);
      const lines = [
        `${x.id} — ${x.question}`,
        `${x.status} · asked ${x.asked.session !== undefined ? `in session ${x.asked.session}, ` : ""}${x.asked.date}`,
        `leaning:    ${x.leaning}`,
        ...(x.options ?? []).map((o) => `option:     ${o.option} — ${o.consequence}`),
        `about:      ${list(x.about)}`,
        ...(x.answer ? [`answer:     ${x.answer}`, `recorded:   ${list(x.answeredBy)}`] : []),
        `cited by:   ${list([...c.model, ...c.scenarios, ...c.issues])}`,
      ];
      return { text: lines.join("\n"), json: questionJson(x), found: true };
    }
    if (what?.kind === "issue") {
      const rulesCiting = [...t.cited].filter(([, c]) => c.issues.includes(q.id)).map(([id]) => id);
      const c = cites(q.id);
      return {
        text: [`${q.id} — a drawing issue (drawings/issues.yaml; \`check --issues\` prints them)`, `names:      ${list(rulesCiting)}`, `cited by:   ${list([...c.model, ...c.scenarios])}`].join("\n"),
        json: { id: q.id, kind: "issue", names: rulesCiting, cited: c }, found: true,
      };
    }
    return { text: `no rule, question or drawing issue has the id ${q.id}`, json: null, found: false };
  }

  if (q.kind === "topic") {
    const tp = docs.topics.find((x) => x.file === q.topic);
    if (!tp) return { text: `no topic ${q.topic} — the topics are ${docs.topics.map((x) => x.file).join(", ")}`, json: null, found: false };
    const d = derived(model, packageTypes(model), tp);
    const lines = [
      `${tp.file} — ${tp.title}`,
      ...(tp.canvas?.purpose ? [tp.canvas.purpose.trim()] : []),
      "",
      `types:      ${list(d.types)}`,
      `commands:   ${list(d.commands)}`,
      `events:     ${list(d.events)}`,
      `policies:   ${list(d.policies.map((p) => `${p.name} (on ${p.on.join(", ")})`))}`,
      "",
      ...tp.rules.flatMap((r) => [`${r.id} — ${r.title}  [${r.status} · ${counts(r.id)}]`, `  ${r.text.trim().replace(/\s*\n\s*/g, " ")}`]),
    ];
    return { text: lines.join("\n"), json: { topic: tp.file, title: tp.title, canvas: tp.canvas ?? {}, derived: d, rules: tp.rules.map(ruleJson) }, found: true };
  }

  // What waits on the owner: rules built on a leaning, and the questions still open.
  const confirm = rules.filter((r) => r.status === "to-confirm");
  const open = docs.questions.filter((x) => x.status === "open");
  const lines = [`${confirm.length} rule${confirm.length === 1 ? "" : "s"} to confirm, ${open.length} open question${open.length === 1 ? "" : "s"}`];
  for (const r of confirm) {
    const c = cites(r.id);
    lines.push("", `${r.id} — ${r.title}  [to confirm, ${r.topic}]`, `  ${r.text.trim().replace(/\s*\n\s*/g, " ")}`, `  built in: ${list([...c.model, ...c.scenarios])}`);
  }
  for (const x of open) {
    const c = cites(x.id);
    lines.push("", `${x.id} — ${x.question}  [open]`, `  leaning: ${x.leaning}`, `  about: ${list(x.about)} · cited by: ${list([...c.model, ...c.scenarios, ...c.issues])}`);
  }
  return { text: lines.join("\n"), json: { toConfirm: confirm.map(ruleJson), open: open.map(questionJson) }, found: true };
}
