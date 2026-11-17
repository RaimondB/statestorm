import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadModel, type Model, type Schedule } from "@statestorm/kernel";
import { parseScenario, runScenario, type Result } from "@statestorm/scenarios";
import { domainFromFiles, setupsOf, type View } from "./domain.ts";
import { EXAMPLES, servedDomains, showExamples, type Example } from "./examples.ts";
import { pickDomainFolder } from "./openFolder.ts";
import { actionsOf, continueFrom, DEFAULT_START, machineOfKey, play, type Action } from "./session.ts";
import type { Selection } from "./selection.ts";
import { Fire } from "./views/Fire.tsx";
import { WorldPanel } from "./views/WorldPanel.tsx";
import { Statechart } from "./views/Statechart.tsx";
import { Timeline } from "./views/Timeline.tsx";
import { Trace } from "./views/Trace.tsx";
import { Inspector } from "./views/Inspector.tsx";
import { ModelEditor } from "./views/ModelEditor.tsx";
import { Overview } from "./views/Overview.tsx";
import { overviewConfig, visibleStep, withEventsMode, type EventsMode } from "./overview.ts";
import { Splitter } from "./views/Splitter.tsx";
import { Flow } from "./views/Flow.tsx";
import { Structure } from "./views/Structure.tsx";
import { ContextMap } from "./views/ContextMap.tsx";
import { Sequence, type SequenceState } from "./views/Sequence.tsx";
import { Docs, type DocLinks, type DocPlace } from "./views/Docs.tsx";
import { Journey } from "./views/Journey.tsx";
import { docsFromFiles, trace } from "./check/docs-core.ts";
import { docsData, type Target } from "./docs-links.ts";
import { assignScenarios, parseDrawing, parseIssues } from "./check/drawings.ts";
import { ScenarioPicker } from "./views/ScenarioPicker.tsx";
import { AgendaBar } from "./views/AgendaBar.tsx";
import { parseAgenda, stepsOf, type Agenda } from "./agenda.ts";
import { referencesOf, scenarioGroups, tagGroups, tagMatches } from "./groups.ts";

const NO_SCENARIOS: { file: string; text: string }[] = [];
import { DEFAULT_LAYOUT, resize, restore, toggle, type Layout, type Panel } from "./layout.ts";

type Loaded = { model: Model; error?: undefined } | { model?: undefined; error: string };

