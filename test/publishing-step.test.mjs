// cinatra-ai/cinatra#3745 — the write step is the flow's one publishing step.
//
// On an agent run the application refuses every call of
// `wordpress_site_tool_write` (its registration declares `outward`) unless the
// run's top-level publishing step, `metadata.cinatra.publishes: true`, has a
// person's released publish decision. So the `edit` step declares it, with the
// rows the publish card shows. The application opens that card only after an
// approved artifact review earlier in the same run; `page_review_gate` is that
// review. Between the review and the write, `read_reviewed_page` reads back the
// revision the review approved, and the write step saves only its values.
//
// The card is shown only on a run that has a change to save: a request on a
// page ends the run failed at the compose step, and a request that changes
// nothing ends it completed by a branch past the filing and the review, both
// before anything is filed, reviewed or shown on a card. On the card, the
// status row's label states the demotion as a rule of the save, so it is true
// also when a check of the write step stops the run before the save.
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
const REVIEWED_READ = "read_reviewed_page";
const COMPOSE_STEP = "compose_change";
const ACTION_KINDS = ["ApiNode", "AgentNode", "FlowNode", "ParallelFlowNode"];
const NO_CONNECTOR_KINDS = ["StartNode", "EndNode", "InputMessageNode", "OutputMessageNode", "BranchingNode"];
const STATUS_LABEL = "Status (if publish, saving makes it an offline draft)";
const ROWS = [
  { label: "WordPress site", input: "instanceId" },
  { label: "Current title", input: "title" },
  { label: STATUS_LABEL, input: "status" },
  { label: "Requested change", input: "instructions" },
];

const cinatraOf = (component) => component?.metadata?.cinatra ?? {};
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const topLevelIds = () => oas.nodes.map((entry) => entry.$component_ref);
const collapse = (text) => text.replace(/\s+/g, " ");
const section = (text, from, to) => text.split(from)[1]?.split(to)[0] ?? "";

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

test("the publish card shows the site, the current title, the status with the rule of the save and the requested change", () => {
  assert.deepEqual(cinatraOf(parts[WRITE_STEP]).publishRows, ROWS);
  const titles = parts[WRITE_STEP].inputs.map((input) => input.title);
  for (const row of ROWS) {
    assert.ok(titles.includes(row.input), `${row.input} is an input of the write step`);
    assert.ok(row.label.length >= 1 && row.label.length <= 60 && row.label === row.label.trim());
  }
  assert.deepEqual(carriersOf("publishRows"), [WRITE_STEP], "no other component carries publishRows");
});

// The card has no literal values: a row shows one input of the step. So the
// effect of the save on the live site is the status row: its value is the
// status the read step answered, and its label states the rule the write step
// applies to that same value when it saves.
test("the status row shows the value the write step decides the demotion on, under a label that ties it to the save", () => {
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
  const step2 = section(system, "**STEP 2", "**STEP 3");
  assert.ok(
    step2.includes("When the status you read in Step 1 is `publish`, also include `status: \"draft\"` in the SAME call"),
    "the save demotes a post whose status is publish",
  );
  assert.ok(
    step2.includes("When the status you read in Step 1 is anything other than `publish`, omit the `status` field."),
    "the save keeps every other status",
  );
  assert.ok(STATUS_LABEL.startsWith("Status (if publish, saving "), "the label states the demotion as a rule of the save");
  assert.ok(STATUS_LABEL.includes("offline") && STATUS_LABEL.includes("draft"));
});

// The branches of a run that save nothing. Each one either ends the run before
// the card, or is a stop of the write step that makes no write and so no
// demotion.
test("a request on a page ends the run at the compose step, and a request that changes nothing ends it completed past the filing, both before the card", () => {
  const compose = parts[COMPOSE_STEP];
  const system = collapse(compose.data.system);
  assert.ok(system.includes("When `postType` is `page`, answer `error.code` `\"page_editing_unsupported\"`"));
  assert.ok(system.includes("answer every `writeFields` member null and the empty string in `error.code` and in `error.message`"));
  assert.equal(system.includes("nothing_to_change"), false, "a change of nothing is no error");
  assert.ok(system.includes("the run ends completed with no changes, before anything is filed, reviewed or written"));
  const intoWrite = oas.control_flow_connections.filter((edge) => edge.to_node.$component_ref === WRITE_STEP).map((edge) => edge.from_node.$component_ref);
  assert.deepEqual(intoWrite, [REVIEWED_READ], "the no-change road never reaches the card of the write step");
  assert.ok(compose.outputs.some((output) => output.title === "error"), "the compose step answers its error");
  assert.equal(has(compose.data, "completed_error_codes"), false, "an error of the compose step ends the run failed");
  const road = topLevelIds();
  assert.ok(road.indexOf(COMPOSE_STEP) < road.indexOf("file_page"), "the compose step comes before the filing");
  assert.ok(road.indexOf("file_page") < road.indexOf(REVIEW_STEP) && road.indexOf(REVIEW_STEP) < road.indexOf(WRITE_STEP));
  assert.deepEqual(
    oas.control_flow_connections.filter((edge) => edge.from_node.$component_ref === COMPOSE_STEP).map((edge) => edge.to_node.$component_ref),
    ["form_page"],
    "the compose step has one way on, to the derivation of the filed form",
  );
});

