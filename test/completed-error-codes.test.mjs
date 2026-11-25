// Which error codes end a model step as completed.
//
// A model step (an ApiNode on the application's model bridge) answers a
// failure with a non-empty `error.code`. The application ends the step, and so
// the run, as failed on such an answer, unless the step's data lists the code
// in `completed_error_codes`. Since cinatra#3745 the flow has one model step,
// `compose_change`; the read and the write run without a model, and the
// write's refusals end the run through a branch, with a message built by code
// (`write_outcome`). The model step lists no completed code: a failed compose
// files no page snapshot and ends the run failed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(join(root, "cinatra", "oas.json"), "utf8"));
const parts = oas.$referenced_components;

const LLM_BRIDGE_PATH = "/api/llm-bridge";
const bridgeSteps = Object.values(parts).filter(
  (node) =>
    node.component_type === "ApiNode" &&
    typeof node.url === "string" &&
    node.url.endsWith(LLM_BRIDGE_PATH),
);

test("C1: the flow has one model step, the compose step", () => {
  assert.deepEqual(bridgeSteps.map((node) => node.id), ["compose_change"]);
});

test("C2: the compose step lists no completed code, so a failed compose ends the run failed", () => {
  for (const node of bridgeSteps) {
    assert.equal("completed_error_codes" in node.data, false, `${node.id} lists no completed code`);
  }
});

test("C3: no step that is not on the model bridge carries completed codes", () => {
  for (const node of Object.values(parts)) {
    if (bridgeSteps.includes(node)) continue;
    assert.equal("completed_error_codes" in (node.data ?? {}), false, `${node.id} carries no completed code`);
  }
});
