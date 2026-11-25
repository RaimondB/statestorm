import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadModel } from "../src/model.ts";
import { c4Of, c4ToMermaid, choiceOfEvent, contextMap, contextMapToMermaid, placeOf, receiversOfEvent, scopesOf, senderOfCommand } from "../src/systems.ts";

// ADR 0018 and ADR 0020, on the lab example: one system of its own in three sub-systems, a vendor's
// patient portal that runs what the model specifies, a scanner vendor in three parts, two domains.
const LAB = readFileSync(new URL("../../examples/models/lab.yaml", import.meta.url), "utf8");
const lab = loadModel(LAB);

/** The lab model with its `systems:` section replaced (and no contexts or relations), its policies placed nowhere. */
function withSystems(yaml: string): string {
  const start = LAB.indexOf("\nsystems:\n");
  const end = LAB.indexOf("\noverview:\n");
  return (LAB.slice(0, start) + "\n" + yaml.trim() + "\n" + LAB.slice(end)).replace(/\n    in: [^\n]+/g, "");
}

test("a type lives in its package's sub-system; an entity in its aggregate's, whatever its abstract supertype's package", () => {
  const lab_ = { system: "Lab", domain: "Diagnostics" };
  assert.deepEqual(placeOf(lab, "SiteVisit"), { ...lab_, context: "Sample logistics", subsystem: "Logistics" });
  // SiteTask extends Task, which is in Steps (Ordering) — but SiteVisit creates it, in Logistics.
  assert.deepEqual(placeOf(lab, "SiteTask"), { ...lab_, context: "Sample logistics", subsystem: "Logistics" });
  assert.deepEqual(placeOf(lab, "AnalysisHandling"), { ...lab_, context: "Testing", subsystem: "Bench" });
  // A vendor's system runs the types of its packages (ADR 0020 §2): a system of one sub-system, named
  // as the system, and — external — a context of its own.
  assert.deepEqual(placeOf(lab, "PatientView"), { system: "Patient portal", context: "Patient portal", subsystem: "Patient portal", domain: "Diagnostics" });
  assert.equal(lab.findings.length, lab.findings.filter((f) => !/ADR 0018|relations:/.test(f.message)).length, "the lab declares its systems without a warning");
});

