import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadModel } from "../src/model.ts";
import { contextMap, contextMapToMermaid, placeOf, scopesOf, senderOfCommand } from "../src/systems.ts";

// ADR 0018 and ADR 0020, on the lab example: one system of its own in three sub-systems, a vendor's
// patient portal that runs what the model specifies, a scanner vendor in three parts, two domains.
const LAB = readFileSync(new URL("../../examples/models/lab.yaml", import.meta.url), "utf8");
const lab = loadModel(LAB);

/** The lab model with its `systems:` section replaced (and no contexts or relations). */
function withSystems(yaml: string): string {
  const start = LAB.indexOf("\nsystems:\n");
  const end = LAB.indexOf("\noverview:\n");
  return LAB.slice(0, start) + "\n" + yaml.trim() + "\n" + LAB.slice(end);
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
  assert.deepEqual(edge("Patient portal", "Messaging")!.events, ["PatientInformed"]);
  assert.equal(edge("Patient portal", "Lab"), undefined, "the portal tells the lab nothing");

  const ctx = contextMap(lab, "context");
  assert.ok(ctx.edges.some((e) => e.from === "Hospital information system" && e.to === "Requests" && e.patterns.includes("anticorruption-layer")));
  assert.ok(ctx.edges.some((e) => e.from === "Sample logistics" && e.to === "Testing" && e.events.includes("Received")), "a scan's event reaches the bench's handlings");

  const inside = contextMap(lab, "subsystem", "Lab");
  assert.deepEqual(inside.nodes.filter((n) => n.kind === "subsystem").map((n) => n.id), ["Ordering", "Logistics", "Bench"]);
  assert.ok(inside.nodes.some((n) => n.id === "Patient portal" && n.kind === "external"), "the other systems as wholes");
  assert.throws(() => contextMap(lab, "subsystem", "Messaging"), /needs a system as its scope/);
  assert.deepEqual(scopesOf(lab), ["Lab", "Scanners"], "ours, and a vendor in parts");
  assert.match(contextMapToMermaid(sys), /Lab -->\|"«customer-supplier», RequestCreated/);
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
