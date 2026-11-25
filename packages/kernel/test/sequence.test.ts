import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadModel } from "../src/model.ts";
import { createWorld, send } from "../src/engine.ts";
import { PERSON } from "../src/systems.ts";
import { lifelineNamed, lifelinesOf, listText, messageText, openAt, sequenceOf, sequenceToMermaid, type Sequence, type SequenceItem, type SequenceView } from "../src/sequence.ts";
import { parseScenario, runScenario } from "../../scenarios/src/index.ts";
import { fileURLToPath } from "node:url";
import { readScenario } from "../../scenarios/src/files.ts";

// ADR 0022, on the lab example (ADR 0018, ADR 0020): one system of its own in three sub-systems, a
// vendor's patient portal that runs what the model specifies, a scanner vendor in three parts, two domains.
const lab = loadModel(readFileSync(new URL("../../examples/models/lab.yaml", import.meta.url), "utf8"));
const run = (name: string) =>
  runScenario(lab, readScenario(fileURLToPath(new URL(`../../examples/scenarios/lab/${name}.yaml`, import.meta.url))), { kind: "fifo" });
const lines = lifelinesOf(lab);
const at = (depth: Parameters<typeof openAt>[1], more: string[] = []): SequenceView => ({ open: [...openAt(lines, depth), ...more] });
const sequence = (name: string, view: SequenceView) => { const r = run(name); return sequenceOf(lab, r.world.log, view, r.marks); };

/** Every item, frames walked into. */
function all(items: SequenceItem[]): SequenceItem[] {
  return items.flatMap((i) => (i.kind === "frame" ? [i, ...all(i.items)] : [i]));
}
const messages = (s: Sequence) => all(s.items).filter((i): i is Extract<SequenceItem, { kind: "message" }> => i.kind === "message");
const said = (items: SequenceItem[]) => items.map((i) =>
  i.kind === "message" ? `${i.from} → ${i.to}: ${messageText(i)}` : i.kind === "note" ? `[${i.text}]` : `{${i.frame} ${i.label}${i.folded ? ", folded" : ""}}`);

test("the tree a lifeline opens down: domain → system → sub-system → aggregate; one child is opened through", () => {
  assert.deepEqual(lines.nodes["domain:Diagnostics"]!.children, ["system:Lab", "system:Patient portal"]);
  assert.deepEqual(lines.nodes["system:Lab"]!.children, ["subsystem:Lab/Ordering", "subsystem:Lab/Logistics", "subsystem:Lab/Bench"]);
  assert.deepEqual(lines.nodes["subsystem:Lab/Bench"]!.children, ["aggregate:Analysis"]);
  // A vendor's portal of one part, running what the model specifies: straight to its aggregate.
  assert.deepEqual(lines.nodes["system:Patient portal"]!.children, ["aggregate:PatientView"]);
  // A vendor in parts opens into them; a part that sends is a lifeline of its own.
  assert.deepEqual(lines.nodes["system:Scanners"]!.children, ["subsystem:Scanners/Clinic app", "subsystem:Scanners/Courier app", "subsystem:Scanners/Bench scanner"]);
  assert.deepEqual(lines.nodes["subsystem:Scanners/Clinic app"]!.children, []);
  // Entities are inside their aggregate: no lifeline of their own.
  assert.ok(!lines.nodes["aggregate:SiteTask"] && !lines.nodes["aggregate:AnalysisHandling"]);
  // A context is a band where it says more than the system's name; not a level.
  assert.equal(lines.nodes["subsystem:Lab/Logistics"]!.band, "Sample logistics");
  assert.equal(lines.nodes["system:Lab"]!.band, undefined, "three contexts: no one band for the system");
  assert.equal(lifelineNamed(lines, "Bench"), "subsystem:Lab/Bench");
  assert.throws(() => lifelineNamed(lines, "Nowhere"), /no domain, system, sub-system or aggregate/);
  assert.deepEqual(openAt(lines, "domain"), []);
  assert.deepEqual(openAt(lines, "system").sort(), ["domain:Diagnostics", "domain:Hospital"]);
});

