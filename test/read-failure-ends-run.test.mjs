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
// Three arms: R1 the read step declares the error output, its instructions
// hold the failure contract (Step 0 answers `unsupported_post_type` before any
// WordPress call; the empty code on a success; `unsupported_post_type` for a
// postType rejected in Step 0 and `call_failed` for a failed envelope or a
// missing content field in Step 1) and NOTHING ELSE: the instructions and the
// input template are pinned byte for byte (see below), so no added, changed,
// moved or removed character can forbid, swap or redirect a code, weaken a
// rule for a failed envelope or for missing content, empty the code after a
// failure, invert a condition or tell the step to go on; the rest of the step
// (name, inputs, outputs and their schemas, metadata) is pinned too, the
// step's data holds no other key, and no step but the write step (which
// answers its own codes of the same names, and runs only after the read)
// names those codes; R2 the read step lists no completed code and no model
// step lists a code the read step answers; R3 every step after the read, the
// review, write, output and end steps among them, is reached only through the
// read step (the walk names no step but the read step, so a renamed step
// passes), and every control edge names both of its ends.
//
// R1 is an allow-list over ALL of the text, never a deny-list over classes of
// characters: the only change it forgives is the length of a run of white
// space (space, tab, carriage return, line feed), which collapses to one
// space before the comparison. Case, punctuation, symbols, quotes, backticks,
// list, heading and bold marks, sentence boundaries, letters of every script,
// every other character (any non-ASCII one, zero-width and other-width white
// space included) and any text before, after or between the pinned words
// count: a reformat or a rewording fails on purpose, also when it is
// harmless. Changing the flow's instructions means changing the pinned text
// and its named sha256 below, in the same reviewed diff.
//
// Zero-dependency; runs on plain node:test (`node --test`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(join(root, "cinatra", "oas.json"), "utf8"));
const parts = oas.$referenced_components ?? {};

const LLM_BRIDGE_PATH = "/api/llm-bridge";
const READ = "read_page";
// The write step answers its own codes of the same names; it runs only after the read (R3).
const WRITE = "edit";
// The read step's failure codes, and any spelling of them (a space, hyphen or underscore between the words).
const FAILURE_CODES = ["unsupported_post_type", "call_failed"];
const NAMES_A_FAILURE_CODE = /unsupported[\s_-]*post[\s_-]*type|call[\s_-]*failed/i;

