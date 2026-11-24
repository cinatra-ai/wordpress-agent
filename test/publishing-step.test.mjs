// cinatra-ai/cinatra#3745 — the write step is the flow's one publishing step.
//
// On an agent run the application refuses every call of
// `wordpress_site_tool_write` (its registration declares `outward`) unless the
// run's top-level publishing step, `metadata.cinatra.publishes: true`, has a
// person's released publish decision. So the `edit` step declares it, with the
// rows the publish card shows. The application opens that card only after an
// approved artifact review earlier in the same run; `page_review_gate` is that
// review, directly in front of the write.
//
// What this file executes: it reads `cinatra/oas.json` and checks its shape
// against the rules of two readers, the application's compiler
// (cinatra-ai/cinatra, packages/agents/src/oas-compiler.ts,
// `collectPublishingSteps` and `collectPublishRows`) and the pack check
// (cinatra-ai/ci, scripts/agent-publish-gate.mjs).
// What it does not execute: neither reader. This repository has no copy of
// them, so a change to their rules is not seen here; run both against this
// flow before a merge.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(join(root, "cinatra", "oas.json"), "utf8"));
const parts = oas.$referenced_components;

const WRITE_STEP = "edit";
const REVIEW_STEP = "page_review_gate";
const ACTION_KINDS = ["ApiNode", "AgentNode", "FlowNode", "ParallelFlowNode"];
const NO_CONNECTOR_KINDS = ["StartNode", "EndNode", "InputMessageNode", "OutputMessageNode", "BranchingNode"];
const STATUS_LABEL = "Status (if publish, the edit takes it offline as draft)";
const ROWS = [
  { label: "WordPress site", input: "instanceId" },
  { label: "Current title", input: "title" },
  { label: STATUS_LABEL, input: "status" },
  { label: "Requested change", input: "instructions" },
];

const cinatraOf = (component) => component?.metadata?.cinatra ?? {};
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const topLevelIds = () => oas.nodes.map((entry) => entry.$component_ref);

/** Every object in the flow that carries `key` under `metadata.cinatra`. */
function carriersOf(key) {
  const found = [];
  const stack = [["(root)", oas]];
  while (stack.length > 0) {
    const [name, value] = stack.pop();
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const item of value) stack.push([name, item]);
      continue;
    }
    if (has(cinatraOf(value), key)) found.push(value.id ?? name);
    for (const [childKey, child] of Object.entries(value)) stack.push([childKey, child]);
  }
  return found.sort();
}

test("the write step is the one step declared publishes: true, a top-level action node", () => {
  const publishing = topLevelIds().filter((id) => cinatraOf(parts[id]).publishes === true);
  assert.deepEqual(publishing, [WRITE_STEP]);
  assert.ok(ACTION_KINDS.includes(parts[WRITE_STEP].component_type));
  assert.equal(cinatraOf(oas).publishes, undefined, "the flow root declares no publishes");
  assert.notEqual(cinatraOf(parts[WRITE_STEP]).requiresApproval, true, "the publish card is the one approval in front of it");
});

test("the write step is the step that calls the outward write tool", () => {
  const callers = topLevelIds().filter((id) => JSON.stringify(parts[id]).includes("wordpress_site_tool_write"));
  assert.deepEqual(callers, [WRITE_STEP]);
});

test("the publish card shows the site, the current title, the status with its effect and the requested change", () => {
  assert.deepEqual(cinatraOf(parts[WRITE_STEP]).publishRows, ROWS);
  const titles = parts[WRITE_STEP].inputs.map((input) => input.title);
  for (const row of ROWS) {
    assert.ok(titles.includes(row.input), `${row.input} is an input of the write step`);
    assert.ok(row.label.length >= 1 && row.label.length <= 60 && row.label === row.label.trim());
  }
  assert.deepEqual(carriersOf("publishRows"), [WRITE_STEP], "no other component carries publishRows");
});

// The card has no literal values: a row shows one input of the step. So the
// effect of the edit on the live site is the status row: its value is the
// status the read step answered, and its label states the rule the write step
// applies to that same value.
test("the status row shows the value the write step decides the demotion on, under a label that states it", () => {
  const into = oas.data_flow_connections.filter(
    (edge) => edge.destination_node.$component_ref === WRITE_STEP && edge.destination_input === "status",
  );
  assert.deepEqual(
    into.map((edge) => [edge.source_node.$component_ref, edge.source_output]),
    [["read_page", "status"]],
    "the status input comes only from the read step",
  );
  const { system, user } = parts[WRITE_STEP].data;
  assert.ok(user.includes("- status: {{ status }}"), "the write step gets that status");
  assert.ok(
    system.includes("When the status you read in Step 1 is `publish`, also include `status: \"draft\"` in the SAME call"),
    "the write step demotes a post whose status is publish",
  );
  assert.ok(
    system.includes("When the status you read in Step 1 is anything other than `publish`, omit the `status` field."),
    "the write step keeps every other status",
  );
  assert.ok(STATUS_LABEL.includes("publish") && STATUS_LABEL.includes("offline") && STATUS_LABEL.includes("draft"));
});

test("every other step that can reach a connector declares publishes false or is read only", () => {
  for (const id of topLevelIds()) {
    if (id === WRITE_STEP) continue;
    const step = parts[id];
    if (NO_CONNECTOR_KINDS.includes(step.component_type)) continue;
    const cinatra = cinatraOf(step);
    if (cinatra.riskClass === "read_only" && !has(cinatra, "publishes")) continue;
    assert.equal(cinatra.publishes, false, `${id} declares publishes false`);
  }
  assert.equal(cinatraOf(parts.file_page).publishes, false);
  assert.equal(cinatraOf(parts.gather_page_review).publishes, false);
  assert.deepEqual(carriersOf("publishes").filter((id) => cinatraOf(parts[id]).publishes === true), [WRITE_STEP]);
});

test("an approved artifact review comes directly before the write, drawn by the application", () => {
  const into = oas.control_flow_connections.filter((edge) => edge.to_node.$component_ref === WRITE_STEP);
  assert.deepEqual(into.map((edge) => edge.from_node.$component_ref), [REVIEW_STEP]);
  const review = parts[REVIEW_STEP];
  assert.equal(review.component_type, "InputMessageNode");
  const cinatra = cinatraOf(review);
  assert.equal(cinatra.artifactReview?.targetsInput, "reviewTargets");
  assert.ok(review.inputs.some((input) => input.title === "reviewTargets"));
  for (const key of ["renderer", "inputRenderers", "gateRenderer"]) assert.ok(!has(cinatra, key), `the review declares no ${key}`);
  assert.ok(!JSON.stringify(review).includes('"x-renderer"'), "the review selects no field renderer of the pack");
  assert.ok(!has(cinatraOf(oas), "hitlScreens"), "the pack keeps no screen of its own");
});
