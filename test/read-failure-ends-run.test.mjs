// A read that answers a failure ends the run at the read and files no page.
//
// The read step (read_page) is a model step on the application's model
// bridge. On a failed read it answers a non-empty `error.code`:
// `unsupported_post_type` or `call_failed`. The application ends a model step,
// and so the run, as failed when the step answers a non-empty top-level
// `error.code`, unless the step's data lists that code in
// `completed_error_codes`. The read step lists no such code, and it runs
// before the filing step on the one road of the flow, so a failed read files
// no page snapshot.
//
// Three arms: R1 the read step declares the error output and its
// instructions ASSIGN each failure code to its failure condition (a code that
// only occurs somewhere in the text, in a sentence that forbids it for
// example, is no assignment), and answer the empty code on a success; R2 the
// read step lists no completed code and no model step lists a code the read
// step answers; R3 every step after the read, the review, write, output and
// end steps among them, is reached only through the read step, and every
// control edge names both of its ends.
//
// Zero-dependency; runs on plain node:test (`node --test`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(join(root, "cinatra", "oas.json"), "utf8"));
const parts = oas.$referenced_components ?? {};

const LLM_BRIDGE_PATH = "/api/llm-bridge";
const READ = "read_page";
const FAILURE_CODES = ["unsupported_post_type", "call_failed"];
const STEP0_SENTENCE =
  "**STEP 0 \u2014 Validate postType BEFORE any WordPress call:** If `postType` is anything " +
  'other than unset, `"post"`, or `"page"`, make NO WordPress call at all \u2014 answer the ' +
  'result below with `error.code` `"unsupported_post_type"`.';
const SUCCESS_SENTENCE = "On a successful read, `error` carries the empty string in `code` and in `message`.";
const ASSIGN_SENTENCE =
  "On a failure, `title`, `content`, `excerpt`, `status` and `address` are the empty string " +
  "and `error` is `{ code, message }`: " +
  '`code` is `"unsupported_post_type"` for a postType rejected in Step 0 and ' +
  '`"call_failed"` for a failed envelope or a missing content field in Step 1, ' +
  "and `message` is a short plain-language explanation.";
// Matches a sentence that names `code` or a failure code. In the read step's
// instructions exactly three sentences do, in this order: the Step 0 sentence
// (the code of Step 0), the success sentence (the empty code) and the
// assignment (the code of Step 0 and the code of Step 1).
const NAMES_A_CODE = new RegExp(`\\bcode\\b|\\b(?:${FAILURE_CODES.join("|")})\\b`);

const bridgeSteps = Object.entries(parts).filter(
  ([, node]) =>
    node.component_type === "ApiNode" &&
    typeof node.url === "string" &&
    node.url.endsWith(LLM_BRIDGE_PATH),
);

// The sentences of a text: each line is cut after a full stop that is followed by white space.
const sentencesOf = (text) =>
  text
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .flatMap((line) => line.trim().split(/(?<=\.)\s+/))
    .filter((sentence) => sentence !== "");

test("R1: the read step assigns each failure code to its failure condition", () => {
  const node = parts[READ];
  assert.ok(node, "the read step keeps its id");
  assert.ok(
    bridgeSteps.some(([id]) => id === READ),
    "the read step is a model step on the bridge, where a failure code ends the step",
  );
  const error = (node.outputs ?? []).find((output) => output.title === "error");
  assert.ok(error, "the read step declares an error output");
  assert.equal(error.type, "object", "the error output is an object");
  assert.equal(
    error.json_schema?.properties?.code?.type,
    "string",
    "the error output carries a string code",
  );
  const sentences = sentencesOf(node.data?.system ?? "");
  assert.ok(
    sentences.includes(SUCCESS_SENTENCE),
    "a successful read answers the empty code, so a success is never stopped",
  );
  assert.ok(
    sentences.includes(STEP0_SENTENCE),
    "the instructions send a rejected postType to the answer with the code of Step 0, before any WordPress call",
  );
  assert.ok(
    sentences.includes(ASSIGN_SENTENCE),
    "the instructions assign unsupported_post_type to a rejected postType and call_failed to a failed envelope or a missing content field",
  );
  // The allow-list half: the sentences that name `code` or a failure code are
  // exactly the three above, so no other sentence can forbid, redirect or swap a code.
  assert.deepEqual(
    sentences.filter((sentence) => NAMES_A_CODE.test(sentence)),
    [STEP0_SENTENCE, SUCCESS_SENTENCE, ASSIGN_SENTENCE],
    "no sentence besides the Step 0 sentence, the success sentence and the assignment names the code",
  );
});

test("R2: the read step lists no completed code and no model step lists a read failure code", () => {
  const read = parts[READ];
  assert.ok(read, "the read step keeps its id");
  assert.equal(
    "completed_error_codes" in (read.data ?? {}),
    false,
    "the read step lists no completed code, so a failure code of the read ends the run failed",
  );
  assert.ok(bridgeSteps.length > 0, "the flow has model steps");
  for (const [id, node] of bridgeSteps) {
    const listed = node.data?.completed_error_codes ?? [];
    for (const code of FAILURE_CODES) {
      assert.equal(
        listed.includes(code),
        false,
        `${id} does not list ${code} as a completed code`,
      );
    }
  }
});

test("R3: every step after the read step is reached only through the read step", () => {
  const edges = oas.control_flow_connections ?? [];
  const startId = oas.start_node?.$component_ref;
  assert.ok(startId, "the flow names its start node");
  // Fail closed: an edge that names no target or no source is not skipped.
  for (const edge of edges) {
    assert.ok(
      edge.from_node?.$component_ref && edge.to_node?.$component_ref,
      `control edge ${edge.name} names both of its ends`,
    );
  }
  // Every node reachable from the start without passing the read step.
  const seen = new Set([startId]);
  const queue = [startId];
  while (queue.length > 0) {
    const from = queue.shift();
    for (const edge of edges) {
      if (edge.from_node.$component_ref !== from) continue;
      const to = edge.to_node.$component_ref;
      if (to === READ || seen.has(to)) continue;
      seen.add(to);
      queue.push(to);
    }
  }
  assert.ok(
    edges.some((edge) => edge.from_node.$component_ref === startId && edge.to_node.$component_ref === READ),
    "the start leads to the read step",
  );
  for (const step of [
    "compose_change",
    "file_page",
    "gather_page_review",
    "page_review_gate",
    "edit",
    "emit_output",
    "end",
  ]) {
    assert.ok(parts[step], `${step} keeps its id`);
  }
  // The allow-list half: nothing but the start itself is reached without the
  // read step, so a new step or edge cannot bypass the read unnamed.
  assert.deepEqual(
    [...seen],
    [startId],
    "no step is reached from the start without passing the read step",
  );
});
