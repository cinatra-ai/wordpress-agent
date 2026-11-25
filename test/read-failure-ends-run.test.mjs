// A read that answers a failure ends the run at the read and files no page.
//
// Since cinatra#3745 the read runs without a model: `read_page` calls the
// connector's read tool with the site ability `cinatra/post-read`, and
// `check_read` (the pack's `reviewed_change` tool, op `page`) takes the answer
// only when it is a successful read of the run's post. Any other answer is
// refused with `post_read_unavailable`: the step and the run fail before the
// model step, so a failed read is never proposed on, filed or written. A
// failure of the call itself (the host or the connector refuses it) fails the
// read step, and so the run, before the check.
//
// Three arms: R1 the check refuses every failed read, whatever its shape, and
// never names the site's own text; R2 no step lists completed codes and the
// read step answers no error that a later step could read as a success; R3
// every step after the read step is reached only through the read step, and
// every control edge names both of its ends.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(join(root, "cinatra", "oas.json"), "utf8"));
const parts = oas.$referenced_components;
const READ = "read_page";
const CHECK = "check_read";
const load = () => import("../cinatra/tools/reviewed-change.mjs");

const call = (answer) => ({
  op: "page",
  ...Object.fromEntries(Object.entries(answer).map(([k, v]) => [k, JSON.stringify(v)])),
  postId: JSON.stringify("42"),
  postType: JSON.stringify(""),
  instanceId: JSON.stringify("wp-prod"),
});

test("R1: the check refuses every failed read, of any shape, and never repeats the site's text", async () => {
  const { extensionTool, PAGE_CODE } = await load();
  assert.equal(PAGE_CODE, "post_read_unavailable");
  const failures = [
    { success: false, code: "not_found", message: "SITE TEXT", data: { current_modified_gmt: null } },
    { success: false, code: "permission_unverified", message: "SITE TEXT" },
    { success: false, code: "Not A Code <b>", message: "SITE TEXT" },
    { success: false },
    { success: null },
    {},
  ];
  for (const answer of failures) {
    await assert.rejects(
      extensionTool({ input: call(answer), ports: {} }),
      (err) =>
        err.name === "ExtensionToolCallRefusal" &&
        err.message.startsWith(`${PAGE_CODE}: no change was written, because `) &&
        !err.message.includes("SITE TEXT") &&
        !err.message.includes("<b>"),
      JSON.stringify(answer),
    );
  }
  const named = await extensionTool({ input: call(failures[0]), ports: {} }).catch((e) => e.message);
  assert.match(named, /\(not_found\)/, "a refusal code of the site's form is named");
});

test("R2: no step lists completed codes, and the read step answers the site's success flag with a false default", () => {
  for (const [id, node] of Object.entries(parts)) {
    assert.equal("completed_error_codes" in (node.data ?? {}), false, `${id} lists no completed code`);
  }
  const success = parts[READ].outputs.find((o) => o.title === "success");
  assert.deepEqual(success, { title: "success", type: "boolean", default: false }, "a missing answer is no success");
  assert.equal(parts[CHECK].data.input.input.op, "page");
});

test("R3: every step after the read step is reached only through the read step, and the read only through the check of the run's inputs", () => {
  const edges = oas.control_flow_connections ?? [];
  const startId = oas.start_node?.$component_ref;
  assert.ok(startId, "the flow names its start node");
  // Fail closed: an edge that names no target or no source is not skipped.
  for (const edge of edges) {
    assert.ok(edge.from_node?.$component_ref && edge.to_node?.$component_ref, `control edge ${edge.name} names both of its ends`);
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
  assert.deepEqual(
    edges.filter((edge) => edge.from_node.$component_ref === startId).map((edge) => edge.to_node.$component_ref),
    ["check_input"],
    "the start leads only to the check of the run's inputs",
  );
  assert.ok(
    edges.some((edge) => edge.from_node.$component_ref === "check_input" && edge.to_node.$component_ref === READ),
    "the check of the run's inputs leads to the read step",
  );
  assert.deepEqual([...seen], [startId, "check_input"], "no step but the check of the inputs is reached from the start without passing the read step");
});
