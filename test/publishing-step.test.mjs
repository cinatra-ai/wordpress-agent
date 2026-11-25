// cinatra-ai/cinatra#3745 — the write step is the flow's one publishing step.
//
// On an agent run the application serves `wordpress_site_tool_write` (its
// registration declares `outward` and `passthroughStep: "publishing"`) only to
// the run's top-level publishing step, `metadata.cinatra.publishes: true`,
// after a person released its publish decision. So `write_page` declares it,
// with the rows the publish card shows. The application opens that card only
// after an approved artifact review earlier in the same run; `page_review_gate`
// is that review. Between the review and the write, `read_reviewed_page` reads
// back the revision the review approved, and the write step saves only its
// values, with no model in between.
//
// The card is shown only on a run that has a change to save: a request that
// changes nothing ends the run completed by a branch past the filing and the
// review. The site writes only if the post is unchanged since the read; else it
// refuses and writes nothing, so a refusal makes no demotion either.
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

const WRITE_STEP = "write_page";
const REVIEW_STEP = "page_review_gate";
const REVIEWED_READ = "read_reviewed_page";
const READ_TOOL = "wordpress_site_tool_call";
const COMPOSE_STEP = "compose_change";
const ACTION_KINDS = ["ApiNode", "AgentNode", "FlowNode", "ParallelFlowNode"];
const NO_CONNECTOR_KINDS = ["StartNode", "EndNode", "InputMessageNode", "OutputMessageNode", "BranchingNode"];
const STATUS_LABEL = "Status as read (a published post becomes a draft)";
const ROWS = [
  { label: "WordPress site", input: "instanceId" },
  { label: "Page title as read", input: "title" },
  { label: STATUS_LABEL, input: "status" },
  { kind: "artifacts", label: "Reviewed change", input: "reviewedSnapshot" },
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
  const callers = topLevelIds().filter((id) => JSON.stringify(parts[id].data ?? {}).includes("wordpress_site_tool_write"));
  assert.deepEqual(callers, [WRITE_STEP]);
});

test("the publish card shows the site, the title and status as read with the rule of the save, and the reviewed revision", () => {
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
    [["read_page", "post_status"]],
    "the status input comes only from the read step",
  );
  const template = parts[WRITE_STEP].data.input.argsJson;
  assert.ok(template.includes('{% if status == "publish" %}, "status": "draft"{% endif %}'), "the save demotes a post whose status is publish, and keeps every other");
  assert.ok(template.includes('"status": {{ status | tojson }}'), "the status as read is an expected value");
  assert.ok(STATUS_LABEL.includes("published") && STATUS_LABEL.includes("draft"), "the label states the demotion as a rule of the save");
});

// The branches of a run that save nothing. Each one ends the run before the
// card, or is a refusal of the site that writes nothing and so no demotion.
test("a request that changes nothing ends the run completed past the filing, before the card", () => {
  const compose = parts[COMPOSE_STEP];
  const system = collapse(compose.data.system);
  assert.ok(system.includes("answer every `writeFields` member null and the empty string in `error.code` and in `error.message`"));
  assert.equal(system.includes("page_editing_unsupported"), false, "a page can be edited: the site ability writes posts and pages");
  assert.ok(system.includes("the run ends completed with no changes, before anything is filed, reviewed or written"));
  const intoWrite = oas.control_flow_connections.filter((edge) => edge.to_node.$component_ref === WRITE_STEP).map((edge) => edge.from_node.$component_ref);
  assert.deepEqual(intoWrite, [REVIEWED_READ], "the no-change road never reaches the card of the write step");
  assert.equal(has(compose.data, "completed_error_codes"), false, "an error of the compose step ends the run failed");
  const road = topLevelIds();
  assert.ok(road.indexOf(COMPOSE_STEP) < road.indexOf("file_page"), "the compose step comes before the filing");
  assert.ok(road.indexOf("file_page") < road.indexOf(REVIEW_STEP) && road.indexOf(REVIEW_STEP) < road.indexOf(WRITE_STEP));
});

// What this checks: the save is conditional at the site. The ability
// `cinatra/post-update-if-unchanged` compares, under a row lock, the change
// time, the four values as read and the row token with the stored post, and
// writes nothing when one differs (`post_changed`). There is no re-read before
// the write and no window between a check and an unconditional update.
test("the save is made only if the post is unchanged since the read: change time, the four values and the row token", () => {
  const into = (input) =>
    oas.data_flow_connections
      .filter((edge) => edge.destination_node.$component_ref === WRITE_STEP && edge.destination_input === input)
      .map((edge) => [edge.source_node.$component_ref, edge.source_output]);
  assert.deepEqual(into("modified"), [["read_page", "post_modified_gmt"]]);
  assert.deepEqual(into("rowToken"), [["read_page", "row_token"]]);
  const template = parts[WRITE_STEP].data.input.argsJson;
  assert.ok(template.includes('"if_unmodified_since": {{ modified | tojson }}'));
  assert.ok(template.includes('"row_token": {{ rowToken | tojson }}'));
  assert.equal(JSON.stringify(parts[WRITE_STEP].data).includes(READ_TOOL), false, "the write step reads nothing");
  assert.equal(JSON.stringify(oas).includes("ewpa/update-post"), false, "the unconditional update is not used anywhere");
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
