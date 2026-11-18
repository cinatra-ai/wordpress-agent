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
// missing content field in Step 1) and NOTHING ELSE: the whole instruction
// text is pinned word for word, so no added, changed or removed sentence can
// forbid, swap or redirect a code, empty the code after a failure or tell the
// step to go on; the rest of the step (name, inputs, outputs and their
// schemas, metadata) is pinned too; and no step but the write step (which
// answers its own codes of the same names, and runs only after the read)
// names those codes; R2 the
// read step lists no completed code and no model step lists a code the read
// step answers; R3 every step after the read, the review, write, output and
// end steps among them, is reached only through the read step (the walk
// names no step but the read step, so a renamed step passes), and every
// control edge names both of its ends.
//
// R1 compares WORDS, not characters: case, white space, line breaks,
// backticks, quotes, bold, heading and list marks and punctuation are
// formatting and may change freely; letters (of any script), digits and the
// operator marks = ! < > ~ are words. A changed word of the read step's
// instructions fails R1 on purpose, also when it is harmless: a reworded
// instruction is a new contract, so the pinned text below changes with it,
// in the same reviewed diff.
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
// The write step answers its own codes of the same names; it runs only after the read (R3).
const WRITE = "edit";
// The read step's failure codes, and any spelling of them (a space, hyphen or underscore between the words).
const FAILURE_CODES = ["unsupported_post_type", "call_failed"];
const NAMES_A_FAILURE_CODE = /unsupported[\s_-]*post[\s_-]*type|call[\s_-]*failed/i;

// The words of a text, in order: what R1 compares.
const wordsOf = (text) =>
  (text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}\p{M}]+(?:[-_][\p{L}\p{N}\p{M}]+)*|[=!<>~]+/gu) ?? []).join(" ");
// The sentences of a text, as words: only to name what differs.
const sentencesOf = (text) => text.split(/\n|(?<=[.!?])\s+/).map(wordsOf).filter((s) => s !== "");

// The failure contract, as words: the Step 0 sentence, and the success and failure sentences of the result.
const STEP0 =
  "step 0 validate posttype before any wordpress call if posttype is anything other than unset post or page " +
  "make no wordpress call at all answer the result below with error code unsupported_post_type";
const SUCCESS = "on a successful read error carries the empty string in code and in message";
const ASSIGN =
  "on a failure title content excerpt status and address are the empty string and error is code message " +
  "code is unsupported_post_type for a posttype rejected in step 0 and " +
  "call_failed for a failed envelope or a missing content field in step 1 " +
  "and message is a short plain-language explanation";

