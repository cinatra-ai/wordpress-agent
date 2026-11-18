// cinatra-ai/cinatra#4424 — the lifecycle block names the input that gets a repair run's findings.
//
// A repair run of this template gets the reviewer's findings in the input that this
// package declares in package.json under cinatra.lifecycle.repairFindingsInput. The prompt
// reads the findings from `instructions`, so that is the input the block names. The block
// and the flow's start input have to agree, or a repair run reads the producing run's old
// instructions.
//
// Zero-dependency; runs on plain node:test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const flow = JSON.parse(readFileSync(new URL("../cinatra/oas.json", import.meta.url), "utf8"));
const start = flow.$referenced_components[flow.start_node.$component_ref];
const lifecycle = pkg.cinatra.lifecycle;

test("the lifecycle block is repair capable and names instructions as the findings input", () => {
  assert.deepEqual(lifecycle, {
    repairCapable: true,
    repairFindingsInput: { input: "instructions" },
  });
});

test("the findings input has the shape the application accepts", () => {
  const { input } = lifecycle.repairFindingsInput;
  assert.deepEqual(Object.keys(lifecycle.repairFindingsInput), ["input"]);
  assert.equal(typeof input, "string");
  assert.match(input, /^[A-Za-z_][A-Za-z0-9_]*$/);
  assert.ok(input.length <= 128);
  assert.notEqual(input, "lifecycleRepairRequest");
  assert.ok(!(input in Object.prototype), `${input} is a property name of Object.prototype`);
});

test("the findings input is a required start input of the flow", () => {
  const { input } = lifecycle.repairFindingsInput;
  assert.ok(flow.inputs.some((item) => item.title === input), `${input} is an input of the flow`);
  assert.ok(start.inputs.some((item) => item.title === input), `${input} reaches the start node`);
  assert.ok(start.metadata.cinatra.required.includes(input), `${input} is required at the start node`);
});