test("a stop of the write step makes no write, so it makes no demotion", () => {
  const system = collapse(parts[WRITE_STEP].data.system);
  const step1 = section(system, "**STEP 1", "**STEP 2");
  assert.ok(step1.includes("a check that fails ends this step with the result it names, and NO write is made"));
  assert.ok(step1.includes("return the STOPPED RESULT with `code: \"reviewed_change_unavailable\"`"));
  assert.ok(step1.includes("return the STOPPED RESULT with `code: \"post_changed\"`"));
  assert.ok(step1.includes("return the `page_editing_unsupported` ERROR RESULT"));
  assert.ok(system.includes("NO write was made and a published post STAYS published"));
  assert.ok(system.includes("never a write of its own"), "the demotion rides only on the save");
});

// What this checks: the write step re-reads the post and compares its change
// time and status with the read the review was based on, before the update.
// What it does not give: an atomic save. `ewpa/update-post` takes no expected
// change time or revision, so the update is unconditional and an edit saved on
// the site between this re-read and the update is overwritten.
test("before the save, the write step re-reads the post and stops when it changed during the review; the update itself is unconditional", () => {
  const into = (input) =>
    oas.data_flow_connections
      .filter((edge) => edge.destination_node.$component_ref === WRITE_STEP && edge.destination_input === input)
      .map((edge) => [edge.source_node.$component_ref, edge.source_output]);
  assert.deepEqual(into("modified"), [["read_page", "modified"]], "the change time the review was based on comes from the read step");
  assert.deepEqual(into("status"), [["read_page", "status"]]);
  const step1 = collapse(section(parts[WRITE_STEP].data.system, "**STEP 1", "**STEP 2"));
  assert.ok(step1.includes("call `wordpress_site_tool_call` with `toolName: \"ewpa/get-post\"`"), "Step 1 re-reads the post");
  assert.ok(
    step1.includes(
      "The post is unchanged only when the `modified` handed to you is not empty, the `modified` of this response EXACTLY equals it, and the `status` of this response EXACTLY equals the `status` handed to you.",
    ),
    "Step 1 compares the change time and the status",
  );
  const step2 = section(parts[WRITE_STEP].data.system, "**STEP 2", "**STEP 3");
  assert.equal(step2.includes("wordpress_site_tool_call"), false, "the save step itself reads nothing");
  assert.ok(step2.includes("`args: { post_id, title?, content?, excerpt?, status? }`"), "the update carries no expected change time or revision");
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

test("an approved artifact review comes before the write, with only the read of the reviewed revision between", () => {
  const road = topLevelIds();
  assert.deepEqual(road.slice(road.indexOf(REVIEW_STEP), road.indexOf(WRITE_STEP) + 1), [REVIEW_STEP, REVIEWED_READ, WRITE_STEP]);
  const into = (id) => oas.control_flow_connections.filter((edge) => edge.to_node.$component_ref === id).map((edge) => edge.from_node.$component_ref);
  assert.deepEqual(into(WRITE_STEP), [REVIEWED_READ]);
  assert.deepEqual(into(REVIEWED_READ), [REVIEW_STEP]);
  const between = parts[REVIEWED_READ];
  assert.equal(between.data.tool, "extension_tool", "the step between calls the pack's tool, which reads an artifact and reaches no connector");
  assert.equal(between.data.input.name, "reviewed_change");
  assert.equal(cinatraOf(between).riskClass, "read_only");
  const review = parts[REVIEW_STEP];
  assert.equal(review.component_type, "InputMessageNode");
  const cinatra = cinatraOf(review);
  assert.equal(cinatra.requiresApproval, true, "the review asks a person for the approval");
  assert.equal(cinatra.artifactReview?.targetsInput, "reviewTargets");
  assert.ok(review.inputs.some((input) => input.title === "reviewTargets"));
  for (const key of ["renderer", "inputRenderers", "gateRenderer"]) assert.ok(!has(cinatra, key), `the review declares no ${key}`);
  assert.ok(!JSON.stringify(review).includes('"x-renderer"'), "the review selects no field renderer of the pack");
  assert.ok(!has(cinatraOf(oas), "hitlScreens"), "the pack keeps no screen of its own");
});