function load(text: string, parts: Record<string, string>): Loaded {
  try {
    return { model: loadModel(text, parts) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** The model and scenario chosen last, so a reload comes back to them (this browser only). */
type Choice = { example: string; scenario?: string };
function readChoice(): Choice | undefined {
  try {
    const v = JSON.parse(localStorage.getItem("statestorm.choice") ?? "null") as Choice | null;
    return v && typeof v.example === "string" ? v : undefined;   // a served or opened domain is checked once it is there
  } catch { return undefined; }
}
function saveChoice(c: Choice) {
  try { localStorage.setItem("statestorm.choice", JSON.stringify(c)); } catch { /* private mode: fine */ }
}
/**
 * A link to a view (ADR 0022 §8): `#model=…&scenario=…&view=…`, and for the sequence what is open
 * (`open=`), what is unfolded (`toggled=`) and whether ignored commands show (`ignored=1`). It wins
 * over what this browser remembers; the address is kept current as the reader moves.
 */
type Link = { choice?: Choice; view?: View; sequence?: Partial<SequenceState>; doc?: DocPlace; focus?: string; events?: EventsMode; lines?: string[];
  /** An agenda (ADR 0025) and the step of it shown. */
  agenda?: { name: string; step: number } };
function readLink(): Link {
  try {
    const q = new URLSearchParams(window.location.hash.slice(1));
    const list = (k: string) => (q.has(k) ? q.get(k)!.split(",").filter(Boolean) : undefined);
    const model = q.get("model");
    const open = list("open");
    const toggled = list("toggled");
    return {
      ...(model ? { choice: { example: model, ...(q.get("scenario") ? { scenario: q.get("scenario")! } : {}) } } : {}),
      ...(q.get("view") ? { view: q.get("view") as View } : {}),
      sequence: { ...(open ? { open } : {}), ...(toggled ? { toggled } : {}), ...(q.get("ignored") === "1" ? { ignored: true } : {}) },
      ...(q.get("doc") ? { doc: { page: q.get("doc")!, ...(q.get("at") ? { at: q.get("at")! } : {}) } } : {}),
      ...(q.get("focus") ? { focus: q.get("focus")! } : {}),
      ...(["statuses", "requests", "all"].includes(q.get("events") ?? "") ? { events: q.get("events") as EventsMode } : {}),
      ...(q.get("lines") ? { lines: q.get("lines")!.split(",").filter(Boolean) } : {}),
      ...(q.get("agenda") ? { agenda: { name: q.get("agenda")!, step: Math.max(0, Number(q.get("step") ?? 1) - 1) || 0 } } : {}),
    };
  } catch { return {}; }
}
const link = readLink();
const remembered = link.choice ?? readChoice();

const initialExample = EXAMPLES.find((e) => e.name === remembered?.example) ?? EXAMPLES.find((e) => e.name === "sales") ?? EXAMPLES[0]!;

type Theme = "auto" | "light" | "dark";
type Center = "overview" | "journey" | "flow" | "structure" | "charts" | "map" | "sequence" | "docs";
/** Every centre view, in tab order, and what `statestorm share --without=…` calls it. */
const CENTERS: { center: Center; view: View }[] = [
  { center: "overview", view: "overview" }, { center: "journey", view: "journey" }, { center: "flow", view: "flow" },
  { center: "structure", view: "structure" }, { center: "charts", view: "statecharts" },
  { center: "map", view: "context-map" }, { center: "sequence", view: "sequence" }, { center: "docs", view: "docs" },
];
function readCenter(): Center {
  const linked = CENTERS.find((c) => c.view === link.view);
  if (linked) return linked.center;
  try {
    const v = localStorage.getItem("statestorm.center");
    return v === "charts" || v === "journey" || v === "flow" || v === "structure" || v === "map" || v === "sequence" || v === "docs" ? v : "overview";
  } catch { return "overview"; }
}
function readTheme(): Theme {
  try {
    const t = localStorage.getItem("statestorm.theme");
    return t === "light" || t === "dark" ? t : "auto";
  } catch {
    return "auto";
  }
}

export function App() {
  // The bundled examples, and the domains served beside the site or opened from disk, in front.
  const [examples, setExamples] = useState<Example[]>(EXAMPLES);
  const [exampleName, setExampleName] = useState(initialExample.name);
  const [modelText, setModelText] = useState(initialExample.text);
  // The parts model.yaml includes (ADR 0019) come with the domain; the editor edits model.yaml itself.
  const parts = useMemo(() => examples.find((e) => e.name === exampleName)?.parts ?? {}, [examples, exampleName]);
  const loaded = useMemo(() => load(modelText, parts), [modelText, parts]);
  // The last model that loaded, so a typo in the editor does not blank the screen.
  const [lastGood, setLastGood] = useState<Model | undefined>(loaded.model);
  useEffect(() => { if (loaded.model) setLastGood(loaded.model); }, [loaded]);
  const model = loaded.model ?? lastGood;

  const [schedule, setSchedule] = useState<Schedule>({ kind: "fifo" });
  const [startedAt, setStartedAt] = useState(DEFAULT_START);
  const [actions, setActions] = useState<Action[]>([]);
  const [scenario, setScenario] = useState<{ file: string; result: Result; modified: boolean }>();
  const [editing, setEditing] = useState(false);
  const [selection, select] = useState<Selection>();
  const [machine, setMachine] = useState<string>(Object.keys(model?.aggregates ?? {})[0] ?? "");
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [wantedCenter, setCenter] = useState<Center>(readCenter);
  // The sequence's own choices (ADR 0022): what is open holds for the model it was chosen in, what is
  // unfolded for the run — a fold's id names an entry of that run's log.
  // Where the reader is in the docs, and what the structure is focused on: both travel in the link.
  const [docPlace, setDocPlace] = useState<DocPlace>(link.doc ?? { page: "index" });
  const [structureFocus, setStructureFocus] = useState<string | undefined>(link.focus);
  // Which events the overview shows (ADR 0023): the model's statuses, with its asks, or every event.
  const [eventsMode, setEventsMode] = useState<EventsMode>(link.events ?? "requests");
  // The Journey's lines (ADR 0024), by their root's key: absent, the first few there are.
  const [journeyLines, setJourneyLines] = useState<string[] | undefined>(link.lines);
  // The agenda being walked (ADR 0025), and the step of it last chosen: both travel in the link.
  const [agendaChoice, setAgendaChoice] = useState<{ name: string; step: number } | undefined>(link.agenda);
  const [seqChoice, setSeqChoice] = useState<SequenceState & { example?: string; scenario?: string }>(() => ({
    toggled: [], ignored: false, ...link.sequence, example: link.choice?.example, scenario: link.choice?.scenario,
  }));
  // Panel sizes, dragged by the splitters and remembered per browser.
  const [layout, setLayout] = useState<Layout>(() => {
    try { return restore(localStorage.getItem("statestorm.layout")); } catch { return DEFAULT_LAYOUT; }
  });
  useEffect(() => { try { localStorage.setItem("statestorm.layout", JSON.stringify(layout)); } catch { /* fine */ } }, [layout]);
  const resizer = (panel: Panel) => (wanted: number) =>
    setLayout((l) => resize(l, panel, wanted, { width: window.innerWidth, height: window.innerHeight }));
  const toggler = (panel: Panel) => () => setLayout((l) => toggle(l, panel));
  // Presentation mode (design §8): the panels an engineer needs step aside for the picture.
  const wide = !layout.sideOpen && !layout.inspectOpen;
  const setWide = (on: boolean) => setLayout((l) => ({ ...l, sideOpen: !on, inspectOpen: !on }));
  // What the reader chose, not what a domain without that view falls back to.
  useEffect(() => { try { localStorage.setItem("statestorm.center", wantedCenter); } catch { /* fine */ } }, [wantedCenter]);

  useEffect(() => {
    if (theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("statestorm.theme", theme); } catch { /* private mode: fine */ }
  }, [theme]);

  const run = useMemo(() => (model ? play(model, actions, schedule, startedAt) : undefined), [model, actions, schedule, startedAt]);
  const last = (run?.frames.length ?? 1) - 1;
  const [rawIndex, setIndex] = useState(0);
  // A new run can be shorter than the frame the person was looking at; until the effect below
  // moves the cursor, every view must still read a frame that exists.
  const index = Math.min(rawIndex, last);
  // A new run shows where it ended; scrubbing back is the person's move.
  useEffect(() => setIndex(last), [run, last]);
  // Where the cursor was before the last move: a jump of several messages marks everything it
  // covered — on the overview, the statecharts and the trace — not only its final message.
  const [since, setSince] = useState(0);
  const previous = useRef<{ run?: unknown; index: number }>({ index: 0 });
  useEffect(() => {
    // A position in another run means nothing here: a new run starts with nothing marked.
    const p = previous.current;
    if (p.run !== run) {
      // A new run opens at its end (the effect above); that jump is not a step, so mark from there.
      setSince(last);
      previous.current = { run, index: last };
      return;
    }
    setSince(p.index);
    previous.current = { run, index };
  }, [index, run, last]);
  const config = useMemo(() => (model ? withEventsMode(overviewConfig(model).config, eventsMode) : undefined), [model, eventsMode]);
  /** ▶ / ◀: the next frame at which the overview looks different. */
  const change = useCallback((direction: 1 | -1) => {
    if (!model || !run || !config) return;
    setIndex((i) => visibleStep(model, config, run, Math.min(i, last), direction));
  }, [model, run, config, last]);

  // The statechart to open on: the first type this run has instances of — not a chart with
  // nothing active because the model happens to declare an unused type first. A tab picked by
  // hand stays, unless a newly chosen scenario has nothing of that type.
  const populated = useMemo(() => {
    const end = run?.frames[run.frames.length - 1];
    return new Set(end ? Object.values(end.instances).map((i) => i.machine) : []);
  }, [run]);
  useEffect(() => {
    if (model && !model.aggregates[machine] && !model.policies[machine]) {
      const names = Object.keys(model.aggregates);
      setMachine(names.find((n) => populated.has(n)) ?? names[0] ?? "");
    }
  }, [model, machine, populated]);
  useEffect(() => {
    if (model && populated.size > 0 && model.aggregates[machine] && !populated.has(machine)) setMachine("");
    // Only when the scenario changes: an empty tab the reader opened on purpose stays open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario]);

  const example = examples.find((e) => e.name === exampleName);
  // Shared without a view (`statestorm share --without=…`): no tab, and nothing opens on it —
  // the last view used is remembered across domains, and may be one this one does not show.
  const shows = (c: Center) => !(example?.without ?? []).includes(CENTERS.find((v) => v.center === c)!.view) && (c !== "docs" || !!example?.docs);
  const center: Center = shows(wantedCenter) ? wantedCenter : (CENTERS.find((v) => shows(v.center))?.center ?? "overview");
  const seqState: SequenceState = {
    ...(seqChoice.example === exampleName && seqChoice.open ? { open: seqChoice.open } : {}),
    toggled: seqChoice.example === exampleName && seqChoice.scenario === scenario?.file ? seqChoice.toggled : [],
    ignored: seqChoice.ignored,
  };
  const chooseSeq = (next: SequenceState) => setSeqChoice({ ...next, example: exampleName, scenario: scenario?.file });
  // Each scenario names the drawing it walks (MC-14); a scenario that does not parse is on none.
  const walkers = useMemo(() => (example?.scenarios ?? []).map((s) => {
    try {
      const sc = parseScenario(s.text, s.file, setupsOf(example));
      return { file: s.file, name: sc.name, ...(sc.drawing ? { drawing: sc.drawing } : {}), ...(sc.tags ? { tags: sc.tags } : {}) };
    }
    catch { return { file: s.file, name: "" } as { file: string; name: string; drawing?: string; tags?: string[] }; }
  }), [example]);
  // The business's drawings, each with the scenarios that walk it (MC-12, MC-14).
  const drawings = useMemo(() => {
    if (!model || !example) return [];
    const ds = example.drawings.map((d) => parseDrawing(model, d.text, d.file));
    assignScenarios(ds, walkers);
    return ds;
  }, [model, example, walkers]);
  const issues = useMemo(() => (example?.issues ? parseIssues(example.issues, "issues.yaml", example.drawings.map((d) => d.file)).issues : []), [example]);
  // The domain's docs (ADR 0016), traced against this model, its scenarios and its drawing issues —
  // what the Docs view shows, and the structure and the inspector link to.
  const docs = useMemo(() => {
    if (!example?.docs || !model) return undefined;
    try {
      const read = docsFromFiles(example.docs);
      const scenarios = example.scenarios.map((s) => { try { return parseScenario(s.text, `${s.file}.yaml`, setupsOf(example)); } catch { return { file: `${s.file}.yaml` }; } });
      const t = trace({ docs: read, model, modelTexts: { "model.yaml": modelText, ...parts }, scenarios, issues: issues.map((i) => ({ id: i.id, ...(i.why ? { why: i.why } : {}) })) });
      return docsData(read, t, model);
    } catch { return undefined; }
  }, [example, model, modelText, parts, issues]);
  const groups = useMemo(() => scenarioGroups(drawings, walkers), [drawings, walkers]);
  // Tags (MC-15): happy or deviation, and what a scenario is about — every cancellation together.
  const tagged = useMemo(() => tagGroups(walkers), [walkers]);
  const tagsOf = useMemo(() => new Map(walkers.map((w) => [w.file, w.tags ?? []])), [walkers]);
  const [tag, setTag] = useState<string>(() => { try { return localStorage.getItem("statestorm.tag") ?? ""; } catch { return ""; } });
  const chooseTag = (t: string) => { setTag(t); try { localStorage.setItem("statestorm.tag", t); } catch { /* fine */ } };
  const shown = (f: string) => !tag || tagMatches(tagsOf.get(f) ?? [], tag) || f === scenario?.file;
  // The picker's title search reads each scenario's title (`scenario:`).
  const nameOf = useMemo(() => new Map(walkers.map((w) => [w.file, w.name])), [walkers]);
  // References (WOM-12) up front — long names are cut at the end — and typing one finds the scenario.
  const marked = (f: string) => {
    const t = tagsOf.get(f) ?? [];
    const refs = referencesOf(t);
    return `${t.includes("happy") ? "✓" : t.includes("deviation") ? "⚠" : "·"} ${refs.length ? `[${refs.join(" ")}] ` : ""}${f}`;
  };
  const sections = useMemo(() => [...new Set(tagged.map((g) => g.section ?? "topic"))], [tagged]);

  // The domain's agendas (ADR 0025); one that does not read is left out here — the check says why.
  const agendas = useMemo(() => {
    const files = (example?.scenarios ?? []).map((s) => s.file);
    return (example?.agendas ?? []).flatMap((a) => parseAgenda(a.text, `${a.file}.yaml`, files).agenda ?? []);
  }, [example]);
  const agenda: Agenda | undefined = agendas.find((a) => a.name === agendaChoice?.name);
  const steps = useMemo(() => (agenda ? stepsOf(agenda) : []), [agenda]);
  // The step shown: the one chosen if its scenario is open, else the first step with that scenario.
  const stepAt = !agenda || !scenario ? -1
    : steps[agendaChoice!.step]?.file === scenario.file ? agendaChoice!.step : steps.findIndex((st) => st.file === scenario.file);
  const goStep = (n: number, a: Agenda | undefined = agenda) => {
    const all = a ? stepsOf(a) : [];
    const st = all[Math.min(Math.max(n, 0), all.length - 1)];
    if (!a || !st) return;
    setAgendaChoice({ name: a.name, step: all.indexOf(st) });
    chooseScenario(st.file);
    const c = CENTERS.find((x) => x.view === st.view)?.center;
    if (c) setCenter(c);
  };
  const chooseAgenda = (name: string) => {
    const a = agendas.find((x) => x.name === name);
    if (!a) { setAgendaChoice(undefined); return; }
    goStep(0, a);
  };

  const chooseExample = (name: string) => {
    const ex = examples.find((e) => e.name === name);
    if (ex) openExample(ex);
  };
  /** Open a domain; an agenda goes with it only if given (a link's), or if it opens on one (a shared file's). */
  const openExample = (ex: Example, agendaWith?: { name: string; step: number }) => {
    const name = ex.name;
    setExampleName(name);
    setModelText(ex.text);
    saveChoice({ example: name });
    setActions([]);
    setScenario(undefined);
    setStartedAt(DEFAULT_START);
    select(undefined);
    setMachine("");
    setAgendaChoice(agendaWith ?? (ex.opens ? { name: ex.opens, step: 0 } : undefined));
  };

  const chooseScenario = (file: string) => {
    const text = example?.scenarios.find((s) => s.file === file)?.text;
    if (!text || !model) {
      setScenario(undefined);
      saveChoice({ example: exampleName });
      return;
    }
    saveChoice({ example: exampleName, scenario: file });
    const sc = parseScenario(text, file, setupsOf(example));
    const chosen = sc.schedule ?? schedule;
    setSchedule(chosen);
    setStartedAt(sc.given.at ?? DEFAULT_START);
    setActions(actionsOf(sc));
    setScenario({ file, result: runScenario(model, sc, chosen), modified: false });
    select(undefined);
  };

  // Domains served beside the site (`statestorm dev`, `statestorm build`) join the list; the one
  // chosen last is opened again, or else the first of them — that is what the server is for.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void servedDomains().then((served) => {
      if (!live) return;
      if (served.length > 0) {
        setExamples([...served, ...(showExamples ? EXAMPLES.filter((e) => !served.some((d) => d.name === e.name)) : [])]);
        // A link or a memory of a bundled example still listed stays on it; otherwise the served domain.
        const kept = showExamples && !served.some((d) => d.name === remembered?.example) && EXAMPLES.some((e) => e.name === remembered?.example);
        const want = served.find((d) => d.name === remembered?.example) ?? served[0]!;
        if (!kept) openExample(want, link.choice?.example === want.name ? link.agenda : undefined);
      }
      setReady(true);
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const openFolder = async () => {
    const picked = await pickDomainFolder();
    if (!picked) return;
    const ex = domainFromFiles(picked.name, picked.files);
    if (!ex.text) { window.alert(`${picked.name}: no model.yaml — a domain folder holds model.yaml, scenarios/ and drawings/`); return; }
    setExamples((prev) => [ex, ...prev.filter((e) => e.name !== ex.name)]);
    openExample(ex);
  };

  // Back to the scenario chosen last, once, on load — after the served domains are in.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !model || !ready) return;
    restored.current = true;
    const wanted = agendaChoice ?? (example?.opens ? { name: example.opens, step: 0 } : undefined);
    const a = wanted ? agendas.find((x) => x.name === wanted.name) : undefined;
    if (a) { goStep(wanted!.step, a); return; }
    if (agendaChoice) setAgendaChoice(undefined);
    if (remembered?.scenario && remembered.example === exampleName && example?.scenarios.some((s) => s.file === remembered.scenario)) {
      chooseScenario(remembered.scenario);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, ready]);

  // The address is the view: model, scenario, view and the sequence's choices (ADR 0022 §8). Written
  // once the domains are in and the linked scenario restored, so a link is not overwritten on load.
  useEffect(() => {
    if (!ready || !restored.current) return;
    const q = new URLSearchParams();
    q.set("model", exampleName);
    if (scenario) q.set("scenario", scenario.file);
    if (agenda) { q.set("agenda", agenda.name); if (stepAt >= 0) q.set("step", String(stepAt + 1)); }
    q.set("view", CENTERS.find((c) => c.center === center)!.view);
    if (center === "docs") {
      q.set("doc", docPlace.page);
      if (docPlace.at) q.set("at", docPlace.at);
    }
    if (center === "structure" && structureFocus) q.set("focus", structureFocus);
    if ((center === "overview" || center === "journey") && eventsMode !== "requests") q.set("events", eventsMode);
    if (center === "journey" && journeyLines) q.set("lines", journeyLines.join(","));
    if (center === "sequence") {
      if (seqState.open) q.set("open", seqState.open.join(","));
      if (seqState.toggled.length) q.set("toggled", seqState.toggled.join(","));
      if (seqState.ignored) q.set("ignored", "1");
    }
    const hash = `#${q.toString()}`;
    if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
  });

  /** Where a link in the docs, the structure or the inspector goes (ADR 0016 §9). */
  const goTarget = (target: Target) => {
    if (target.kind === "type") { focusStructure(target.type); setCenter("structure"); }
    else if (target.kind === "package") { focusStructure(`package:${target.name}`); setCenter("structure"); }
    else if (target.kind === "state") { setMachine(target.machine); select({ kind: "state", machine: target.machine, ref: target.ref }); setCenter("charts"); }
    else if (target.kind === "transition") { setMachine(target.machine); select({ kind: "transition", machine: target.machine, id: target.id }); setCenter("charts"); }
    else if (target.kind === "policy") { setMachine(target.machine); setCenter("charts"); }
  };
  const goDoc = (p: DocPlace) => { setDocPlace(p); setCenter("docs"); };
  /** A focus in the structure is a selection: the inspector shows what the docs say of it. */
  const focusStructure = (f?: string) => {
    setStructureFocus(f);
    if (f) select(f.startsWith("package:") ? { kind: "package", name: f.slice("package:".length) } : { kind: "type", name: f });
    else if (selection?.kind === "type" || selection?.kind === "package") select(undefined);
  };
  /** A rule or question by its id, on its page in the docs. */
  const goRule = (id: string) => {
    if (!docs) return;
    if (docs.questions.has(id)) { goDoc({ page: "questions", at: id }); return; }
    const r = docs.rules.get(id);
    if (r) goDoc({ page: `topic:${r.topic}`, at: id });
  };
  const docLinks: DocLinks = { place: goDoc, target: goTarget, scenario: (f) => chooseScenario(f) };

  const act = useCallback((action: Action) => {
    if (!run) return;
    setActions((prev) => (index < last ? continueFrom(prev, run, index, action) : [...prev, action]));
    setScenario((s) => (s ? { ...s, modified: true } : s));
  }, [run, index, last]);

  const selectAndFocus = (s: Selection) => {
    select(s);
    if (s?.kind === "instance") setMachine(machineOfKey(s.key));
    if (s?.kind === "transition" || s?.kind === "state") setMachine(s.machine);
    // A type or package picked in the inspector is the structure's focus too.
    if (s?.kind === "type") setStructureFocus(s.name);
    if (s?.kind === "package") setStructureFocus(`package:${s.name}`);
  };

  // ← / → step through frames, unless the person is typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select")) return;
      // ← / → follow what the overview shows; with Shift, one message at a time.
      if (e.key === "ArrowLeft") e.shiftKey ? setIndex((i) => Math.max(0, i - 1)) : change(-1);
      if (e.key === "ArrowRight") e.shiftKey ? setIndex((i) => Math.min(last, i + 1)) : change(1);
      if (e.key === "Home") setIndex(0);
      if (e.key === "End") setIndex(last);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [last, change]);

  const frame = run?.frames[index];
  // Moving forward, "now" is everything since the last position; otherwise the one step back.
  const from = since < index ? since : index - 1;
  const prevSeq = from >= 0 && run ? run.frames[from]!.seq : 0;

  return (
    <div
      className={`app${layout.sideOpen ? "" : " no-side"}${layout.inspectOpen ? "" : " no-inspect"}${layout.traceOpen ? "" : " no-trace"}`}
      style={{
        gridTemplateColumns: `${layout.sideOpen ? layout.side : 0}px 8px minmax(0, 1fr) 8px ${layout.inspectOpen ? layout.inspect : 0}px`,
        gridTemplateRows: `auto minmax(0, 1fr) 8px auto ${layout.traceOpen ? layout.trace : 0}px`,
      }}
    >
      <header className="top">
        <h1>statestorm <span>· {model?.context ?? "no model"}</span></h1>
        <label>
          Model
          <select value={exampleName} onChange={(e) => chooseExample(e.target.value)}>
            {examples.map((e) => <option key={e.name} value={e.name}>{e.name}</option>)}
          </select>
        </label>
        <button onClick={() => void openFolder()} title="Open a domain folder — model.yaml, scenarios/, drawings/ — from this computer. It is read here, in the browser; nothing is uploaded.">Open folder…</button>
        <button onClick={() => setEditing(true)}>Edit model…</button>
        <label>
          Scenario
          {/* Grouped by the drawing they walk; one that walks several is under each. Type to narrow. */}
          <ScenarioPicker
            value={scenario?.file ?? ""}
            label={marked}
            nameOf={(f) => nameOf.get(f) ?? ""}
            onChoose={chooseScenario}
            groups={agenda
              ? agenda.items.map((it, i) => ({ id: `agenda:${i}`, label: `${i + 1}. ${it.title} (${it.scenarios.length})`, files: it.scenarios }))
              : groups.length > 0
              ? groups.map((g) => ({ id: g.id, label: `▸ ${g.title.replace(/^To Be — /, "")} (${g.files.length})`, files: g.files.filter(shown) }))
              : [{ id: "all", label: "scenarios", files: (example?.scenarios ?? []).map((sc) => sc.file).filter(shown) }]}
          />
        </label>
        {agendas.length > 0 && (
          <label title="An agenda (ADR 0025): the scenarios chosen for a meeting, under its topics, in order — ‹ › step through them">
            Agenda
            <select value={agenda?.name ?? ""} onChange={(e) => chooseAgenda(e.target.value)}>
              <option value="">none</option>
              {agendas.map((a) => <option key={a.name} value={a.name}>{a.title}{a.date ? ` · ${a.date}` : ""}</option>)}
            </select>
          </label>
        )}
        {tagged.length > 0 && !agenda && (
          <label title="✓ happy path · ⚠ deviation — what a scenario is about — and the outside items it proves (WOM-12)">
            Tag
            <select value={tag} onChange={(e) => chooseTag(e.target.value)}>
              <option value="">every scenario</option>
              {sections.map((s) => (
                <optgroup key={s} label={s === "kind" ? "kind" : s === "topic" ? "about" : `${s} references`}>
                  {tagged.filter((g) => (g.section ?? "topic") === s).map((g) => (
                    <option key={g.id} value={g.title}>{g.title.endsWith("-*") ? `every ${g.title}` : g.title} ({g.files.length})</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        )}
        {tag && !agenda && (
          <button className="tag-filter-on" onClick={() => chooseTag("")} title="The picker shows only the scenarios with this tag — click to show them all">
            showing {walkers.filter((w) => tagMatches(w.tags ?? [], tag)).length} of {walkers.length} · ✕ all
          </button>
        )}
        {scenario && (
          <span className={`scenario-result ${scenario.result.failures.length ? "fail" : "ok"}`}
            title={scenario.result.failures.join("\n")}>
            {scenario.result.failures.length
              ? `✗ ${scenario.result.failures.length} assertion(s) fail`
              : "✓ assertions pass"}
            {scenario.modified && " · modified since"}
          </span>
        )}
        <label>
          Delivery
          <select
            value={schedule.kind === "random" ? `random:${schedule.seed}` : schedule.kind}
            onChange={(e) => {
              const v = e.target.value;
              setSchedule(v.startsWith("random:") ? { kind: "random", seed: Number(v.slice(7)) } : { kind: v as "fifo" | "duplicate" });
            }}
            title="At-least-once and unordered (ADR 0006): fifo is the tidy story, the others are what the infrastructure may do"
          >
            <option value="fifo">fifo — in order, once</option>
            <option value="duplicate">duplicate — every message twice</option>
            {[1, 2, 3, 4, 5].map((s) => <option key={s} value={`random:${s}`}>random({s}) — reordered</option>)}
          </select>
        </label>
        <span className="spacer" />
        <button onClick={() => setTheme(theme === "auto" ? "dark" : theme === "dark" ? "light" : "auto")} title="Colour theme">
          {theme === "auto" ? "◐ auto" : theme === "dark" ? "● dark" : "○ light"}
        </button>
      </header>


      {model && run && frame && (
        <>
          <aside className="side">
            <Fire model={model} frame={frame} actions={actions} run={run} index={index} last={last}
              onAct={act} onIndex={setIndex} onClear={() => { setActions([]); setScenario(undefined); }} />
            <WorldPanel model={model} run={run} index={index} selection={selection} select={selectAndFocus} />
            {model.findings.length > 0 && (
              <section>
                <h2>Model findings</h2>
                <ul className="findings">{model.findings.map((f, i) => <li key={i}>{f.message}</li>)}</ul>
              </section>
            )}
          </aside>
          <Splitter area="sl" axis="col" size={layout.side} sign={1} collapsed={!layout.sideOpen}
            label="the command panel" onResize={resizer("side")} onToggle={toggler("side")} />
          <Splitter area="sr" axis="col" size={layout.inspect} sign={-1} collapsed={!layout.inspectOpen}
            label="the inspector" onResize={resizer("inspect")} onToggle={toggler("inspect")} />
          <Splitter area="sh" axis="row" size={layout.trace} sign={-1} collapsed={!layout.traceOpen}
            label="the trace" onResize={resizer("trace")} onToggle={toggler("trace")} />
          <main className="chart">
            {loaded.error && (
              <div className="error-box" style={{ margin: "8px 12px 0" }}>
                The model does not load — showing the last version that did:{"\n"}{loaded.error}
              </div>
            )}
            {agenda && (
              <AgendaBar agenda={agenda} steps={steps} at={stepAt} nameOf={(f) => nameOf.get(f) ?? f}
                onStep={(n) => goStep(n)} onClose={() => setAgendaChoice(undefined)} {...(docs ? { onRule: goRule } : {})} />
            )}
            <div className="view-switch" role="tablist" aria-label="View">
              {shows("overview") && <button role="tab" aria-selected={center === "overview"} className={center === "overview" ? "active" : ""}
                onClick={() => setCenter("overview")} title="The journey: instances, their states, and the events that moved them">Overview</button>}
              {shows("journey") && <button role="tab" aria-selected={center === "journey"} className={center === "journey" ? "active" : ""}
                onClick={() => setCenter("journey")} title="Each root of the overview as a metro line down the page: every step's progress, the events received there, and when (ADR 0024)">Journey</button>}
              {shows("flow") && <button role="tab" aria-selected={center === "flow"} className={center === "flow" ? "active" : ""}
                onClick={() => setCenter("flow")} title="The whole process on one page: events in lanes, and what can follow what">Flow</button>}
              {shows("structure") && <button role="tab" aria-selected={center === "structure"} className={center === "structure" ? "active" : ""}
                onClick={() => setCenter("structure")} title="Every type, what it holds, and how the types hang together — an ERD">Structure</button>}
              {shows("charts") && <button role="tab" aria-selected={center === "charts"} className={center === "charts" ? "active" : ""}
                onClick={() => setCenter("charts")} title="Every type's statechart: all the rules, for working out why">Statecharts</button>}
              {model.systems && <>
                {shows("map") && <button role="tab" aria-selected={center === "map"} className={center === "map" ? "active" : ""}
                  onClick={() => setCenter("map")} title="Which systems, bounded contexts and sub-systems talk to which (ADR 0018)">Context map</button>}
                {shows("sequence") && <button role="tab" aria-selected={center === "sequence"} className={center === "sequence" ? "active" : ""}
                  onClick={() => setCenter("sequence")} title="The scenario as a sequence diagram: only what crosses a boundary (ADR 0018)">Sequence</button>}
              </>}
              {shows("docs") && <button role="tab" aria-selected={center === "docs"} className={center === "docs" ? "active" : ""}
                onClick={() => setCenter("docs")} title="The domain's decisions: every topic's rules, the glossary, the questions, the sessions — linked to the model (ADR 0016)">Docs</button>}
              <button style={{ marginLeft: "auto" }} className={wide ? "active" : ""} onClick={() => setWide(!wide)}
                title="Hide the side panels — for presenting">{wide ? "⤡ panels" : "⤢ wide"}</button>
            </div>
            {(center === "map" || center === "sequence") && model.systems
              ? (center === "map" ? <ContextMap model={model} select={selectAndFocus} /> : <Sequence model={model} run={run} index={index} onIndex={setIndex} state={seqState} onState={chooseSeq} select={selectAndFocus} />)
              : center === "overview" || center === "map" || center === "sequence"
              ? <Overview model={model} run={run} index={index} since={from} selection={selection} select={select} onIndex={setIndex} eventsMode={eventsMode} onEventsMode={setEventsMode} />
              : center === "journey"
              ? <Journey model={model} run={run} index={index} select={select} onIndex={setIndex} eventsMode={eventsMode} onEventsMode={setEventsMode}
                  {...(journeyLines ? { lines: journeyLines } : {})} onLines={setJourneyLines} />
              : center === "docs" && docs
              ? <Docs model={model} data={docs} place={docPlace} links={docLinks} scenarios={new Set(example?.scenarios.map((s) => s.file) ?? [])} />
              : center === "structure"
              ? <Structure model={model} frame={frame} focus={structureFocus} onFocus={focusStructure} />
              : center === "flow"
              ? <Flow model={model} run={run} index={index} scenarios={example?.scenarios ?? NO_SCENARIOS} setups={example?.setups}
                  drawings={drawings} groups={[...groups, ...tagged]} issues={issues} select={select} onIndex={setIndex} />
              : <Statechart model={model} machine={machine} setMachine={setMachine} frame={frame}
                  log={run.world.log} prevSeq={prevSeq} selection={selection} select={selectAndFocus} />}
          </main>
          <aside className="inspect">
            <Inspector model={model} run={run} index={index} selection={selection} select={selectAndFocus} onIndex={setIndex} docs={docs} onRule={goRule} onDoc={goDoc} />
          </aside>
          <div className="timeline">
            <Timeline run={run} index={index} since={from} onIndex={setIndex} onChange={change} startedAt={Date.parse(startedAt)} />
          </div>
          <div className="trace">
            <Trace run={run} index={index} since={from} onIndex={setIndex} selection={selection} select={selectAndFocus}
              startedAt={Date.parse(startedAt)} />
          </div>
        </>
      )}

      {editing && (
        <ModelEditor text={modelText} error={loaded.error} onApply={setModelText} onClose={() => setEditing(false)} />
      )}
    </div>
  );
}