test("the loader holds the names: packages, sub-systems, commands, events, patterns", () => {
  const refused = (yaml: string, message: RegExp) => assert.throws(() => loadModel(withSystems(yaml)), message);
  refused("systems:\n  A: { packages: [Nowhere] }", /no package called `Nowhere`/);
  refused("systems:\n  A: { packages: [Steps] }\n  B: { packages: [Steps] }", /`Steps` is already in sub-system A/);
  refused("systems:\n  A: { packages: [Steps] }\n  X: { external: true, context: Y, packages: [Sites] }", /an external system is a context of its own/);
  refused("systems:\n  A: { packages: [Steps] }\n  X: { external: true, sends: [{ Sample.Scan: { colour: [red] } }] }", /Sample.Scan takes no field `colour` \(it takes scanId, event, site, reason\)/);
  refused("systems:\n  A: { packages: [Steps] }\n  X: { external: true, subsystems: { P: {} } }", /systems.X.subsystems.P: an external system says what it `sends`/);
  refused("systems:\n  A: { packages: [Steps] }\n  X: { external: true, sends: [Request.Create], subsystems: { P: { sends: [Request.Create] } } }", /`sends` — an external system with sub-systems says it on each/);
  refused("systems:\n  A: { domain: D, packages: [Steps] }\ndomains:\n  E: { note: x }", /domains.E: no system is in this domain/);
  refused("systems:\n  A: { packages: [Steps] }\n  X: { external: true, sends: [Request.Fly] }", /Request answers no command `Fly`/);
  refused("systems:\n  A: { packages: [Steps] }\n  X: { external: true, sends: [SiteTask.Plan] }", /SiteTask is an entity/);
  refused("systems:\n  A: { packages: [Steps] }\n  X: { external: true, receives: [Nothing] }", /no type of the model raises `Nothing`/);
  refused("systems:\n  A: { packages: [Steps] }\nrelations:\n  - { upstream: A, downstream: A, pattern: friendship }", /`friendship` \(expected customer-supplier/);
  refused("systems:\n  A: { packages: [Steps] }\ncontexts:\n  Lonely: { team: x }", /contexts.Lonely: no sub-system is in this context/);
});

test("a part receives an event narrowed by its payload (ADR 0031): only those values; a choice among its receivers", () => {
  const names = (about: string) => receiversOfEvent(lab, "PatientInformed", { about }).map((p) => p.name);
  assert.deepEqual(names("collected"), ["Text gateway"]);
  assert.deepEqual(names("results ready"), ["Mail service"]);
  assert.deepEqual(names("something else"), [], "a value no part takes: told to none");
  assert.deepEqual(choiceOfEvent(lab, "PatientInformed").fields, ["about"]);
  assert.deepEqual(choiceOfEvent(lab, "RequestCreated"), { fields: [], among: [] }, "heard whatever it carries: no choice");
  const refused = (yaml: string, message: RegExp) => assert.throws(() => loadModel(withSystems(yaml)), message);
  refused("systems:\n  A: { packages: [Steps] }\n  X: { external: true, receives: [{ PatientInformed: { colour: [red] } }] }", /PatientInformed is raised with no field `colour` \(it has about\)/);
  refused("systems:\n  A: { packages: [Steps] }\n  X: { external: true, receives: [{ PatientInformed: {} }] }", /narrow it by a field, or write it plain/);
  refused("systems:\n  A: { packages: [Steps] }\n  X: { external: true, receives: [PatientInformed, PatientInformed] }", /`PatientInformed` is listed twice/);
});

test("a part of our own works a command out itself (ADR 0030): its sender, never a person's; one sender", () => {
  // Lab's Ordering works out which step of a route follows which: the scenario sends the links in its name.
  assert.equal(senderOfCommand(lab, "Route", "Link", {})?.name, "Ordering");
  assert.equal(senderOfCommand(lab, "Route", "Link", {})?.external, undefined);
  assert.equal(senderOfCommand(lab, "Route", "Plan", {})?.name, "Hospital information system");
  const refused = (yaml: string, message: RegExp) => assert.throws(() => loadModel(withSystems(yaml)), message);
  refused("systems:\n  A: { packages: [Steps] }\n  X: { external: true, computes: [Route.Link] }", /`computes` is for a system of its own — an external system `sends`/);
  refused("systems:\n  A: { computes: [Route.Link], subsystems: { P: { packages: [Steps] } } }", /a system with sub-systems says it on each/);
  refused("systems:\n  A: { packages: [Steps], computes: [Route.Fly] }", /Route answers no command `Fly`/);
  refused("systems:\n  A: { packages: [Steps], computes: [Route.Link] }\n  X: { external: true, sends: [Route.Link] }", /Route.Link is worked out inside A and sent by X too/);
  // Narrowed apart by the payload, two senders of one command stand side by side.
  assert.doesNotThrow(() => loadModel(withSystems("systems:\n  A: { packages: [Steps], computes: [{ Sample.Scan: { event: [Queued] } }] }\n  X: { external: true, sends: [{ Sample.Scan: { event: [Collected] } }] }")));
});

test("a type in no system, and a relation the model does not connect, are warnings", () => {
  const m = loadModel(withSystems("systems:\n  A: { packages: [Requests, Steps] }\n  B: { packages: [Patient] }\nrelations:\n  - { upstream: B, downstream: A, pattern: conformist }"));
  assert.ok(m.findings.some((f) => /in no system: .*SiteVisit/.test(f.message)));
  assert.ok(!m.findings.some((f) => /relations: B → A/.test(f.message)), "A tells B (the patient view): connected, whichever way the pattern reads");
  const n = loadModel(withSystems("systems:\n  A: { packages: [Requests, Steps, Sites, Transfers, Samples, Deviations, Analysis] }\n  B: { packages: [Patient] }\n  C: { external: true, receives: [PatientInformed] }\nrelations:\n  - { upstream: A, downstream: C, pattern: conformist }"));
  assert.ok(n.findings.some((f) => /relations: A → C \(conformist\) — the model sends nothing between them/.test(f.message)));
});

test("the context map: an edge where a policy carries an event across, and the external systems' own", () => {
  const sys = contextMap(lab, "system");
  const edge = (from: string, to: string) => sys.edges.find((e) => e.from === from && e.to === to);
  assert.deepEqual(sys.nodes.map((n) => `${n.id}:${n.kind}`), ["Lab:system", "Patient portal:external", "Hospital information system:external", "Scanners:external", "Messaging:external"]);
  assert.deepEqual(sys.nodes[0]!.library, ["Steps"], "the Lab owns the steps' shared definition (ADR 0020 §5)");
  assert.ok(edge("Lab", "Patient portal")!.events.includes("RequestCreated"));
  assert.deepEqual(edge("Lab", "Patient portal")!.patterns, ["customer-supplier"]);
  assert.deepEqual(edge("Scanners", "Lab")!.commands, ["Sample.Scan"], "a command is said with its type (ADR 0020 §6)");
  assert.deepEqual(edge("Patient portal", "Messaging")!.events, ["PatientInformed"], "told to one of its parts, by the payload: still one edge");
  assert.equal(edge("Patient portal", "Lab"), undefined, "the portal tells the lab nothing");

  const ctx = contextMap(lab, "context");
  assert.ok(ctx.edges.some((e) => e.from === "Hospital information system" && e.to === "Requests" && e.patterns.includes("anticorruption-layer")));
  assert.ok(ctx.edges.some((e) => e.from === "Sample logistics" && e.to === "Testing" && e.events.includes("Received")), "a scan's event reaches the bench's handlings");

  const inside = contextMap(lab, "subsystem", "Lab");
  assert.deepEqual(inside.nodes.filter((n) => n.kind === "subsystem").map((n) => n.id), ["Ordering", "Logistics", "Bench"]);
  assert.ok(inside.nodes.some((n) => n.id === "Patient portal" && n.kind === "external"), "the other systems as wholes");
  assert.throws(() => contextMap(lab, "subsystem", "Patient portal"), /needs a system as its scope/);
  assert.deepEqual(scopesOf(lab), ["Lab", "Scanners", "Messaging"], "ours, and the vendors in parts");
  assert.match(contextMapToMermaid(sys), /Lab -->\|"U → D, «customer-supplier», RequestCreated/);
});

test("domains (ADR 0020 §1): a scope of systems is one node; a system in none is itself", () => {
  const map = contextMap(lab, "domain");
  assert.deepEqual(map.nodes.map((n) => `${n.id}:${n.kind}`), ["Diagnostics:domain", "Hospital:domain", "Scanners:external", "Messaging:external"]);
  assert.deepEqual(map.nodes[0]!.holds, ["Lab", "Patient portal"]);
  assert.ok(!map.edges.some((e) => e.from === "Diagnostics" && e.to === "Diagnostics"), "the lab tells its portal: inside the domain");
  assert.ok(map.edges.some((e) => e.from === "Hospital" && e.to === "Diagnostics" && e.commands.includes("Request.Create")));
  assert.match(contextMapToMermaid(map), /Diagnostics\(\["Diagnostics<br\/>«domain»<br\/>Lab, Patient portal"\]\)/);
});

test("a vendor in parts, each sending its own scans (ADR 0020 §3, §4): the payload says which", () => {
  assert.equal(senderOfCommand(lab, "Sample", "Scan", { event: "Packed" })?.name, "Clinic app");
  assert.equal(senderOfCommand(lab, "Sample", "Scan", { event: "Received" })?.name, "Bench scanner");
  assert.equal(senderOfCommand(lab, "Sample", "Scan", { event: "Teleported" }), undefined, "no part sends it: a person");
  const inside = contextMap(lab, "subsystem", "Scanners");
  assert.deepEqual(inside.nodes.filter((n) => n.kind === "subsystem").map((n) => n.id), ["Clinic app", "Courier app", "Bench scanner"]);
  assert.ok(inside.edges.some((e) => e.from === "Bench scanner" && e.to === "Lab"));
});

// ADR 0035: where a policy runs, and who depends on whom.
const policyIn = (name: string, where: string) => LAB.replace(new RegExp(`(\\n  ${name}:\\n(?:    why: .*\\n)?)    in: [^\\n]+\\n`), `$1    in: ${where}\n`);

test("a policy runs in a part (ADR 0035): a sub-system, a system of one, `target` or `source` — the loader holds the names", () => {
  assert.equal(lab.policies.ask_analysis_site!.runsIn, "Bench");
  assert.equal(lab.policies.scans_to_handlings!.runsIn, "target");
  assert.ok(loadModel(policyIn("open_patient_view", "Patient portal")), "a system of one sub-system, by its name");
  assert.throws(() => loadModel(policyIn("ask_analysis_site", "Benchh")), /ask_analysis_site: in: Benchh — there is no sub-system called Benchh/);
  assert.throws(() => loadModel(policyIn("ask_analysis_site", "Lab")), /Lab is in parts: name one of Ordering, Logistics, Bench/);
  assert.throws(() => loadModel(policyIn("ask_analysis_site", "Clinic app")), /Clinic app runs none of the model's packages/);
  assert.throws(() => loadModel(LAB.replace("\n  ask_analysis_site:\n", "\n  ask_analysis_site:\n    in: target\n").replace("    in: Bench\n    on: AnalysisPlanned\n    command: \"Site#", "    on: AnalysisPlanned\n    command: \"${event.kind}#")),
    /in: target — the type of `\$\{event.kind\}#.*` is worked out at run time/);
  assert.throws(() => loadModel(withSystems("systems:\n  A: { subsystems: { target: { packages: [Requests, Steps, Sites, Transfers, Samples, Deviations, Analysis, Patient, Cool boxes] } } }")
    .replace("\n  scans_to_handlings:\n    why: [R7]\n", "\n  scans_to_handlings:\n    why: [R7]\n    in: target\n")),
    /a sub-system is called `target`/);
  const noSystems = LAB.slice(0, LAB.indexOf("\nsystems:\n")) + "\n" + LAB.slice(LAB.indexOf("\noverview:\n"));
  assert.throws(() => loadModel(noSystems.replace(/\nrelations:\n(  - .*\n)+/, "\n").replace(/\nroles:\n(  .*\n)+/, "\n").replace(/\ncontexts:\n(  .*\n)+/, "\n").replace(/\ndomains:\n(  .*\n)+/, "\n")), /in: .* — the model declares no `systems:`/);
  assert.throws(() => loadModel(LAB.replace("    command: \"PatientView#${event.request}.Open\"", "    command: \"PatientView#${event.request}.Open\"\n  nothing_raises_it:\n    in: source\n    on: Teleported\n    command: \"PatientView#${event.request}.Open\"")),
    /nothing_raises_it: in: source — no type of the model raises Teleported/);
  assert.throws(() => loadModel(LAB.replace("  Sample:\n    why: [R7]\n", "  Sample:\n    why: [R7]\n    in: Logistics\n")), /Sample: `in:` says where a policy runs/);
});

test("the map says which end depends on the other (ADR 0035): heard, sent, run by each part — and nothing when it does not know", () => {
  const inside = contextMap(lab, "subsystem", "Lab");
  const edge = (from: string, to: string) => inside.edges.find((e) => e.from === from && e.to === to)!;
  // Bench asks a site (Logistics) and hears the answer: it depends on Logistics either way.
  assert.deepEqual(edge("Bench", "Logistics").downstream, ["Bench"], "a command sent from the part it runs in");
  assert.ok(edge("Bench", "Logistics").commands.includes("Site.Describe"));
  assert.deepEqual(edge("Logistics", "Bench").downstream, ["Bench"], "an event heard where it runs");
  // in: target — each part hears the sample's scans for its own handlings: only the event crosses.
  assert.ok(edge("Logistics", "Ordering").policies.includes("scans_to_handlings"));
  assert.deepEqual(edge("Logistics", "Ordering").commands, [], "the command stays in the part that runs it");
  // ...and a part hears only the scans one of its handlings answers: the bench's analysis no pickup.
  assert.deepEqual(edge("Logistics", "Bench").events.filter((e) => ["Collected", "Packed", "PickedUp", "Delivered", "Received", "Analysed"].includes(e)), ["Received", "Analysed"]);
  assert.deepEqual(edge("Logistics", "Ordering").events.filter((e) => ["Collected", "Packed", "PickedUp", "Delivered", "Received", "Analysed"].includes(e)), ["Collected"]);
  // in: source — each part tells the sample of its own stopped step.
  assert.ok(edge("Ordering", "Logistics").policies.includes("report_stop"));
  assert.deepEqual(edge("Ordering", "Logistics").downstream, ["Ordering"]);
  assert.ok(!inside.edges.some((e) => e.mutual), "the sample is the one every part hears: no two parts depend on each other");
  assert.deepEqual(edge("Hospital information system", "Ordering").downstream, [], "an outside system's own edge: the model does not know");
  assert.deepEqual(contextMap(lab, "system").edges.find((e) => e.from === "Lab" && e.to === "Patient portal")!.downstream, ["Patient portal"]);
  const unplaced = loadModel(LAB.replace(/\n    in: [^\n]+/g, ""));
  assert.ok(contextMap(unplaced, "subsystem", "Lab").edges.every((e) => e.downstream.length === 0 || e.from === "Lab" || e.to === "Lab" || e.to === "Patient portal"),
    "no policy placed: only a declared relation says anything");
  assert.match(contextMapToMermaid(inside), /Bench -->\|"D → U, /);
});

test("the check warns (ADR 0035): policies left unplaced, two parts depending on each other, a relation turned round", () => {
  const warns = (yaml: string) => loadModel(yaml).findings.map((f) => f.message);
  assert.deepEqual(lab.findings, [], "lab places every policy, and nothing depends both ways");
  assert.ok(warns(LAB.replace(/(\n  book_boxes:\n(?:    why: .*\n)?)    in: [^\n]+\n/, "$1")).some((m) => /^not placed: book_boxes — say `in:`/.test(m)));
  assert.ok(!warns(LAB.replace(/\n    in: [^\n]+/g, "")).some((m) => /not placed/.test(m)), "a model that places none is not asked to");
  // The steps telling each other that one stopped, as before the sample was their hub.
  const peers = LAB.replace("    in: source\n    on: SampleStopped\n    command: \"Sample#${event.sample}.Stop\"", "    in: target\n    on: SampleStopped\n    for_each_referrer: { via: Handling.sample, of: \"${event.sample}\" }\n    command: \"${item}.SampleStopped\"");
  assert.ok(warns(peers).some((m) => /^Bench and Logistics depend on each other — Bench through \w+, Logistics through report_stop: let one only hear the other/.test(m)), warns(peers).join("\n"));
  // The portal's view opened by the lab commanding it, while the portal hears the lab: a cycle.
  assert.ok(warns(policyIn("open_patient_view", "Ordering")).some((m) => /^Ordering and Patient portal depend on each other — Ordering through open_patient_view, Patient portal through \w+/.test(m)));
  // A relation that says the portal is upstream, while the portal hears the lab.
  const turned = LAB.replace("{ upstream: Lab, downstream: Patient portal, pattern: customer-supplier }", "{ upstream: Patient portal, downstream: Lab, pattern: customer-supplier }");
  assert.ok(warns(turned).some((m) => /^relations: Patient portal → Lab \(customer-supplier\) — the policies make Patient portal depend on Lab \(\w+\), not the other way/.test(m)), warns(turned).join("\n"));
});

test("a system in focus (ADR 0036): its context, or its containers in its boundary — and only the parts it talks to", () => {
  const context = c4Of(lab, "context", { systems: ["Lab"], contexts: [] });
  assert.deepEqual(context.nodes.map((n) => `${n.name}:${n.kind}${n.focus ? "*" : ""}`),
    ["Lab:system*", "Patient portal:external", "Hospital information system:external", "Scanners:external"]);
  assert.equal(context.nodes.find((n) => n.name === "Messaging"), undefined, "told only by the portal: no crossing to the focus, left out");
  assert.equal(context.edges.find((e) => e.from === "system:Patient portal"), undefined, "the edge between two neighbours is left out");
  assert.deepEqual(context.boundaries, [], "a system held whole is a box, not a boundary");
  const toPortal = context.edges.find((e) => e.from === "system:Lab" && e.to === "system:Patient portal")!;
  assert.deepEqual([toPortal.patterns, toPortal.downstream], [["customer-supplier"], ["system:Patient portal"]], "the map's relations and its U and D (ADR 0035)");

  const containers = c4Of(lab, "container", { systems: ["Lab"], contexts: [] });
  assert.deepEqual(containers.nodes.filter((n) => n.focus).map((n) => `${n.name} in ${n.boundary} (${n.context})`),
    ["Ordering in Lab (Requests)", "Logistics in Lab (Sample logistics)", "Bench in Lab (Testing)"]);
  assert.deepEqual(containers.boundaries.map((b) => b.name), ["Lab"]);
  assert.ok(containers.edges.some((e) => e.from === "system:Hospital information system" && e.to === "subsystem:Lab/Bench" && e.commands.includes("Analysis.Plan")),
    "a neighbour's message reaches the container that answers it");
  assert.deepEqual(containers.edges.find((e) => e.from === "subsystem:Lab/Bench" && e.to === "subsystem:Lab/Logistics")!.downstream, ["subsystem:Lab/Bench"]);
  const text = c4ToMermaid(containers);
  assert.match(text, /^C4Container\n  title Containers of Lab\n/);
  assert.match(text, /System_Boundary\(boundary_Lab, "Lab"\) \{\n    Container\(subsystem_Lab_Ordering, "Ordering", "context: Requests, team: orders", "the request and its route"\)/);
  assert.match(text, /Rel\(system_Hospital_information_system, subsystem_Lab_Bench, "Analysis.Plan\(\)"\)/);
});

test("a bounded context in focus (ADR 0036): inside its system's boundary, with the sibling parts it talks to by name", () => {
  const context = c4Of(lab, "context", { systems: [], contexts: ["Testing"] });
  assert.deepEqual(context.nodes.map((n) => `${n.name}:${n.kind}${n.focus ? "*" : ""}${n.boundary ? ` in ${n.boundary}` : ""}`),
    ["Testing:context* in Lab", "Logistics:subsystem in Lab", "Hospital information system:external"]);
  assert.equal(context.nodes.find((n) => n.name === "Ordering"), undefined, "a sibling the bench never talks to is left out");
  const containers = c4Of(lab, "container", { systems: [], contexts: ["Testing"] });
  assert.deepEqual(containers.nodes.map((n) => `${n.name}${n.focus ? "*" : ""}`), ["Bench*", "Logistics", "Hospital information system"]);
  assert.match(c4ToMermaid(containers), /UpdateElementStyle\(subsystem_Lab_Logistics, \$bgColor="grey"/, "a neighbour of our own, greyed");
  // The relation declared with the Requests context labels its edge when that context is in focus.
  const requests = c4Of(lab, "context", { systems: [], contexts: ["Requests"] });
  assert.deepEqual(requests.edges.find((e) => e.from === "system:Hospital information system")!.patterns, ["anticorruption-layer"]);
});

test("a focus of several (ADR 0036): an external system in parts, a context across two systems; names checked", () => {
  const scanners = c4Of(lab, "container", { systems: ["Scanners"], contexts: [] });
  assert.deepEqual(scanners.nodes.map((n) => `${n.name}${n.focus ? "*" : ""}${n.external ? " (external)" : ""}`),
    ["Clinic app* (external)", "Courier app* (external)", "Bench scanner* (external)", "Lab"]);
  assert.deepEqual(scanners.boundaries, [{ name: "Scanners", external: true, note: "the scanner vendor — at the clinic, in the courier's hand, at the bench" }]);

  // Two focused at once: the edge between them is drawn, both filled.
  const both = c4Of(lab, "context", { systems: ["Lab", "Patient portal"], contexts: [] });
  assert.ok(both.nodes.filter((n) => n.focus).length === 2 && both.edges.some((e) => e.from === "system:Patient portal" && e.to === "system:Messaging"));

  // A context spanning two systems (ADR 0018 §1) is a box in each.
  const spread = loadModel(withSystems(`systems:
  Front: { context: Shared, subsystems: { Desk: { packages: [Requests, Steps] }, Yard: { packages: [Sites, Transfers, Samples, Deviations, Cool boxes], context: Moving } } }
  Back: { context: Shared, packages: [Analysis] }
  Portal: { external: true, packages: [Patient] }`));
  const shared = c4Of(spread, "context", { systems: [], contexts: ["Shared"] });
  assert.deepEqual(shared.nodes.filter((n) => n.focus).map((n) => n.id), ["context:Front/Shared", "system:Back"], "Back is all Shared: one box; Front only in part");
  assert.ok(shared.nodes.some((n) => n.id === "subsystem:Front/Yard" && !n.focus), "Front's other part, by name");

  assert.throws(() => c4Of(lab, "context", { systems: ["Labb"], contexts: [] }), /no system called `Labb`/);
  assert.throws(() => c4Of(lab, "context", { systems: [], contexts: ["Bench"] }), /no bounded context called `Bench`/);
  assert.throws(() => c4Of(lab, "context", { systems: [], contexts: [] }), /name a system or a bounded context/);
});

test("a part declared before it is modelled (ADR 0037): `packages: []` on purpose, shown as such; a missing list still refused", () => {
  const declared = loadModel(withSystems(`systems:
  Lab:
    subsystems:
      Ordering:  { packages: [Requests, Steps, Sites, Transfers, Samples, Deviations, Cool boxes, Patient] }
      Bench:     { packages: [Analysis] }
      Results:   { packages: [], note: what the doctor reads }
  Archive: { packages: [] }`));
  const results = declared.systems!.subsystems.find((s) => s.name === "Results")!;
  assert.deepEqual([results.unmodelled, results.packages], [true, []]);
  assert.equal(declared.systems!.subsystems.find((s) => s.name === "Bench")!.unmodelled, undefined);
  const inside = contextMap(declared, "subsystem", "Lab");
  assert.equal(inside.nodes.find((n) => n.id === "Results")!.unmodelled, true);
  assert.equal(inside.nodes.find((n) => n.id === "Archive")!.unmodelled, true, "a system of one part, none of it modelled");
  assert.equal(contextMap(declared, "system").nodes.find((n) => n.id === "Lab")!.unmodelled, undefined, "a system with some of it modelled is not");
  const c4 = c4Of(declared, "container", { systems: ["Lab"], contexts: [] });
  assert.ok(c4.nodes.some((n) => n.name === "Results" && n.focus && n.unmodelled), "in focus, though nothing crosses to it");
  assert.match(c4ToMermaid(c4), /Container\(subsystem_Lab_Results, "Results", "context: Lab", "what the doctor reads \(not modelled yet\)"\)/);
  assert.throws(() => loadModel(withSystems("systems:\n  Lab: { subsystems: { Bench: { packages: [Analysis] }, Results: { note: forgotten } } }")),
    /Results: a sub-system lists its `packages` — `packages: \[\]` for one declared before it is modelled/);
});