// The read step's whole instructions, as words, one sentence per item.
const READ_SYSTEM = [
  "you are the wordpress page reader",
  "read the specified post or page and hand its current fields to the next step",
  "you make no change to the site",
  "how you reach wordpress",
  "you do not have any wordpress_post tools",
  "you have exactly one wordpress call primitive wordpress_site_tool_call which forwards a toolname args to the connected site s own mcp ability catalog and returns that ability s raw response unchanged an envelope shaped success boolean data on success",
  "you also have wordpress_site_tools_list to discover the site s catalog but for this step you never need it the two abilities below are always the right ones",
  "call these two abilities always via wordpress_site_tool_call with instanceid from the inputs toolname and args",
  "ewpa get-post read a post by id",
  "args post_id < number >",
  "ewpa get-page read a page by id",
  "args post_id < number >",
  "use this instead of ewpa get-post only when posttype === page",
  "these two reads are the only wordpress calls this step makes",
  "rules",
  "1",
  "every post_id you send must be a number not a string the inputs give you postid as a string e g",
  "42 convert it before including it in any args",
  "2",
  "every response is an envelope check success first a response where success is not exactly true is a failure stop and report the error rather than proceeding as if it succeeded",
  "a response missing the success key entirely is also a failure never an implicit success",
  "3",
  "read fields from the envelope s data object with this fallback order and never invent a value for a field that is absent from every name in its list",
  "id data id then data id then data post_id",
  "title data post_title then data title",
  "content data post_content then data content required for the diff if neither key is present stop and report an error",
  "never treat missing content as an empty string that silently wipes the diff not just this read",
  "excerpt data post_excerpt then data excerpt",
  "status data post_status then data status",
  "address data permalink then data link the post s own public address the empty string when neither is present",
  "steps",
  STEP0,
  "only unset post full edit support and page read-only rule 6 proceed",
  "step 1 load post call wordpress_site_tool_call with toolname ewpa get-post or ewpa get-page when posttype === page and args post_id < postid as a number >",
  "check success === true rule 2",
  "read title content excerpt status address per rule 3",
  "the result",
  "fill the declared output fields postid instanceid and posttype as the inputs gave them title content excerpt and status exactly as read rule 3 the empty string for an absent excerpt address per rule 3 and error",
  SUCCESS,
  ASSIGN,
  "never invent a value for a field that is absent from every name in its list",
];
const READ_USER = [
  "read the wordpress post now and fill the declared output fields",
  "inputs",
  "instanceid instanceid",
  "postid postid",
  "posttype posttype",
  "follow the steps in the system instructions",
];
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
    { title: "error", type: "object", json_schema: { properties: { code: { type: "string" }, message: { type: "string" } } } },
  ],
  metadata: { cinatra: { riskClass: "read_only", requiresApproval: false, packageName: "@cinatra-ai/wordpress-agent", description: "The agent reads the page." } },
};

// Fails unless the words of `text` are exactly the pinned sentences; names the sentences that differ.
const assertWords = (text, pinned, what) => {
  const got = sentencesOf(text);
  assert.ok(
    wordsOf(text) === pinned.join(" "),
    `${what} are exactly the pinned instructions; ` +
      `added or changed: ${JSON.stringify(got.filter((s) => !pinned.includes(s)))}; ` +
      `missing or changed: ${JSON.stringify(pinned.filter((s) => !got.includes(s)))}`,
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
  const words = wordsOf(data.system);
  // The contract, named.
  assert.ok(
    words.includes(STEP0),
    "the instructions send a rejected postType to the answer with the code of Step 0, before any WordPress call",
  );
  assert.ok(
    words.includes(SUCCESS),
    "a successful read answers the empty code, so a success is never stopped",
  );
  assert.ok(
    words.includes(ASSIGN),
    "the instructions assign unsupported_post_type to a rejected postType and call_failed to a failed envelope or a missing content field",
  );
  assert.equal(words.split(`${SUCCESS} ${ASSIGN}`).length - 1, 1, "the success and failure sentences are one run, in order");
  // The only-instruction half: the whole text is the pinned one, so the contract is the only sentence on
  // the codes, the code and message fields, an empty code after a failure or going on after one.
  assertWords(data.system, READ_SYSTEM, "the read step's instructions");
  assertWords(data.user, READ_USER, "the read step's input template");
  assert.equal(words.split("call_failed").length - 1, 1, "call_failed occurs once in the read step's instructions, in the assignment");
  assert.equal(
    words.split("unsupported_post_type").length - 1,
    2,
    "unsupported_post_type occurs twice in the read step's instructions, in Step 0 and in the assignment",
  );
  // No step but the read and write steps, and nothing outside the steps, names the read step's failure codes.
  const elsewhere = stringsOf({ ...oas, $referenced_components: { ...parts, [READ]: undefined, [WRITE]: undefined } }, "")
    .filter(([, text]) => NAMES_A_FAILURE_CODE.test(text))
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
  // eight edges are pinned by S1 of test/page-snapshot-filed-and-reviewed.test.mjs).
  // The allow-list half: nothing but the start itself is reached without the
  // read step, so a new step or edge cannot bypass the read unnamed.
  assert.deepEqual(
    [...seen],
    [startId],
    "no step is reached from the start without passing the read step",
  );
});