test("a run in causal order: each arrow, the steps it set off inside, then what they set off; the set-up folded", () => {
  const s = sequence("02-haemolysed-at-the-lab", at("system"));
  const [planning, toTheLab] = s.items;
  assert.ok(planning?.kind === "frame" && planning.frame === "section" && planning.label === "Planning");
  assert.deepEqual(said(planning.items), ["{setup set-up, folded}"]);
  const setup = planning.items[0];
  assert.ok(setup?.kind === "frame" && setup.messages === 12);   // the sites, included (ADR 0029), then the plan
  assert.ok(toTheLab?.kind === "frame" && toTheLab.label === "To the lab");
  assert.deepEqual(said(toTheLab.items).slice(0, 4), [
    "system:Scanners → system:Lab: Sample.Scan · Collected · CLIN1 · S3",
    "[2 steps inside Lab]",
    "system:Lab → system:Patient portal: Collected → PatientView.Collected",
    "system:Patient portal → system:Messaging: PatientInformed [about = collected]",
  ]);
  assert.ok(!s.participants.includes("system:Hospital information system"), "only in the folded set-up");
  assert.ok(messages(s).some((m) => m.from === PERSON && m.label.endsWith(".Confirm")), "a deviation confirmed by lab staff: no system sends it");
  assert.ok(!messages(s).some((m) => m.from === m.to), "nothing inside a lifeline is an arrow");

  const open = sequence("02-haemolysed-at-the-lab", { ...at("system"), toggled: ["setup"] });
  assert.ok(said(messages(open)).includes("system:Hospital information system → system:Lab: Request.Create"));
  // What the lab's Ordering works out itself is a step inside it, never from a person (ADR 0030).
  const links = (view: SequenceView) => messages(sequence("01-two-tubes-to-the-lab", { ...view, toggled: ["setup"] })).filter((m) => m.label === "Route.Link");
  assert.deepEqual([...new Set(links(at("system")).map((m) => `${m.from} → ${m.to}`))], ["system:Lab → system:Lab"]);
  assert.deepEqual([...new Set(links(at("system", ["system:Lab"])).map((m) => `${m.from} → ${m.to}`))], ["subsystem:Lab/Ordering → subsystem:Lab/Ordering"]);
  assert.deepEqual([...new Set(links(at("system", ["system:Lab", "subsystem:Lab/Ordering"])).map((m) => `${m.from} → ${m.to}`))], ["aggregate:Route → aggregate:Route"]);
  const mermaid = sequenceToMermaid(s);
  assert.match(mermaid, /box transparent Diagnostics\n  participant system_Lab as Lab\n  participant system_Patient_portal as Patient portal\n  end/);
  assert.match(mermaid, /Note over [^:]+: ▸ set-up · 12 messages, folded/);
});

test("one lifeline opened, the others whole: the Lab's sub-systems talk, the vendors stay one lifeline", () => {
  const s = sequence("02-haemolysed-at-the-lab", at("system", ["system:Lab"]));
  assert.ok(["subsystem:Lab/Logistics", "subsystem:Lab/Bench", "system:Patient portal", "system:Scanners"].every((p) => s.participants.includes(p)));
  assert.ok(!s.participants.includes("system:Lab"), "opened: drawn as its sub-systems");
  assert.equal(s.lifelines["subsystem:Lab/Bench"]!.parent, "system:Lab");
  assert.ok(messages(s).some((m) => m.from === "subsystem:Lab/Logistics" && m.to === "subsystem:Lab/Bench" && m.label.startsWith("Received → ")));
  // Its sub-systems side by side, whatever order they first speak in.
  const mine = s.participants.map((p, i) => [p, i] as const).filter(([p]) => s.lifelines[p]!.parent === "system:Lab").map(([, i]) => i);
  assert.equal(mine[mine.length - 1]! - mine[0]!, mine.length - 1);
  // A policy commands aggregates (ADR 0012 §4); what an aggregate then sends its own entities is inside it.
  const deep = sequence("02-haemolysed-at-the-lab", at("aggregate"));
  for (const m of messages(deep)) assert.ok(deep.lifelines[m.to]!.kind !== "subsystem" || deep.lifelines[m.to]!.external, `${m.label}: an aggregate opens no further`);
  assert.ok(!messages(deep).some((m) => m.style === "event" && (m.label.endsWith(".Plan") || m.label.endsWith(".Expect"))));
  assert.match(sequenceToMermaid(s), /box transparent Diagnostics \/ Lab/);
});