// What R1 compares: runs of space, tab, CR and LF become one space; nothing else is normalised.
const collapse = (text) => text.replace(/[ \t\r\n]+/g, " ");
const sha256Of = (text) => createHash("sha256").update(text, "utf8").digest("hex");
// Where two collapsed texts first differ, for the failure message.
const firstDifference = (got, pinned) => {
  let at = 0;
  while (at < got.length && at < pinned.length && got[at] === pinned[at]) at += 1;
  const cut = (text) => JSON.stringify(text.slice(Math.max(0, at - 30), at + 50));
  return `at character ${at}: the flow has ${cut(got)}, the pin has ${cut(pinned)}`;
};
// Every character outside printable ASCII (white space of the four kinds aside), as code points.
const nonAsciiOf = (text) =>
  [...new Set(text.match(/[^\x20-\x7e\t\r\n]/gu) ?? [])]
    .map((ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`)
    .sort();
// The only non-ASCII character of the read step's texts: the em dash of Step 0 and of Rule 2.
const NON_ASCII_ALLOWED = ["U+2014"];

// The failure contract: the Step 0 sentence, and the success and failure sentences of the result.
const STEP0 =
  "If `postType` is anything other than unset, `\"post\"`, or `\"page\"`, make NO WordPress call at all \u2014 " +
  "answer the result below with `error.code` `\"unsupported_post_type\"`.";
const SUCCESS = "On a successful read, `error` carries the empty string in `code` and in `message`.";
const ASSIGN =
  "On a failure, `title`, `content`, `excerpt`, `status`, `address` and `modified` are the empty string and `error` is `{ code, message }`: " +
  "`code` is `\"unsupported_post_type\"` for a postType rejected in Step 0 and " +
  "`\"call_failed\"` for a failed envelope or a missing content field in Step 1, and `message` is a short plain-language explanation.";

// The pin: the read step's instructions and its input template, one line of the flow's text per item, as the flow
// holds them (the em dash is written as a u-escape, so this file stays ASCII). R1 compares the flow's text with it byte
// for byte once runs of white space are collapsed; the sha256 of the collapsed pinned text is named next to it, so a
// changed pin shows in the diff as a changed text AND a changed digest.
const READ_SYSTEM = [
  "You are the WordPress page reader. Read the specified post (or page) and hand its current fields to the next step. You make no change to the site.",
  "",
  "## How you reach WordPress",
  "",
  "You do not have any `wordpress_post_*` tools. You have exactly one WordPress call primitive, `wordpress_site_tool_call`, which forwards a `toolName` + `args` to the connected site's own MCP ability catalog and returns that ability's raw response UNCHANGED \u2014 an envelope shaped `{ \"success\": boolean, \"data\": {...} }` on success. You also have `wordpress_site_tools_list` to discover the site's catalog, but for this step you never need it \u2014 the two abilities below are always the right ones.",
  "",
  "Call these two abilities, always via `wordpress_site_tool_call` with `instanceId` (from the inputs), `toolName`, and `args`:",
  "- `ewpa/get-post` \u2014 read a post by id. `args: { post_id: <number> }`",
  "- `ewpa/get-page` \u2014 read a page by id. `args: { post_id: <number> }`. Use this INSTEAD of `ewpa/get-post` only when `postType === \"page\"`.",
  "",
  "These two reads are the only WordPress calls this step makes.",
  "",
  "## Rules",
  "",
  "1. **Every `post_id` you send must be a number, not a string.** The inputs give you `postId` as a string (e.g. `\"42\"`) \u2014 convert it before including it in any `args`.",
  "2. **Every response is an envelope: check `success` first.** A response where `success` is not EXACTLY `true` is a failure \u2014 stop and report the error rather than proceeding as if it succeeded. A response missing the `success` key entirely is also a failure, never an implicit success.",
  "3. **Read fields from the envelope's `data` object with this fallback order, and never invent a value for a field that is absent from every name in its list:**",
  "   - id: `data.ID`, then `data.id`, then `data.post_id`",
  "   - title: `data.post_title`, then `data.title`",
  "   - content: `data.post_content`, then `data.content` \u2014 REQUIRED for the diff; if NEITHER key is present, stop and report an error. Never treat missing content as an empty string \u2014 that silently wipes the diff, not just this read.",
  "   - excerpt: `data.post_excerpt`, then `data.excerpt`",
  "   - status: `data.post_status`, then `data.status`",
  "   - address: `data.permalink`, then `data.link` \u2014 the post's own public address; the empty string when neither is present.",
  "   - modified: `data.post_modified_gmt`, then `data.modified_gmt`, then `data.post_modified`, then `data.modified` \u2014 the time the site last changed the post, as the response gives it; the empty string when none is present.",
  "",
  "## Steps",
  "",
  "**STEP 0 \u2014 Validate postType BEFORE any WordPress call:** If `postType` is anything other than unset, `\"post\"`, or `\"page\"`, make NO WordPress call at all \u2014 answer the result below with `error.code` `\"unsupported_post_type\"`. Only unset/`\"post\"` (full edit support) and `\"page\"` (read-only, Rule 6) proceed.",
  "",
  "**STEP 1 \u2014 Load post:** Call `wordpress_site_tool_call` with `toolName: \"ewpa/get-post\"` (or `\"ewpa/get-page\"` when `postType === \"page\"`) and `args: { post_id: <postId as a number> }`. Check `success === true` (Rule 2). Read title/content/excerpt/status/address/modified per Rule 3.",
  "",
  "## The result",
  "",
  "Fill the declared output fields: `postId`, `instanceId` and `postType` as the inputs gave them; `title`, `content`, `excerpt` and `status` exactly as read (Rule 3; the empty string for an absent excerpt); `address` and `modified` per Rule 3; and `error`. On a successful read, `error` carries the empty string in `code` and in `message`. On a failure, `title`, `content`, `excerpt`, `status`, `address` and `modified` are the empty string and `error` is `{ code, message }`: `code` is `\"unsupported_post_type\"` for a postType rejected in Step 0 and `\"call_failed\"` for a failed envelope or a missing content field in Step 1, and `message` is a short plain-language explanation. Never invent a value for a field that is absent from every name in its list.",
].join("\n");
const READ_SYSTEM_SHA256 = "77302b709f6fef8df73e2193c29103a2a9eddac81bb8e089e4078c8e2f9b343d";
const READ_USER = [
  "Read the WordPress post now and fill the declared output fields.",
  "Inputs:",
  "- instanceId: {{ instanceId }}",
  "- postId: {{ postId }}",
  "- postType: {{ postType }}",
  "",
  "Follow the steps in the system instructions.",
].join("\n");
const READ_USER_SHA256 = "67272b24a94ba5c98c55cfcff82b679ba98bbd87c8cf3e66616ce2d9e2a4e1fd";

// The keys of the read step's data: a new key could carry an instruction R1 does not read.
const READ_DATA_KEYS = ["agent_id", "agent_run_id", "cinatra_llm", "system", "user"];
// The rest of the read step (its name, inputs, outputs and their schemas, metadata; the data without the two texts
// and the model choice): a description, default, const or enum there could steer the answer as a sentence could.
const READ_STEP_REST = {
  component_type: "ApiNode",
  id: "read_page",
  name: "Read the page",
  url: "{{CINATRA_BASE_URL}}/api/llm-bridge",
  http_method: "POST",
  data: { agent_id: "wordpress-content-editor", agent_run_id: "{{ agent_run_id }}" },
  inputs: [
    { title: "instanceId", type: "string" },
    { title: "postId", type: "string" },
    { title: "postType", type: "string" },
    { title: "agent_run_id", type: "string" },
  ],
  outputs: [
    { title: "postId", type: "string" },
    { title: "instanceId", type: "string" },
    { title: "postType", type: "string" },
    { title: "title", type: "string" },
    { title: "content", type: "string" },
    { title: "excerpt", type: "string" },
    { title: "status", type: "string" },
    { title: "address", type: "string" },
    { title: "modified", type: "string" },
    { title: "error", type: "object", json_schema: { properties: { code: { type: "string" }, message: { type: "string" } } } },
  ],
  metadata: { cinatra: { riskClass: "read_only", requiresApproval: false, packageName: "@cinatra-ai/wordpress-agent", description: "The agent reads the page." } },
};

// Fails unless `text` is the pinned text byte for byte once runs of white space are collapsed.
const assertPinned = (text, pinned, sha256, what) => {
  const want = collapse(pinned);
  assert.equal(sha256Of(want), sha256, `${what}: the pinned text and its named sha256 belong together (change both, on purpose)`);
  const got = collapse(text);
  assert.ok(
    got === want,
    `${what} are the pinned text byte for byte once runs of white space are collapsed; ` +
      `the flow's text has sha256 ${sha256Of(got)}, the pin names ${sha256}; first difference ${firstDifference(got, want)}`,
  );
};

// Every string of a value, with its path.
const stringsOf = (value, at, out = []) => {
  if (typeof value === "string") out.push([at, value]);
  else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) stringsOf(inner, `${at}/${key}`, out);
  }
  return out;
};

