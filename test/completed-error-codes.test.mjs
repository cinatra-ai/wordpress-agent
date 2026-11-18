// Which error codes end a model step as completed.
//
// A model step (an ApiNode on the application's model bridge) answers a
// failure with a non-empty `error.code`. The application ends the step, and so
// the run, as failed on such an answer, unless the step's data lists the code
// in `completed_error_codes`. The write step lists `reread_failed` there: the
// update WAS saved, only its re-read failed, so the run completes and hands
// the `proposalId` on. Every other code of the write step, and every code of
// the read step, ends the run failed: a failed read files no page snapshot.
//
// Three arms: C1 the write step's list; C2 the read and compose steps list
// nothing; C3 each listed code is one the step's own instructions name.

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

test("C1: the write step ends completed on reread_failed and on no other code", () => {
  const node = parts.edit;
  assert.ok(node, "the write step keeps its id");
  assert.deepEqual(
    node.data.completed_error_codes,
    ["reread_failed"],
    "the write step lists exactly reread_failed: the update was saved, only its re-read failed",
  );
  for (const code of ["call_failed", "page_editing_unsupported", "unsupported_post_type"]) {
    assert.equal(
      node.data.completed_error_codes.includes(code),
      false,
      `${code} ends the run failed`,
    );
  }
});

test("C2: the read step and the compose step list no completed code", () => {
  assert.deepEqual(
    bridgeSteps.map((node) => node.id).sort(),
    ["compose_change", "edit", "read_page"],
    "the flow has three model steps",
  );
  for (const node of bridgeSteps.filter((n) => n.id !== "edit")) {
    assert.equal(
      "completed_error_codes" in node.data,
      false,
      `${node.id} lists no completed code, so a failed ${node.id} ends the run failed`,
    );
  }
});

test("C3: each listed code is an error code the step's own instructions name", () => {
  for (const node of bridgeSteps.filter((n) => "completed_error_codes" in n.data)) {
    const codes = node.data.completed_error_codes;
    assert.ok(Array.isArray(codes) && codes.length > 0, `${node.id} lists at least one code`);
    for (const code of codes) {
      assert.equal(typeof code, "string", `${node.id} lists codes as strings`);
      assert.match(code, /^[a-z][a-z0-9_-]*$/, `${node.id} lists the code itself, not a sentence`);
      assert.ok(
        node.data.system.includes(`"code": "${code}"`),
        `${node.id}'s instructions answer ${code} in an error result`,
      );
    }
    assert.ok(
      (node.outputs ?? []).some((output) => output.title === "error"),
      `${node.id} declares the error output its listed codes arrive in`,
    );
  }
});