test("an event told to the part its payload chooses (ADR 0031): only that one, and the arrow says it is a choice", () => {
  const s = sequence("01-two-tubes-to-the-lab", { ...at("system", ["system:Messaging"]), toggled: ["setup"] });
  const told = messages(s).filter((m) => m.event === "PatientInformed");
  // The updates on the way by text, the order and the results by e-mail: each to one part, never both.
  assert.deepEqual(told.map((m) => `${m.to}: ${m.label}`), [
    "subsystem:Messaging/Mail service: PatientInformed [about = ordered]",
    "subsystem:Messaging/Text gateway: PatientInformed [about = collected]",
    "subsystem:Messaging/Text gateway: PatientInformed [about = in transit]",
    "subsystem:Messaging/Text gateway: PatientInformed [about = at the lab]",
    "subsystem:Messaging/Mail service: PatientInformed [about = results ready]",
  ]);
  assert.deepEqual(told[0]!.choice, { by: "about = ordered", among: ["Text gateway", "Mail service"] });
  assert.match(sequenceToMermaid(s), /alt about = ordered — one of Text gateway, Mail service\n\s+\S+--\)subsystem_Messaging_Mail_service: PatientInformed \[about = ordered\]\n\s+end/);
  // An event every receiver hears whatever it carries is no choice.
  assert.ok(messages(s).filter((m) => m.event && m.event !== "PatientInformed").every((m) => m.choice === undefined));
});

test("a vendor opened into its parts (ADR 0020 §3, §4): the payload says which part sent a scan", () => {
  const s = sequence("02-haemolysed-at-the-lab", { ...at("system", ["system:Scanners"]), fold: false });
  const from = new Set(messages(s).filter((m) => m.command === "Sample.Scan").map((m) => m.from));
  assert.deepEqual([...from].sort(), ["subsystem:Scanners/Bench scanner", "subsystem:Scanners/Clinic app", "subsystem:Scanners/Courier app"]);
  assert.ok(s.participants.includes("system:Lab"), "the Lab still whole");
  const domain = sequence("02-haemolysed-at-the-lab", at("domain"));
  assert.ok(domain.participants.includes("domain:Diagnostics") && !domain.participants.includes("system:Lab"));
});

test("what the receiver ignored is left out, and counted — where it would have crossed", () => {
  const lab_ = at("system", ["system:Lab"]);
  // At system level the bench's handlings ignoring a scan stay inside the Lab: nothing to leave out.
  assert.equal(sequence("01-two-tubes-to-the-lab", at("system")).hidden.ignored, 0);
  const s = sequence("01-two-tubes-to-the-lab", lab_);
  assert.ok(s.hidden.ignored > 0);
  const shown = sequence("01-two-tubes-to-the-lab", { ...lab_, ignored: true, fold: false });
  assert.equal(shown.hidden.ignored, 0);
  assert.equal(messages(shown).length - messages(sequence("01-two-tubes-to-the-lab", { ...lab_, fold: false })).length, s.hidden.ignored);
  assert.match(sequenceToMermaid(s), new RegExp(`%% left out: ${s.hidden.ignored} arrows of commands their receiver ignored`));
});

