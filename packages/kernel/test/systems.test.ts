import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadModel } from "../src/model.ts";
import { choiceOfEvent, contextMap, contextMapToMermaid, placeOf, receiversOfEvent, scopesOf, senderOfCommand } from "../src/systems.ts";

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
