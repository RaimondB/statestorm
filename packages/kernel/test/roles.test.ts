import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadModel } from "../src/model.ts";
import { roleOfCommand, roleOfType, senderOfCommand } from "../src/systems.ts";

// ADR 0027, on the lab example: three roles — Collecting, Carrying, Testing — each played by one of
// the scanner vendor's apps.
const LAB = readFileSync(new URL("../../examples/models/lab.yaml", import.meta.url), "utf8");
const lab = loadModel(LAB);
const scan = (event: string) => ({ scanId: "s", event, site: "x", reason: "" });

/** The lab model with its `roles:` section replaced. */
function withRoles(yaml: string, systems = LAB): string {
  const start = systems.indexOf("\nroles:\n");
  const end = systems.indexOf("\ndomains:\n");
  return systems.slice(0, start) + "\n" + yaml.trim() + "\n" + systems.slice(end);
}

test("an event's owner is the role whose contract holds its command; a type's, the role it is worked in", () => {
  assert.equal(roleOfCommand(lab, "Sample", "Scan", scan("Received"))?.name, "Testing");
  assert.equal(roleOfCommand(lab, "Sample", "Scan", scan("PickedUp"))?.name, "Carrying");
  assert.equal(roleOfCommand(lab, "Request", "Create", {}), undefined, "the hospital's command: no role sends it");
  // A subtype is worked where its supertype is; a task in no role's list is its activity's (the overview's).
  assert.equal(roleOfType(lab, "CourierRun")?.name, "Carrying");
  assert.equal(roleOfType(lab, "Analysis")?.name, "Testing");
  assert.equal(roleOfType(lab, "TransferTask"), undefined);
  // The part that plays a role sends what the role sends (ADR 0027 §2).
  assert.equal(senderOfCommand(lab, "Sample", "Scan", scan("Received"))?.name, "Bench scanner");
  assert.deepEqual(lab.systems!.subsystems.find((s) => s.name === "Courier app")?.plays, ["Carrying"]);
  assert.ok(!lab.findings.some((f) => /role/.test(f.message)), "every lab role is played");
});

test("another part can play a role: only `plays:` changes", () => {
  const other = LAB.replace("Courier app:   { plays: [Carrying] }", "Courier app:   { note: retired, receives: [PatientInformed] }")
    .replace("  Messaging:\n", "  Courier co:\n    external: true\n    plays: [Carrying]\n  Messaging:\n");
  const m = loadModel(other);
  assert.equal(senderOfCommand(m, "Sample", "Scan", scan("PickedUp"))?.name, "Courier co");
  assert.equal(roleOfCommand(m, "Sample", "Scan", scan("PickedUp"))?.name, "Carrying", "the owner is unchanged");
});

test("the loader holds the roles: types, one owner per event and per type, who plays them", () => {
  const refused = (yaml: string, message: RegExp) => assert.throws(() => loadModel(yaml), message);
  refused(withRoles("roles:\n  A: { works: [Nowhere] }"), /roles.A.works: there is no type called `Nowhere`/);
  refused(withRoles("roles:\n  Collecting: { works: [SiteVisit] }\n  Carrying: { works: [Transfer] }\n  Testing: { works: [Analysis, SiteVisit] }"),
    /`SiteVisit` is already worked in role Collecting/);
  refused(withRoles("roles:\n  Collecting: { works: [SiteVisit], sends: [{ Sample.Scan: { event: [Collected] } }] }\n  Carrying: { works: [Transfer], sends: [Sample.Scan] }\n  Testing: { works: [Analysis] }"),
    /Sample.Scan is sent by role Collecting too/);
  refused(withRoles("roles:\n  Collecting: {}\n  Carrying: { works: [Transfer] }\n  Testing: { works: [Analysis] }"), /a role says what it `works` or what it `sends`/);
  refused(LAB.replace("Clinic app:    { plays: [Collecting] }", "Clinic app:    { plays: [Gardening] }"), /there is no role called `Gardening`/);
  refused(LAB.replace("Bench:     { context: Testing, packages: [Analysis] }", "Bench:     { context: Testing, packages: [Analysis], plays: [Testing] }"), /unknown key|plays/);
  const unplayed = loadModel(LAB.replace("Bench scanner: { plays: [Testing] }", "Bench scanner: { receives: [PatientInformed] }"));
  assert.ok(unplayed.findings.some((f) => /role Testing: no part plays it/.test(f.message)));
});