// A shop: an order's lines reserved one by one (a model loop), noted once in a ledger (another command).
const shop = loadModel(`
context: T
aggregates:
  Order:
    creators: [Place]
    initial: open
    states:
      open:
        on:
          Place: { emit: [ Placed: { order: "\${id}", lines: "\${command.lines}" } ] }
  Item:
    creators: [Reserve, Count]
    initial: reserved
    states:
      reserved:
        on:
          Reserve: {}
          Count: {}
  Ledger:
    creators: [Note]
    initial: open
    states: { open: { on: { Note: {} } } }
policies:
  reserve:
    on: Placed
    for_each: event.lines
    command: "Item#\${item}.Reserve"
  note:
    on: Placed
    command: "Ledger#L.Note"
packages:
  Selling: [Order]
  Stock: [Item, Ledger]
systems:
  Shop: { packages: [Selling] }
  Warehouse: { packages: [Stock] }
  Web: { external: true, sends: [Order.Place, Item.Count] }
`);
function shopRun() {
  const w = createWorld(shop, "2026-01-01T09:00:00Z", { kind: "fifo" });
  send(w, "Order#O1.Place", { lines: ["A", "B"] });
  send(w, "Order#O2.Place", { lines: ["C", "D"] });
  send(w, "Item#A.Count", {});
  send(w, "Item#B.Count", {});
  return w.log;
}
const shopAt = (view: Partial<SequenceView> = {}) => sequenceOf(shop, shopRun(), { open: openAt(lifelinesOf(shop), "system"), ...view });

test("folded: a model loop is one arrow in a loop frame, the run's repeats a dashed one, a bare repeat ×n", () => {
  const s = shopAt();
  assert.deepEqual(said(s.items), ["{repeat repeated for O1, O2, folded}", "system:Web → system:Warehouse: Item.Count ×2"]);
  const [repeat] = s.items;
  assert.ok(repeat?.kind === "frame");
  assert.equal(repeat.messages, 8);
  // Different commands are never folded together: the ledger's note is an arrow of its own.
  assert.deepEqual(said(repeat.items), [
    "system:Web → system:Shop: Order.Place",
    "{loop for each of lines ×2, folded}",
    "system:Shop → system:Warehouse: Placed → Ledger.Note",
  ]);
  const loop = repeat.items[1]!;
  assert.ok(loop.kind === "frame");
  assert.deepEqual(said(loop.items), ["system:Shop → system:Warehouse: Placed → Item.Reserve"]);
  const folded = loop.items[0]!;
  assert.ok(folded.kind === "message");
  assert.deepEqual(folded.instances, ["Item#A", "Item#B", "Item#C", "Item#D"], "the arrow stands for every iteration of every repeat");
  assert.equal(folded.seqs.length, 4);
  // What it is, by name, for whoever explains it: the event, the command it became, the policy between.
  assert.deepEqual([folded.event, folded.command, folded.policy], ["Placed", "Item.Reserve", "reserve"]);
  const input = repeat.items[0]!;
  assert.ok(input.kind === "message" && input.command === "Order.Place" && input.event === undefined, "an input is a command, set off by no event");
  assert.match(sequenceToMermaid(s), /loop repeated for O1, O2\n    system_Web->>system_Shop: Order.Place\n    loop for each of lines ×2\n      system_Shop--\)system_Warehouse: Placed → Item.Reserve\n    end/);
});

test("each fold opens where it stands; --unfold opens them all", () => {
  const s = shopAt({ toggled: ["f1"] });
  const [repeat] = s.items;
  assert.ok(repeat?.kind === "frame" && !repeat.folded);
  assert.equal(repeat.items.filter((i) => i.kind === "message" && i.label === "Order.Place").length, 2);
  const count = shopAt({ toggled: [(shopAt().items[1] as { fold: string }).fold] }).items[1]!;
  assert.ok(count.kind === "frame" && count.frame === "repeat" && !count.folded && count.items.length === 2);
  const flat = shopAt({ fold: false });
  assert.ok(!all(flat.items).some((i) => i.kind === "frame"));
  assert.equal(messages(flat).length, 10);
});

test("the picture compared is the one drawn: a loop stays a loop with its lifelines opened", () => {
  const s = shopAt({ open: openAt(lifelinesOf(shop), "aggregate") });
  const loops = all(s.items).filter((i) => i.kind === "frame" && i.frame === "loop");
  assert.ok(loops.length > 0);
  assert.ok(messages(s).some((m) => m.from === "aggregate:Order" && m.to === "aggregate:Item"));
});

