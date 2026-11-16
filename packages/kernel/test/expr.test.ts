import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, explain, template, templateObject } from "../src/expr.ts";

const scope = {
  vars: { total: 100, paid: 40, command: { amount: 60, items: ["a", "b"] }, id: "A1" },
  active: new Set(["fulfilling", "fulfilling.shipping"]),
};

test("arithmetic and comparison", () => {
  assert.equal(evaluate("paid + command.amount >= total", scope).value, true);
  assert.equal(evaluate("paid + 1 >= total", scope).value, false);
  assert.equal(evaluate("total / 4 == 25", scope).value, true);
  assert.equal(evaluate("not (paid > total)", scope).value, true);
  assert.equal(evaluate("paid > 0 and total > 0", scope).value, true);
});

test("in_state tests the whole configuration, not just the leaf", () => {
  assert.equal(evaluate("in_state(fulfilling)", scope).value, true);
  assert.equal(evaluate("in_state(fulfilling.shipping)", scope).value, true);
  assert.equal(evaluate("in_state(cancelled)", scope).value, false);
});

test("a dead reference raises rather than defaulting (A2)", () => {
  assert.throws(() => evaluate("nonsense > 1", scope), /unknown reference `nonsense`/);
  assert.throws(() => evaluate("command.nope", scope), /no `command.nope`/);
});

test("explain reports the values a guard actually saw", () => {
  assert.equal(
    explain(evaluate("paid + command.amount >= total", scope)),
    "paid=40, command.amount=60, total=100",
  );
});

test("a template that is exactly one hole keeps its native type", () => {
  assert.deepEqual(template("${command.items}", scope), ["a", "b"]);
  assert.equal(template("${command.amount}", scope), 60);
  assert.equal(template("Shipment#${id}.Request", scope), "Shipment#A1.Request");
  assert.equal(template("plain text", scope), "plain text");
});

test("holes inside lists and nested objects are filled too", () => {
  assert.deepEqual(
    templateObject({ units: ["${id}"], row: { unit: "${id}", n: "${command.amount}" }, plain: [1, "x"] }, scope),
    { units: ["A1"], row: { unit: "A1", n: 60 }, plain: [1, "x"] },
  );
});