const bridgeSteps = Object.entries(parts).filter(
  ([, node]) =>
    node.component_type === "ApiNode" &&
    typeof node.url === "string" &&
    node.url.endsWith(LLM_BRIDGE_PATH),
);

test("R1: the read step assigns each failure code to its failure condition, by its failure contract alone", () => {
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
  const data = node.data ?? {};
  assert.deepEqual(Object.keys(data).sort(), READ_DATA_KEYS, "the read step's data has no other key");
  assert.equal(typeof data.system, "string", "the read step has its instructions");
  assert.equal(typeof data.user, "string", "the read step has its input template");
  const { system, user, cinatra_llm: llm, ...dataRest } = data;
  assert.deepEqual({ ...node, data: dataRest }, READ_STEP_REST, "the read step's name, inputs, outputs, schemas and metadata are the pinned ones");
  assert.deepEqual(Object.keys(llm ?? {}).sort(), ["preferredModel", "preferredProvider"], "the model choice has its two keys");
  for (const value of Object.values(llm)) assert.match(value, /^[\w.:\/-]+$/, "the model choice holds names only");
  // Any non-ASCII character is named: the em dash of Step 0 and of Rule 2 is the only one the texts may hold.
  assert.deepEqual(nonAsciiOf(data.system), NON_ASCII_ALLOWED, "the instructions hold no non-ASCII character but the em dash");
  assert.deepEqual(nonAsciiOf(data.user), [], "the input template holds no non-ASCII character");
  assert.deepEqual(nonAsciiOf(READ_SYSTEM), NON_ASCII_ALLOWED, "the pinned instructions hold no non-ASCII character but the em dash");
  assert.deepEqual(nonAsciiOf(READ_USER), [], "the pinned input template holds no non-ASCII character");
  const text = collapse(data.system);
  // The contract, named.
  assert.ok(
    text.includes(STEP0),
    "the instructions send a rejected postType to the answer with the code of Step 0, before any WordPress call",
  );
  assert.ok(text.includes(SUCCESS), "a successful read answers the empty code, so a success is never stopped");
  assert.ok(
    text.includes(ASSIGN),
    "the instructions assign unsupported_post_type to a rejected postType and call_failed to a failed envelope or a missing content field",
  );
  assert.equal(text.split(`${SUCCESS} ${ASSIGN}`).length - 1, 1, "the success and failure sentences are one run, in order");
  // The only-instruction half: the whole text is the pinned one, byte for byte once runs of white space are
  // collapsed, so the contract is the only sentence on the codes, the code and message fields, an empty code
  // after a failure or going on after one, and no character, mark or symbol can change what a sentence says.
  assertPinned(data.system, READ_SYSTEM, READ_SYSTEM_SHA256, "the read step's instructions");
  assertPinned(data.user, READ_USER, READ_USER_SHA256, "the read step's input template");
  assert.equal(text.split("call_failed").length - 1, 1, "call_failed occurs once in the read step's instructions, in the assignment");
  assert.equal(
    text.split("unsupported_post_type").length - 1,
    2,
    "unsupported_post_type occurs twice in the read step's instructions, in Step 0 and in the assignment",
  );
  // No step but the read and write steps, and nothing outside the steps, names the read step's failure codes.
  const elsewhere = stringsOf({ ...oas, $referenced_components: { ...parts, [READ]: undefined, [WRITE]: undefined } }, "")
    .filter(([, value]) => NAMES_A_FAILURE_CODE.test(value))
    .map(([at]) => at);
  assert.deepEqual(elsewhere, [], "no text outside the read and write steps names unsupported_post_type or call_failed");
  assert.ok(parts[WRITE], "the write step keeps its id");
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
  // No later step is named here: the walk reads edges only, so a renamed or a
  // new step passes while a bypass of the read does not (the step ids and the
  // nine edges are pinned by S1 of test/page-snapshot-filed-and-reviewed.test.mjs).
  // The allow-list half: nothing but the start itself is reached without the
  // read step, so a new step or edge cannot bypass the read unnamed.
  assert.deepEqual(
    [...seen],
    [startId],
    "no step is reached from the start without passing the read step",
  );
});