test("an arrow says the fields the model declares, and the instances it reached (ADR 0032)", () => {
  const s = sequence("01-two-tubes-to-the-lab", { ...at("system"), toggled: ["setup"] });
  const said_ = messages(s).map(messageText);
  // A scan's event and site, and its sample; a route's samples, a roll-up of its tubes.
  assert.ok(said_.includes("Sample.Scan · Collected · CLIN1 · S1"));
  assert.ok(said_.includes("Route.Plan · LAB1 · S1, S2"));
  // Alike scans fold into one arrow, which lists every sample it stands for.
  assert.ok(said_.includes("Sample.Scan · Packed · CLIN1 · S1, S2"), "a fold lists its samples");
  // A roll-up of many stays short: the first three, then how many more.
  assert.equal(listText(["S1", "S2", "S3", "S4", "S5", "S2"]), "S1, S2, S3 +2");

  // Nothing declared: a command shows the fields its senders are narrowed by, and no ids.
  const LAB = readFileSync(new URL("../../examples/models/lab.yaml", import.meta.url), "utf8");
  const bare = loadModel(LAB.replace(/\nsequence:\n  label:\n(    .*\n)+/, "\n"));
  assert.equal(bare.sequenceLabels, undefined);
  const r = runScenario(bare, readScenario(fileURLToPath(new URL("../../examples/scenarios/lab/01-two-tubes-to-the-lab.yaml", import.meta.url))), { kind: "fifo" });
  const plain = messages(sequenceOf(bare, r.world.log, at("system"), r.marks)).map(messageText);
  assert.ok(plain.includes("Sample.Scan · Collected"), "the event: what tells its senders apart");

  const refused = (yaml: string, message: RegExp) => assert.throws(() => loadModel(LAB.replace(/\nsequence:\n  label:\n(    .*\n)+/, `\nsequence:\n  label:\n    ${yaml}\n`)), message);
  refused("Sample.Fly: [event]", /Sample answers no command `Fly`/);
  refused("Route.Plan: [colour]", /`colour` is not among its fields \(request, lab, priority, tubes, instructions\), nor `id`/);
  refused("Nothing: [x]", /`Nothing` is no command \(Type.Command\) and no event the model raises/);
  refused("PatientInformed: [colour]", /`colour` is not among its fields \(about\)/);
  refused("Sample.Scan: []", /name the fields its arrow shows/);
});

// ADR 0038: a policy drawn where it runs. Billing runs the reservation between the shop and the
// warehouse; the shop notes the order itself; the warehouse hears the order for its picking list; the
// receipt is placed nowhere.
const placed = loadModel(`
context: T
aggregates:
  Order:
    creators: [Place]
    initial: open
    states:
      open:
        on:
          Place: { emit: [ Placed: { order: "\${id}", lines: "\${command.lines}" } ] }
  Invoice:
    creators: [Open]
    initial: open
    states: { open: { on: { Open: {} } } }
  Item:
    creators: [Reserve]
    initial: reserved
    states: { reserved: { on: { Reserve: {} } } }
  Ledger:
    creators: [Note]
    initial: open
    states: { open: { on: { Note: {} } } }
  PickList:
    creators: [Add]
    initial: open
    states: { open: { on: { Add: {} } } }
  Receipt:
    creators: [Print]
    initial: open
    states: { open: { on: { Print: {} } } }
policies:
  reserve:
    in: Billing
    on: Placed
    for_each: event.lines
    command: "Item#\${item}.Reserve"
  note:
    in: source
    on: Placed
    command: "Ledger#L.Note"
  pick:
    in: target
    on: Placed
    command: "PickList#P.Add"
  receipt:
    on: Placed
    command: "Receipt#R.Print"
packages:
  Selling: [Order]
  Invoicing: [Invoice]
  Stock: [Item, Ledger, PickList]
  Printing: [Receipt]
systems:
  Shop: { packages: [Selling] }
  Billing: { packages: [Invoicing] }
  Warehouse: { packages: [Stock] }
  Printer: { packages: [Printing] }
`);
const placedAt = (depth: "system" | "aggregate") => {
  const w = createWorld(placed, "2026-01-01T09:00:00Z", { kind: "fifo" });
  send(w, "Order#O1.Place", { lines: ["A", "B"] });
  return sequenceOf(placed, w.log, { open: openAt(lifelinesOf(placed), depth), fold: false });
};
const arrows = (s: Sequence) => messages(s).map((m) => `${m.style === "command" ? "->>" : "--)"} ${m.from} → ${m.to}: ${m.label}`);

test("a policy is drawn where it runs (ADR 0038): run by a third, the event to it and the command from it; run where raised, the command alone", () => {
  const s = placedAt("system");
  const lines = arrows(s);
  // Billing runs the reservation for the other two: the order is heard there, once, then each line commanded.
  assert.ok(lines.includes("--) system:Shop → system:Billing: Placed"), "the event, to the part that runs the policy");
  assert.equal(lines.filter((l) => l === "->> system:Billing → system:Warehouse: Item.Reserve").length, 2, "a command from there, per line");
  const heard = messages(s).find((m) => m.to === "system:Billing")!;
  assert.deepEqual([heard.event, heard.policy], ["Placed", "reserve"]);
  // In causal order (ADR 0022): what the heard event caused follows it — both commands, nothing between.
  const i = lines.indexOf("--) system:Shop → system:Billing: Placed");
  assert.deepEqual(lines.slice(i + 1, i + 3), ["->> system:Billing → system:Warehouse: Item.Reserve", "->> system:Billing → system:Warehouse: Item.Reserve"]);
  // Run where the event was raised (fan-in): the event stays inside the shop, only the command crosses.
  assert.ok(lines.includes("->> system:Shop → system:Warehouse: Ledger.Note"));
  // Run by the part it commands (fan-out): the event crosses, as before.
  assert.ok(lines.includes("--) system:Shop → system:Warehouse: Placed → PickList.Add"));
  // Placed nowhere: drawn as before, the event becoming the command.
  assert.ok(lines.includes("--) system:Shop → system:Printer: Placed → Receipt.Print"));
  assert.match(sequenceToMermaid(s), /system_Billing->>system_Warehouse: Item\.Reserve/);
});

test("opened down to its aggregates, a part that runs a policy for two others shows it a lifeline of its own (ADR 0038)", () => {
  const lines = lifelinesOf(placed);
  assert.deepEqual(lines.nodes["system:Billing"]!.children, ["aggregate:Invoice", "policies:Billing/Billing"]);
  assert.equal(lines.nodes["system:Warehouse"]!.children.some((c) => c.startsWith("policies:")), false, "the warehouse runs only its own");
  const said_ = arrows(placedAt("aggregate"));
  assert.ok(said_.includes("--) aggregate:Order → policies:Billing/Billing: Placed"));
  assert.ok(said_.includes("->> policies:Billing/Billing → aggregate:Item: Item.Reserve"));
  assert.ok(said_.includes("->> aggregate:Order → aggregate:Ledger: Ledger.Note"), "run where raised: on the raiser's lifeline");
});

test("the lab's placed policies in its sequence (ADR 0038): run where raised, a command; run by the part it commands, an event", () => {
  const lines = arrows(sequence("01-two-tubes-to-the-lab", { open: openAt(lifelinesOf(lab), "subsystem"), fold: false }));
  // The request's part registers the samples itself (in: Ordering): only the command reaches Logistics.
  assert.ok(lines.includes("->> subsystem:Lab/Ordering → subsystem:Lab/Logistics: Sample.Register"));
  assert.ok(!lines.some((l) => l.includes("RequestCreated → Sample.Register")));
  // The bench asks the site itself (in: Bench).
  assert.ok(lines.some((l) => /^->> subsystem:Lab\/Bench → subsystem:Lab\/Logistics: \w+\.Describe$/.test(l)));
  // Each part hears the sample's scans for its own handlings (in: target): the event crosses, as before.
  assert.ok(lines.some((l) => /^--\) subsystem:Lab\/Logistics → subsystem:Lab\/(Ordering|Bench): Received → /.test(l)));
});
