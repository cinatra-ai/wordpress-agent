// cinatra-ai/cinatra#3745 — the read and the write run without a model.
//
// The flow reads the post with the site ability `cinatra/post-read` through
// the connector's read tool, `wordpress_site_tool_call`, in a step that calls
// the tool directly on the host's passthrough road (no model). One model step,
// `compose_change`, proposes the new values from that read; it declares no
// tool. After the review, the flow's one publishing step, `write_page`, calls
// the connector's write tool, `wordpress_site_tool_write`, once, with
// `cinatra/post-update-if-unchanged`: its arguments are templates over the
// step's inputs, rendered with `tojson`, and each input comes by exactly one
// data edge, from the read or from the read-back of the reviewed revision.
// The site writes only if the post is unchanged since that read (its change
// time, the four values and the row token). A `post_changed` answer takes the
// run back to the read; every other refusal ends the run with a plain message.
//
// What this file executes: the shape of cinatra/oas.json, the pack's
// `reviewed_change` tool (ops `page` and `outcome`) with fake inputs, and the
// write step's `argsJson` template, rendered by a small renderer below that
// copies the runtime's rules for the constructs the template uses (comments,
// `{% if %}`, `tojson`; `tojson` is the pack's `tojsonText`, the runtime's
// form: keys in their order, separators ", " and ": ", non-ASCII and the
// characters < > & ' as \u escapes). What it does not
// execute: the host's passthrough road, the connector, the site and the flow
// runtime.
//
// Zero-dependency; runs on plain node:test (`node --test`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(join(root, "cinatra", "oas.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const parts = oas.$referenced_components;

const PASSTHROUGH = "{{CINATRA_BASE_URL}}/api/agents/passthrough";
const BRIDGE = "/api/llm-bridge";
const READ_STEP = "read_page";
const INPUT_STEP = "check_input";
const CHECK_STEP = "check_read";
const MODEL_STEP = "compose_change";
const REVIEWED_READ = "read_reviewed_page";
const WRITE_STEP = "write_page";
const OUTCOME_STEP = "write_outcome";
const ROUTE_STEP = "route_write";
const REVIEW_STEP = "page_review_gate";
const READ_TOOL = "wordpress_site_tool_call";
const WRITE_TOOL = "wordpress_site_tool_write";
const READ_ABILITY = "cinatra/post-read";
const WRITE_ABILITY = "cinatra/post-update-if-unchanged";
const REFUSAL_CODES = [
  "site_policy_conflict",
  "permission_unverified",
  "post_locked",
  "unsupported_status",
  "invalid",
  "empty_content",
  "transaction_conflict",
  "not_found",
  "unsupported_storage",
  "db_error",
];
const TOKEN = "a".repeat(64);

const cinatraOf = (component) => component?.metadata?.cinatra ?? {};
const sourcesOf = (node, input) =>
  oas.data_flow_connections
    .filter((e) => e.destination_node.$component_ref === node && e.destination_input === input)
    .map((e) => [e.source_node.$component_ref, e.source_output]);
const controlFrom = (node) => oas.control_flow_connections.filter((e) => e.from_node.$component_ref === node);
const controlInto = (node) =>
  oas.control_flow_connections.filter((e) => e.to_node.$component_ref === node).map((e) => e.from_node.$component_ref);
const titles = (list) => (list ?? []).map((entry) => entry.title);
const load = () => import("../cinatra/tools/reviewed-change.mjs");
const tool = await load();

/** Every node the control flow reaches from `from` without passing through `avoid`. */
function reachable(from, avoid) {
  const seen = new Set([from]);
  const stack = [from];
  while (stack.length > 0) {
    const node = stack.pop();
    for (const edge of controlFrom(node)) {
      const next = edge.to_node.$component_ref;
      if (next === avoid || seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return seen;
}

// --- a renderer for the constructs the write template uses --------------------

/**
 * Jinja's `tojson` as the flow runtime runs it: the pack's own `tojsonText`,
 * the ONE function that also measures the write's text before the review
 * (json.dumps without sorted keys, separators ", " and ": ", ASCII output,
 * then < > & ' as \u escapes; F23 pins it to Python's own output).
 */
function tojson(value) {
  return tool.tojsonText(value);
}
/** Jinja's `int`: a whole number from a text or a number, else 0. */
function toInt(value) {
  if (typeof value === "number") return Math.trunc(value);
  const text = String(value ?? "").trim();
  if (/^[+-]?\d+$/.test(text)) return Number.parseInt(text, 10);
  const f = Number.parseFloat(text);
  return Number.isFinite(f) && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text) ? Math.trunc(f) : 0;
}
function evalExpr(expr, vars) {
  const parts = expr.trim().split("|").map((s) => s.trim());
  const name = parts.shift();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`unsupported expression ${expr}`);
  if (!Object.prototype.hasOwnProperty.call(vars, name)) throw new Error(`undeclared variable ${name}`);
  let value = vars[name];
  let rendered = null;
  for (const filter of parts) {
    if (filter === "int") value = toInt(value);
    else if (filter === "tojson") rendered = tojson(value);
    else throw new Error(`unsupported filter ${filter}`);
  }
  return rendered ?? String(value ?? "");
}
function truthy(cond, vars) {
  const eq = cond.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*==\s*"([^"]*)"$/);
  if (eq) return vars[eq[1]] === eq[2];
  const name = cond.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`unsupported condition ${cond}`);
  if (!Object.prototype.hasOwnProperty.call(vars, name)) throw new Error(`undeclared variable ${name}`);
  const v = vars[name];
  return !(v === "" || v === null || v === undefined || v === false || v === 0 || (Array.isArray(v) && v.length === 0));
}
function render(template, vars) {
  let text = template.replace(/\{#[\s\S]*?#\}/g, "");
  if (/\{%(?![\s]*(if|endif))/.test(text)) throw new Error("unsupported statement");
  text = text.replace(/\{%\s*if\s+([^%]+?)\s*%\}([\s\S]*?)\{%\s*endif\s*%\}/g, (_, cond, body) => (truthy(cond, vars) ? body : ""));
  if (text.includes("{%")) throw new Error("nested or unclosed statement");
  return text.replace(/\{\{([^}]+)\}\}/g, (_, expr) => evalExpr(expr, vars));
}
/** The template references of a text: each `{{ name ... }}` and `{% if name %}` name, comments included. */
const referencedNames = (template) =>
  new Set([...template.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)/g), ...template.matchAll(/\{%\s*if\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]));

// --- the read is model-free and comes first -------------------------------------

test("F1 the read step calls cinatra/post-read through the connector's read tool on the passthrough road, without a model", () => {
  const read = parts[READ_STEP];
  assert.equal(read.component_type, "ApiNode");
  assert.equal(read.url, PASSTHROUGH, "the read step calls the host's passthrough road, not the model bridge");
  assert.equal(read.data.tool, READ_TOOL);
  assert.equal(read.data.input.toolName, READ_ABILITY);
  assert.equal(read.data.input.instanceId, "{{ instanceId }}");
  assert.equal(Object.prototype.hasOwnProperty.call(read.data.input, "args"), false, "the arguments go as JSON text only");
  const args = JSON.parse(render(read.data.input.argsJson, { postId: 42 }));
  assert.deepEqual(args, { post_id: 42 }, "the validated post id is sent as a number, rendered by tojson");
  assert.equal(/\|\s*int\b/.test(read.data.input.argsJson), false, "no coercing filter in front of the call");
  assert.equal(cinatraOf(read).riskClass, "read_only");
  assert.equal(Object.prototype.hasOwnProperty.call(read.data, "system"), false, "no model instructions");
  for (const name of ["success", "code", "post_id", "post_title", "post_content", "post_excerpt", "post_status", "post_type", "post_modified_gmt", "permalink", "row_token"]) {
    assert.ok(titles(read.outputs).includes(name), `the read step outputs the ability's ${name}`);
  }
});

test("F2 the read and its check precede the model step, which the run reaches only through them", () => {
  assert.deepEqual(controlFrom("start").map((e) => e.to_node.$component_ref), [INPUT_STEP]);
  assert.deepEqual(controlFrom(INPUT_STEP).map((e) => e.to_node.$component_ref), [READ_STEP]);
  assert.deepEqual(controlInto(CHECK_STEP), [READ_STEP]);
  assert.deepEqual(controlInto(MODEL_STEP), [CHECK_STEP]);
  assert.equal(reachable("start", READ_STEP).has(MODEL_STEP), false, "no road to the model step bypasses the read");
  assert.equal(reachable("start", CHECK_STEP).has(MODEL_STEP), false, "no road to the model step bypasses the check of the read");
  for (const input of ["title", "content", "excerpt", "status", "modified"]) {
    assert.deepEqual(sourcesOf(MODEL_STEP, input), [[CHECK_STEP, input]], `the model sees the ${input} as read`);
  }
});

test("F3 the flow has one model step; it declares no tool and names no write", () => {
  const bridge = Object.values(parts).filter((n) => n.component_type === "ApiNode" && typeof n.url === "string" && n.url.endsWith(BRIDGE));
  assert.deepEqual(bridge.map((n) => n.id), [MODEL_STEP], "compose_change is the one step on the model bridge");
  const model = parts[MODEL_STEP];
  assert.deepEqual(cinatraOf(model).tools, [], "the model step declares the empty tool list: the host serves it no tool");
  assert.deepEqual(model.data.toolbox_ids, [], "and no toolbox");
  const text = JSON.stringify(model.data);
  for (const word of [WRITE_TOOL, READ_TOOL, WRITE_ABILITY, "ewpa/update-post"]) {
    assert.equal(text.includes(word), false, `the model step's data does not name ${word}`);
  }
  assert.equal(cinatraOf(model).riskClass, "read_only");
});

// --- the check of the read --------------------------------------------------------

const readAnswer = (over = {}) => ({
  success: true,
  post_id: 42,
  post_title: "Opening hours",
  post_content: "<p>We are open Monday to Friday.</p>",
  post_excerpt: "",
  post_status: "publish",
  post_type: "page",
  post_modified_gmt: "2026-11-20 10:00:00",
  permalink: "https://example.org/opening-hours/",
  row_token: TOKEN,
  ...over,
});
/** The check step's call as the flow renders it: each read value as JSON text, the run's post id and type hint. */
const pageCall = (answer, run = {}) => ({
  op: "page",
  ...Object.fromEntries(Object.entries(answer).map(([k, v]) => [k, JSON.stringify(v)])),
  postId: JSON.stringify(run.postId ?? "42"),
  postType: JSON.stringify(run.postType ?? "post"),
  instanceId: JSON.stringify("wp-prod"),
});
const refusedWith = (code) => (err) =>
  err instanceof Error && err.name === "ExtensionToolCallRefusal" && err.message.startsWith(`${code}: `) && !err.message.includes("\n");

test("F4 the check of the read accepts a successful read of a post or a page and hands the values on as read", async () => {
  const { extensionTool } = await load();
  const out = await extensionTool({ input: pageCall(readAnswer()), ports: {} });
  assert.equal(out.ok, true);
  assert.equal(out.postId, "42");
  assert.equal(out.postType, "page", "the type comes from the read; the run's hint post does not stop a page");
  assert.equal(out.title, "Opening hours");
  assert.equal(out.content, "<p>We are open Monday to Friday.</p>");
  assert.equal(out.excerpt, "");
  assert.equal(out.status, "publish");
  assert.equal(out.modified, "2026-11-20 10:00:00");
  assert.equal(out.address, "https://example.org/opening-hours/");
  assert.equal(out.rowToken, TOKEN);
  assert.deepEqual(out.error, { code: "", message: "" });
});

test("F5 the check of the read refuses a failed read, another post, another type, a status the site does not write and a malformed token", async () => {
  const { extensionTool } = await load();
  const cases = [
    [{ success: false, code: "not_found", message: "x", data: {} }, {}],
    [{ success: false, code: "permission_unverified" }, {}],
    [{}, {}],
    [readAnswer({ success: "true" }), {}],
    [readAnswer({ post_id: 43 }), {}],
    [readAnswer(), { postId: "4.2" }],
    [readAnswer({ post_type: "attachment" }), {}],
    [readAnswer(), { postType: "product" }],
    [readAnswer({ post_status: "pending" }), {}],
    [readAnswer({ post_status: "trash" }), {}],
    [readAnswer({ post_modified_gmt: "" }), {}],
    [readAnswer({ row_token: "abc" }), {}],
    [readAnswer({ post_content: null }), {}],
  ];
  for (const [answer, run] of cases) {
    await assert.rejects(extensionTool({ input: pageCall(answer, run), ports: {} }), refusedWith("post_read_unavailable"), JSON.stringify(answer).slice(0, 80));
  }
});

// --- the publishing step ------------------------------------------------------------

test("F6 the write step is the one publishing step: top-level, model-free, one call of the write tool with cinatra/post-update-if-unchanged", () => {
  const write = parts[WRITE_STEP];
  const publishing = Object.entries(parts).filter(([, n]) => cinatraOf(n).publishes === true).map(([k]) => k);
  assert.deepEqual(publishing, [WRITE_STEP], "write_page is the only step that declares publishes: true");
  assert.ok(oas.nodes.some((n) => n.$component_ref === WRITE_STEP), "it is a top-level node");
  assert.equal(write.component_type, "ApiNode");
  assert.equal(write.id, WRITE_STEP);
  assert.equal(write.url, PASSTHROUGH, "it calls the passthrough road, not the model bridge");
  assert.equal(write.data.tool, WRITE_TOOL, "the tool name is a literal");
  assert.equal(write.data.input.toolName, WRITE_ABILITY);
  assert.equal(write.data.input.instanceId, "{{ instanceId }}");
  assert.deepEqual(Object.keys(write.data.input).sort(), ["argsJson", "instanceId", "toolName"]);
  assert.equal(Object.prototype.hasOwnProperty.call(write.data, "system"), false);
  assert.deepEqual(cinatraOf(write).confirmations, [{ tool: WRITE_TOOL, decision: "publish" }]);
  assert.equal(cinatraOf(write).requiresApproval, false, "the publish card is the one approval in front of it");
  for (const [key, node] of Object.entries(parts)) {
    if (key === WRITE_STEP) continue;
    assert.equal(JSON.stringify(node.data ?? {}).includes(WRITE_TOOL), false, `${key} does not call the write tool`);
  }
});

const READ_INPUTS = { postId: "post_id", modified: "post_modified_gmt", title: "post_title", content: "post_content", excerpt: "post_excerpt", status: "post_status", rowToken: "row_token" };
const REVIEWED_INPUTS = ["reviewedTitle", "reviewedTitleSet", "reviewedContent", "reviewedExcerpt", "reviewedRevisionId", "reviewedSnapshot"];

test("F7 every argument is a template over a declared input, and each input is fed by exactly one edge, from the read or from the reviewed revision", () => {
  const write = parts[WRITE_STEP];
  const declared = new Set(titles(write.inputs));
  const template = write.data.input.argsJson;
  for (const name of referencedNames(template)) assert.ok(declared.has(name), `the template names the declared input ${name}`);
  for (const name of declared) {
    if (name === "agent_run_id" || name === "instanceId") continue;
    assert.ok(referencedNames(template).has(name), `${name} appears in the template, so the runtime's input scanner finds it`);
  }
  for (const name of declared) assert.equal(sourcesOf(WRITE_STEP, name).length, 1, `${name} has exactly one incoming edge`);
  for (const [input, output] of Object.entries(READ_INPUTS)) {
    assert.deepEqual(sourcesOf(WRITE_STEP, input), [[READ_STEP, output]], `${input} comes from the read's ${output}, as read`);
  }
  for (const input of REVIEWED_INPUTS) {
    assert.deepEqual(sourcesOf(WRITE_STEP, input), [[REVIEWED_READ, input]], `${input} comes from the read-back of the reviewed revision`);
  }
  assert.deepEqual(sourcesOf(WRITE_STEP, "instanceId"), [[INPUT_STEP, "instanceId"]], "the site comes from the validated input");
  assert.equal(
    oas.data_flow_connections.some((e) => e.destination_node.$component_ref === WRITE_STEP && e.source_node.$component_ref === MODEL_STEP),
    false,
    "no value of the model step reaches the write step",
  );
  assert.ok(!/\{\{[^}]*\}\}"/.test(template.replace(/\{#[\s\S]*?#\}/g, "")) && !/"\{\{/.test(template.replace(/\{#[\s\S]*?#\}/g, "")), "no value is placed inside quotes by hand");
  for (const m of template.replace(/\{#[\s\S]*?#\}/g, "").matchAll(/\{\{([^}]+)\}\}/g)) {
    assert.match(m[1], /\|\s*tojson\s*$/, `each rendered value ends in tojson: ${m[1].trim()}`);
  }
});

const writeVars = (over = {}) => ({
  instanceId: "wp-prod",
  postId: 42,
  modified: "2026-11-20 10:00:00",
  title: 'Opening "hours"',
  content: "<p>We are open Monday to Friday.</p>\n<p>Tom & Jerry's</p>",
  excerpt: "",
  status: "draft",
  rowToken: TOKEN,
  reviewedTitle: "",
  reviewedTitleSet: false,
  reviewedContent: "<p>We are open Monday to Saturday \u{1F600} é.</p>\n<p>Tom & Jerry's</p></script>",
  reviewedExcerpt: "",
  reviewedRevisionId: "revision-2",
  reviewedSnapshot: [{ artifactId: "artifact-7", representationRevisionId: "revision-2" }],
  agent_run_id: "run-1",
  ...over,
});

test("F8 the rendered argsJson carries all five expected values with the row token, the change time, and only the reviewed values byte for byte", () => {
  const template = parts[WRITE_STEP].data.input.argsJson;
  const vars = writeVars();
  const args = JSON.parse(render(template, vars));
  assert.deepEqual(Object.keys(args.expected).sort(), ["content", "excerpt", "row_token", "status", "title"]);
  assert.deepEqual(args.expected, { title: vars.title, content: vars.content, excerpt: "", status: "draft", row_token: TOKEN });
  assert.equal(args.post_id, 42);
  assert.equal(args.if_unmodified_since, vars.modified);
  assert.equal(args.content, vars.reviewedContent, "the reviewed content, byte for byte after the JSON round trip");
  assert.equal("title" in args, false, "a field the review does not change is not sent");
  assert.equal("excerpt" in args, false);
  assert.equal("status" in args, false, "a draft stays a draft");
  assert.deepEqual(Object.keys(args).sort(), ["content", "expected", "if_unmodified_since", "post_id"]);
});

test("F9 a published post is moved to draft in the same save; a title change alone sends the title alone", () => {
  const template = parts[WRITE_STEP].data.input.argsJson;
  const published = JSON.parse(render(template, writeVars({ status: "publish" })));
  assert.equal(published.status, "draft");
  assert.equal(published.expected.status, "publish", "the expected status stays the status as read");
  const titleOnly = JSON.parse(render(template, writeVars({ reviewedTitle: "New \"title\" <b>", reviewedTitleSet: true, reviewedContent: "" })));
  assert.deepEqual(Object.keys(titleOnly).sort(), ["expected", "if_unmodified_since", "post_id", "title"]);
  assert.equal(titleOnly.title, 'New "title" <b>');
});

test("F10 the publish card shows the site, the page title and status as read, and the reviewed revision", () => {
  assert.deepEqual(cinatraOf(parts[WRITE_STEP]).publishRows, [
    { label: "WordPress site", input: "instanceId" },
    { label: "Page title as read", input: "title" },
    { label: "Status as read (a published post becomes a draft)", input: "status" },
    { kind: "artifacts", label: "Reviewed change", input: "reviewedSnapshot" },
  ]);
  const snapshot = parts[WRITE_STEP].inputs.find((i) => i.title === "reviewedSnapshot");
  assert.equal(snapshot.type, "array", "the artifacts row reads a list of revisions");
});

// --- the answer and its branches ------------------------------------------------------

test("F11 the answer is read by a model-free step, and every refusal code has its own branch", () => {
  assert.deepEqual(controlFrom(WRITE_STEP).map((e) => e.to_node.$component_ref), [OUTCOME_STEP]);
  assert.equal(parts[OUTCOME_STEP].url, PASSTHROUGH);
  assert.equal(parts[OUTCOME_STEP].data.tool, "extension_tool");
  assert.equal(parts[OUTCOME_STEP].data.input.name, "reviewed_change");
  assert.equal(parts[OUTCOME_STEP].data.input.input.op, "outcome");
  assert.deepEqual(controlFrom(OUTCOME_STEP).map((e) => e.to_node.$component_ref), [ROUTE_STEP]);
  assert.deepEqual(sourcesOf(ROUTE_STEP, "next"), [[OUTCOME_STEP, "next"]]);
  const route = parts[ROUTE_STEP];
  assert.equal(route.component_type, "BranchingNode");
  for (const code of ["written", "post_changed", ...REFUSAL_CODES]) {
    assert.equal(route.mapping[code], code, `${code} maps to its own branch`);
    assert.ok(route.branches.includes(code));
    const edges = controlFrom(ROUTE_STEP).filter((e) => e.from_branch === code);
    assert.equal(edges.length, 1, `the branch ${code} has one edge`);
  }
  const target = (branch) => controlFrom(ROUTE_STEP).find((e) => e.from_branch === branch).to_node.$component_ref;
  assert.equal(target("post_changed"), READ_STEP, "post_changed returns to the read");
  assert.equal(target("written"), "emit_output");
  for (const code of REFUSAL_CODES) assert.equal(target(code), "emit_output", `${code} ends the run with its message`);
  assert.equal(target("default"), "emit_output");
});

test("F12 after post_changed the review shows a notice that the post changed and the change was proposed again", () => {
  assert.deepEqual(sourcesOf(REVIEW_STEP, "reviewNotice"), [[OUTCOME_STEP, "reviewNotice"]]);
  const input = parts[REVIEW_STEP].inputs.find((i) => i.title === "reviewNotice");
  assert.equal(input.default, "", "the first review shows no notice");
  assert.equal(cinatraOf(parts[REVIEW_STEP]).surfaceGateInputs, true, "the review shows its inputs");
});

const outcomeCall = (answer, over = {}) => ({
  op: "outcome",
  ...Object.fromEntries(Object.entries(answer).map(([k, v]) => [k, JSON.stringify(v)])),
  postId: JSON.stringify("42"),
  instanceId: JSON.stringify("wp-prod"),
  title: JSON.stringify("Opening hours"),
  content: JSON.stringify("<p>Old</p>"),
  excerpt: JSON.stringify(""),
  status: JSON.stringify("publish"),
  address: JSON.stringify("https://example.org/opening-hours/"),
  reviewedTitle: JSON.stringify(""),
  reviewedContent: JSON.stringify("<p>New</p>"),
  reviewedExcerpt: JSON.stringify(""),
  reviewedRevisionId: JSON.stringify("revision-2"),
  ...over,
});
const saved = (over = {}) => ({
  success: true,
  post_id: 42,
  post_title: "Opening hours",
  post_content: "<p>New</p>",
  post_excerpt: "",
  post_status: "draft",
  post_modified_gmt: "2026-11-20 10:05:00",
  sanitized_fields: [],
  ...over,
});

test("F13 a save answers the stored values as the changes, the demotion and a correlation id; a filtered field is named", async () => {
  const { extensionTool } = await load();
  const out = await extensionTool({ input: outcomeCall(saved()), ports: {} });
  assert.equal(out.next, "written");
  assert.deepEqual(out.changes, [
    { field: "content", before: "<p>Old</p>", after: "<p>New</p>" },
    { field: "status", before: "publish", after: "draft" },
  ]);
  assert.equal(out.proposalId, "wp-42-revision-2");
  assert.deepEqual(out.error, {});
  assert.equal(out.reviewNotice, "");
  const filtered = await extensionTool({ input: outcomeCall(saved({ post_content: "<p>New!</p>", sanitized_fields: ["post_content"] })), ports: {} });
  assert.equal(filtered.changes[0].after, "<p>New!</p>", "the change shows the value the site stored");
  assert.match(filtered.message, /save filters changed the content/);
});

test("F14 post_changed answers the way back to the read and a notice naming the changed parts, and no error", async () => {
  const { extensionTool } = await load();
  const out = await extensionTool({ input: outcomeCall({ success: false, code: "post_changed", message: "m", data: { changed: ["post_content", "row_token"], current_modified_gmt: "2026-11-20 10:06:00" } }), ports: {} });
  assert.equal(out.next, "post_changed");
  assert.match(out.reviewNotice, /changed on the site/);
  assert.match(out.reviewNotice, /content/);
  assert.match(out.reviewNotice, /Nothing was written/);
  assert.deepEqual(out.changes, []);
  assert.equal(out.proposalId, "");
});

test("F15 every other refusal ends the run completed with its code, a plain message of its own and nothing written", async () => {
  const { extensionTool } = await load();
  const messages = new Set();
  for (const code of REFUSAL_CODES) {
    const out = await extensionTool({ input: outcomeCall({ success: false, code, message: "site text <b>", data: { current_modified_gmt: null, current_status: "pending", changed: ["post_name"] } }), ports: {} });
    assert.equal(out.next, code);
    assert.equal(out.error.code, code);
    assert.equal(out.error.message, out.message);
    assert.match(out.message, /^Nothing was written/, `${code}: the message says nothing was written`);
    assert.equal(out.message.includes("site text"), false, "the site's own text is not repeated");
    assert.deepEqual(out.changes, []);
    assert.equal(out.proposalId, "");
    messages.add(out.message);
  }
  assert.equal(messages.size, REFUSAL_CODES.length, "each code has its own message");
});

test("F16 an answer that is neither a save nor a known refusal fails the run and says the outcome is not known", async () => {
  const { extensionTool } = await load();
  for (const answer of [{}, { success: false, code: "other" }, { success: "true" }, saved({ post_id: 43 }), saved({ post_content: 7 })]) {
    await assert.rejects(extensionTool({ input: outcomeCall(answer), ports: {} }), refusedWith("write_answer_unreadable"), JSON.stringify(answer).slice(0, 60));
  }
});

// Every code the site ability `cinatra/post-update-if-unchanged` answers, as its
// documentation lists them (cinatra-ai/wordpress-plugin, "Content abilities" in
// docs/advanced-and-reference.md, and the refusals of cinatra.php), read at PR #120
// head 5644e711. When the plugin documents another
// code, add it here: the test below then fails until the pack maps it explicitly.
const PLUGIN_REFUSAL_CODES = [
  "post_changed",
  "site_policy_conflict",
  "post_locked",
  "unsupported_status",
  "permission_unverified",
  "transaction_conflict",
  "empty_content",
  "invalid",
  "not_found",
  "unsupported_storage",
  "db_error",
  "write_outcome_unknown",
];
// The values of `data.cause` in the plugin's output schema at the same head, by code.
// `transaction_conflict` now means only "refused before the transaction started".
const CONFLICT_CAUSES = ["nested", "open_transaction", "autocommit_off", "completion_type"];
const DB_ERROR_CAUSES = ["lock_wait_timeout", "deadlock", "read_failed"];
const UNKNOWN_CAUSES = ["unreadable", "matches", "differs"];
// Codes an earlier plugin head answered and this head no longer does.
const REMOVED_CODES = ["transaction_lost", "connection_replaced"];
const LINK = "https://example.org/opening-hours/";

test("F16a every code the plugin documents has an explicit outcome in the pack, and the pack maps no other code", async () => {
  const { WRITE_REFUSALS, OUTCOME_UNKNOWN_CODE } = await load();
  const explicit = new Set([...Object.keys(WRITE_REFUSALS), "post_changed", OUTCOME_UNKNOWN_CODE]);
  for (const code of PLUGIN_REFUSAL_CODES) assert.ok(explicit.has(code), `the plugin's ${code} has no explicit outcome in the pack`);
  for (const code of explicit) assert.ok(PLUGIN_REFUSAL_CODES.includes(code), `the pack maps ${code}, which the plugin does not document`);
  assert.equal(OUTCOME_UNKNOWN_CODE, "write_outcome_unknown");
  assert.deepEqual([...REFUSAL_CODES].sort(), Object.keys(WRITE_REFUSALS).sort(), "the flow routes exactly the codes of WRITE_REFUSALS");
});

test("F16b one case per refusal code: nothing written, its own message, the branch of its code, no site text", async () => {
  const { extensionTool } = await load();
  const answers = {
    empty_content: { data: { current_modified_gmt: "2026-11-20 10:06:00" } },
    transaction_conflict: { data: { current_modified_gmt: null, cause: "open_transaction" } },
  };
  for (const [code, extra] of Object.entries(answers)) {
    const out = await extensionTool({ input: outcomeCall({ success: false, code, message: "site text", ...extra }), ports: {} });
    assert.equal(out.next, code);
    assert.equal(out.error.code, code);
    assert.equal(out.error.message, out.message);
    assert.match(out.message, /^Nothing was written: /);
    assert.equal(out.message.includes("site text"), false);
    assert.equal(out.message.includes("outdated copy"), false, "no cache sentence without the flag");
    assert.deepEqual(out.changes, []);
  }
  const empty = await extensionTool({ input: outcomeCall({ success: false, code: "empty_content", message: "m", data: {} }), ports: {} });
  assert.match(empty.message, /left the post empty/);
  const busy = await extensionTool({ input: outcomeCall({ success: false, code: "transaction_conflict", message: "m", data: { cause: "nested" } }), ports: {} });
  assert.match(busy.message, /Try again later/);
  for (const cause of CONFLICT_CAUSES) {
    const out = await extensionTool({ input: outcomeCall({ success: false, code: "transaction_conflict", message: "m", data: { cause } }), ports: {} });
    assert.equal(out.message, busy.message, `${cause} without the flag keeps the message`);
    assert.match(out.message, /^Nothing was written: /);
  }
  for (const cause of DB_ERROR_CAUSES) {
    const out = await extensionTool({ input: outcomeCall({ success: false, code: "db_error", message: "m", data: { cause } }), ports: {} });
    assert.match(out.message, /^Nothing was written: /, `db_error ${cause} says nothing was written`);
  }
  // site_changes_possible belongs to write_outcome_unknown alone: a refusal that
  // carries it contradicts "nothing was written", so it claims no outcome.
  for (const code of REFUSAL_CODES) {
    await assert.rejects(
      extensionTool({ input: outcomeCall({ success: false, code, message: "m", data: { cause: "nested", site_changes_possible: true } }), ports: {} }),
      refusedWith("write_answer_unreadable"),
      `${code} with site_changes_possible true`,
    );
  }
  for (const flag of [false, "true", 1, null]) {
    const other = await extensionTool({ input: outcomeCall({ success: false, code: "transaction_conflict", message: "m", data: { cause: "nested", site_changes_possible: flag } }), ports: {} });
    assert.equal(other.message, busy.message, `${JSON.stringify(flag)} keeps the message`);
  }
  const policy = await extensionTool({ input: outcomeCall({ success: false, code: "site_policy_conflict", message: "m", data: { changed: ["post_name"] } }), ports: {} });
  assert.match(policy.message, /^Nothing was written: /);
  assert.match(policy.message, /rules or code/);
  assert.match(policy.message, /during the save/);
});

test("F16c data.cache_stale true on a refusal adds one sentence, for every refusal that ends the run and for post_changed; other values add none", async () => {
  const { extensionTool } = await load();
  const note = "The site may still show an outdated copy of the post for a while.";
  for (const code of REFUSAL_CODES) {
    const plain = await extensionTool({ input: outcomeCall({ success: false, code, message: "m", data: {} }), ports: {} });
    const stale = await extensionTool({ input: outcomeCall({ success: false, code, message: "m", data: { cache_stale: true } }), ports: {} });
    assert.equal(stale.message, `${plain.message} ${note}`, `${code}: the cache sentence follows the message`);
    assert.equal(stale.error.message, stale.message);
    for (const flag of [false, "true", 1, null]) {
      const other = await extensionTool({ input: outcomeCall({ success: false, code, message: "m", data: { cache_stale: flag } }), ports: {} });
      assert.equal(other.message, plain.message, `${code}: ${JSON.stringify(flag)} adds no sentence`);
    }
  }
  const changed = await extensionTool({ input: outcomeCall({ success: false, code: "post_changed", message: "m", data: { changed: ["post_content"], cache_stale: true } }), ports: {} });
  assert.equal(changed.next, "post_changed");
  assert.ok(changed.reviewNotice.endsWith(` ${note}`));
  const none = await extensionTool({ input: outcomeCall({ success: false, code: "post_changed", message: "m", data: { changed: ["post_content"] } }), ports: {} });
  assert.equal(none.reviewNotice.includes("outdated copy"), false);
});

test("F16d write_outcome_unknown ends the run on its own branch: the site may have changed, check the post at its link; never nothing written, never Saved, never retried", async () => {
  const { extensionTool } = await load();
  const route = parts[ROUTE_STEP];
  assert.equal(route.mapping.write_outcome_unknown, "write_outcome_unknown", "the flow maps the code to its own branch");
  assert.ok(route.branches.includes("write_outcome_unknown"));
  assert.deepEqual(
    controlFrom(ROUTE_STEP).filter((e) => e.from_branch === "write_outcome_unknown").map((e) => e.to_node.$component_ref),
    ["emit_output"],
    "it ends the run: no way back to the read or to the write, so the save is never tried again by itself",
  );
  assert.deepEqual(sourcesOf(OUTCOME_STEP, "address"), [[CHECK_STEP, "address"]], "the post's link is the address as read");
  const outOf = (data, over) => extensionTool({ input: outcomeCall({ success: false, code: "write_outcome_unknown", message: "site text", data }, over), ports: {} });
  const byCause = {};
  for (const cause of [...UNKNOWN_CAUSES, undefined, "other"]) {
    const out = await outOf(cause === undefined ? { site_changes_possible: true } : { cause, site_changes_possible: true });
    byCause[cause] = out.message;
    assert.equal(out.next, "write_outcome_unknown");
    assert.deepEqual(out.error, { code: "write_outcome_unknown", message: out.message });
    assert.deepEqual(out.changes, [], "no change is claimed");
    assert.equal(out.proposalId, "", "no save is claimed");
    assert.equal(out.reviewNotice, "");
    assert.ok(out.message.includes(LINK), `${cause}: the message names the post's link`);
    assert.match(out.message, /check the page/i);
    assert.match(out.message, /other parts of the site may also have changed/i);
    assert.match(out.message, /not try the save again/i);
    assert.equal(/nothing was written/i.test(out.message), false, `${cause}: never "nothing was written"`);
    assert.equal(/^saved|saved the reviewed change/i.test(out.message), false, `${cause}: never "Saved"`);
    assert.equal(out.message.includes("site text"), false);
    assert.equal(out.message.includes("outdated copy"), false);
  }
  assert.ok(
    byCause.matches.startsWith(`The site reports the page now holds the reviewed content, but could not confirm its own save: check the page (${LINK}).`),
    byCause.matches,
  );
  for (const cause of ["unreadable", "differs", undefined, "other"]) assert.match(byCause[cause], /^The site may have changed: /, `${cause}`);
  assert.match(byCause.unreadable, /could not read the page back/);
  assert.match(byCause.differs, /does not hold exactly the reviewed content/);
  assert.equal(new Set([byCause.unreadable, byCause.matches, byCause.differs, byCause.other]).size, 4, "each cause has its own sentence");
  const stale = await outOf({ cause: "matches", site_changes_possible: true, cache_stale: true });
  assert.equal(stale.message, `${byCause.matches} The site may still show an outdated copy of the post for a while.`);
  const noLink = await outOf({ cause: "differs", site_changes_possible: true }, { address: JSON.stringify("") });
  assert.match(noLink.message, /check the page \(post 42 on the site\)/, "without an address the post is named by its id");
});

test("F17a the write sends a cleared title as the empty text, an untouched field not at all, and a changed title as it is", () => {
  const template = parts[WRITE_STEP].data.input.argsJson;
  const cleared = JSON.parse(render(template, writeVars({ reviewedTitle: "", reviewedTitleSet: true, reviewedContent: "" })));
  assert.equal(cleared.title, "", "the cleared title is sent as the empty text");
  assert.deepEqual(Object.keys(cleared).sort(), ["expected", "if_unmodified_since", "post_id", "title"], "nothing else is sent");
  assert.equal(cleared.expected.title, 'Opening "hours"', "the title as read stays in expected");
  const untouched = JSON.parse(render(template, writeVars({ reviewedTitle: "", reviewedTitleSet: false })));
  assert.equal("title" in untouched, false, "an untouched title is absent, not empty");
  const read = { postId: 42, title: "T", content: "<p>C</p>", excerpt: "", status: "draft", modified: "2026-11-20 10:00:00", rowToken: TOKEN };
  assert.equal(JSON.parse(tool.writeArgsText(read, { title: "", content: null, excerpt: null })).title, "");
  assert.equal("title" in JSON.parse(tool.writeArgsText(read, { title: null, content: "<p>D</p>", excerpt: null })), false);
  const input = parts[WRITE_STEP].inputs.find((i) => i.title === "reviewedTitleSet");
  assert.equal(input.type, "boolean");
  assert.equal(input.default, false);
});

test("F17b the outcome of a cleared title names the change from the title as read to the empty text; an untouched title is not named", async () => {
  const { extensionTool } = await load();
  const out = await extensionTool({
    input: outcomeCall(saved({ post_title: "", post_content: "<p>Old</p>", post_status: "draft" }), {
      reviewedTitleSet: JSON.stringify(true),
      reviewedTitle: JSON.stringify(""),
      reviewedContent: JSON.stringify(""),
    }),
    ports: {},
  });
  assert.equal(out.next, "written");
  assert.deepEqual(out.changes, [
    { field: "title", before: "Opening hours", after: "" },
    { field: "status", before: "publish", after: "draft" },
  ]);
  const untouched = await extensionTool({ input: outcomeCall(saved(), { reviewedTitleSet: JSON.stringify(false) }), ports: {} });
  assert.equal(untouched.changes.some((c) => c.field === "title"), false);
  assert.equal(parts[OUTCOME_STEP].inputs.find((i) => i.title === "reviewedTitleSet")?.type, "boolean");
  assert.deepEqual(sourcesOf(OUTCOME_STEP, "reviewedTitleSet"), [[REVIEWED_READ, "reviewedTitleSet"]]);
});

test("F17 the read-back answers the reviewed values one by one and the reviewed revision as the card's list", () => {
  const outputs = titles(parts[REVIEWED_READ].outputs);
  for (const name of REVIEWED_INPUTS) assert.ok(outputs.includes(name), `${REVIEWED_READ} outputs ${name}`);
  assert.equal(outputs.includes("reviewedFields"), false);
});

test("F18 the package consumes the two site tools and declares the pack tool", () => {
  const consumed = pkg.cinatra.consumes.filter((c) => c.requirement === "required").map((c) => c.primitive).sort();
  assert.deepEqual(consumed, [READ_TOOL, WRITE_TOOL]);
  assert.ok(pkg.cinatra.tools.some((t) => t.name === "reviewed_change"));
});

// --- nothing is read before the run's inputs are valid ------------------------------

const inputCall = (postId, instanceId = "wp-prod") => ({
  op: "input",
  postId: JSON.stringify(postId),
  instanceId: JSON.stringify(instanceId),
  postType: JSON.stringify(""),
});

/**
 * The read step's argsJson for a run input, through the flow's own edges: the
 * input step's tool answers (or refuses), and the read step renders the output
 * that its one `postId` edge names. `null` when the input step refuses, so the
 * read step never runs and no site call is made.
 */
async function readArgsFor(postId, instanceId) {
  const { extensionTool } = await load();
  const [[source, output]] = sourcesOf(READ_STEP, "postId");
  assert.equal(source, INPUT_STEP);
  let validated;
  try {
    validated = await extensionTool({ input: inputCall(postId, instanceId), ports: {} });
  } catch (err) {
    assert.ok(refusedWith("run_input_invalid")(err), String(err && err.message));
    return null;
  }
  return JSON.parse(render(parts[READ_STEP].data.input.argsJson, { postId: validated[output], instanceId: validated.instanceId, agent_run_id: "" }));
}

test("F19 a step before the read validates the run's inputs, and the read takes the post id and the site only from it", () => {
  const step = parts[INPUT_STEP];
  assert.equal(step.url, PASSTHROUGH);
  assert.equal(step.data.tool, "extension_tool");
  assert.equal(step.data.input.name, "reviewed_change");
  assert.equal(step.data.input.input.op, "input");
  assert.deepEqual(controlInto(INPUT_STEP), ["start"]);
  assert.deepEqual(controlInto(READ_STEP).sort(), [INPUT_STEP, ROUTE_STEP], "the read follows the input check, or the way back after post_changed");
  assert.deepEqual(sourcesOf(READ_STEP, "postId"), [[INPUT_STEP, "postId"]]);
  assert.deepEqual(sourcesOf(READ_STEP, "instanceId"), [[INPUT_STEP, "instanceId"]]);
  assert.equal(parts[INPUT_STEP].outputs.find((o) => o.title === "postId").type, "integer");
  for (const node of [READ_STEP, WRITE_STEP]) {
    for (const edge of oas.data_flow_connections.filter((e) => e.destination_node.$component_ref === node)) {
      assert.notDeepEqual([edge.source_node.$component_ref, edge.source_output].join("."), "start.postId", `${node} takes no raw post id`);
      assert.notDeepEqual([edge.source_node.$component_ref, edge.source_output].join("."), "start.instanceId", `${node} takes no raw site id`);
    }
  }
});

test("F20 a malformed post id reaches no site call; a canonical one is sent as that number", async () => {
  for (const bad of ["4.2", "04", "4e0", " 4", "4 ", "+4", "-4", -4, 0, "0", "", 4.5, "9007199254740993", 1e20, "١٢", null]) {
    assert.equal(await readArgsFor(bad), null, `${JSON.stringify(bad)} is refused before the read`);
  }
  assert.deepEqual(await readArgsFor("42"), { post_id: 42 });
  assert.deepEqual(await readArgsFor(42), { post_id: 42 }, "a number input that is a whole number is taken");
  assert.deepEqual(await readArgsFor("9007199254740991"), { post_id: 9007199254740991 });
});

test("F21 a missing or padded site id reaches no site call", async () => {
  for (const bad of ["", "   ", " wp-prod", "wp\nprod", null]) {
    assert.equal(await readArgsFor("42", bad), null, `${JSON.stringify(bad)} is refused before the read`);
  }
});

test("F22 the write's post id is the read's answer, which the check of the read proved equal to the validated id", async () => {
  assert.deepEqual(sourcesOf(WRITE_STEP, "postId"), [[READ_STEP, "post_id"]]);
  assert.deepEqual(sourcesOf(CHECK_STEP, "postId"), [[INPUT_STEP, "postId"]]);
  assert.deepEqual(sourcesOf(CHECK_STEP, "post_id"), [[READ_STEP, "post_id"]]);
  const { extensionTool } = await load();
  const call = { ...pageCall(readAnswer({ post_id: 43 })), postId: JSON.stringify(42) };
  await assert.rejects(extensionTool({ input: call, ports: {} }), refusedWith("post_read_unavailable"));
  const ok = await extensionTool({ input: { ...pageCall(readAnswer()), postId: JSON.stringify(42) }, ports: {} });
  assert.equal(ok.postId, "42");
});

// --- nothing goes to the review that the write cannot send ------------------------

const SEND_TEMPLATE = parts[WRITE_STEP].data.input.argsJson;
const bytesOf = (text) => new TextEncoder().encode(text).length;
/** The write's argsJson as the runtime renders the real template of cinatra/oas.json. */
const sentText = (v) =>
  render(SEND_TEMPLATE, {
    postId: v.postId ?? 42,
    modified: v.modified ?? "2026-11-20 10:00:00",
    title: v.title,
    content: v.content,
    excerpt: v.excerpt,
    status: v.status ?? "draft",
    rowToken: v.rowToken ?? TOKEN,
    reviewedTitle: v.reviewedTitle ?? "",
    reviewedTitleSet: v.reviewedTitleSet ?? (v.reviewedTitle ?? "") !== "",
    reviewedContent: v.reviewedContent ?? "",
    reviewedExcerpt: v.reviewedExcerpt ?? "",
    reviewedRevisionId: "",
    reviewedSnapshot: [],
  });

test("F23 tojsonText writes what the runtime's tojson writes: Python's json.dumps, keys unsorted, then < > & ' escaped", () => {
  // Each expected text is the output of Python's json.dumps(value, sort_keys=False)
  // with Jinja 3.1.6's htmlsafe_json_dumps replacements (jinja2/utils.py:637-673;
  // wayflowcore 26.1.2 _utils/_templating_helpers.py:489 sets sort_keys False).
  assert.equal(tool.tojsonText({ b: 1, a: [1, "x", null, true, false] }), '{"b": 1, "a": [1, "x", null, true, false]}');
  assert.equal(
    tool.tojsonText("é<>&'\u007f\u{1F600}\n\"\\\t \u0001"),
    '"\\u00e9\\u003c\\u003e\\u0026\\u0027\\u007f\\ud83d\\ude00\\n\\"\\\\\\t\\u2028\\u0001"',
  );
  assert.equal(tool.tojsonText(42), "42");
  assert.equal(tool.tojsonText(1.5), "1.5");
  assert.equal(tool.tojsonText("plain"), '"plain"');
});

test("F24 the rendered argsJson parses back to the same values, with the template's own key order and separators", () => {
  const v = { title: "Café <b> & 'x'", content: "<p>\u{1F600}\n\"q\"</p>", excerpt: "\u007f ", status: "publish", reviewedTitle: "Neu & <i>", reviewedContent: "<p>é</p>" };
  const text = sentText(v);
  assert.match(text, /^\{"post_id": 42, "if_unmodified_since": "2026-11-20 10:00:00", "expected": \{"title": /);
  assert.equal(/[^\x20-\x7e]/.test(text), false, "the rendered text is ASCII");
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed), ["post_id", "if_unmodified_since", "expected", "title", "content", "status"]);
  assert.deepEqual(parsed.expected, { title: v.title, content: v.content, excerpt: v.excerpt, status: "publish", row_token: TOKEN });
  assert.equal(parsed.title, v.reviewedTitle);
  assert.equal(parsed.content, v.reviewedContent);
  assert.equal(parsed.status, "draft");
});

test("F25 the tool's text of the write is byte for byte the rendered template, for every shape the template takes", () => {
  const values = { title: "T é <", content: "<p>C & \u{1F600}</p>", excerpt: "E '", modified: "2026-11-20 10:00:00", rowToken: TOKEN };
  for (const status of ["publish", "draft"]) {
    for (let mask = 1; mask < 16; mask += 1) {
      if (mask & 8 && !(mask & 1)) continue;
      const reviewed = {
        title: mask & 1 ? (mask & 8 ? "" : "New <t>") : null,
        content: mask & 2 ? "<p>new ü</p>" : null,
        excerpt: mask & 4 ? "new 'e'" : null,
      };
      const expected = sentText({ ...values, status, reviewedTitle: reviewed.title ?? "", reviewedTitleSet: reviewed.title !== null, reviewedContent: reviewed.content ?? "", reviewedExcerpt: reviewed.excerpt ?? "" });
      assert.equal(tool.writeArgsText({ postId: 42, ...values, status }, reviewed), expected, `status ${status}, fields ${mask}`);
    }
  }
});

/** The form step's call for a read whose content is `content`, proposing `writeFields`. */
const formCall = (read, writeFields) => ({
  op: "form",
  pageForm: JSON.stringify({ cinatraCmsPage: 1, system: "wordpress", writeFields }),
  postId: JSON.stringify("42"),
  readPostId: JSON.stringify("42"),
  title: JSON.stringify(read.title),
  content: JSON.stringify(read.content),
  excerpt: JSON.stringify(read.excerpt),
  status: JSON.stringify(read.status ?? "draft"),
  modified: JSON.stringify("2026-11-20 10:00:00"),
  address: JSON.stringify("https://example.org/p/"),
  rowToken: JSON.stringify(TOKEN),
  error: JSON.stringify({ code: "", message: "" }),
});

/** A read whose rendered write text, for a title change, is exactly `bytes` long; the pad holds `unit` as often as fits. */
function readOfSize(bytes, unit) {
  const base = { title: "Hours", excerpt: "", status: "draft" };
  const textFor = (pad) => sentText({ ...base, content: `<p>${pad}</p>`, reviewedTitle: "Opening hours" });
  const empty = bytesOf(textFor(""));
  const unitBytes = bytesOf(tojson(unit)) - 2;
  const units = Math.floor((bytes - empty) / unitBytes);
  const pad = unit.repeat(units) + "a".repeat(bytes - empty - units * unitBytes);
  const read = { ...base, content: `<p>${pad}</p>` };
  assert.equal(bytesOf(textFor(pad)), bytes, "the read renders to the size asked for");
  return read;
}

test("F26 a change whose write text is exactly at the connector's limit goes to the review; one byte more is refused before it", async () => {
  const { extensionTool, SEND_MAX_BYTES } = tool;
  assert.equal(SEND_MAX_BYTES, 256 * 1024, "the connector's limit: SITE_TOOL_ARGS_JSON_MAX_BYTES");
  for (const unit of ["a", "é", "<", "&'>", "\u{1F600}", "\u007f"]) {
    const at = readOfSize(SEND_MAX_BYTES, unit);
    const ok = await extensionTool({ input: formCall(at, { title: "Opening hours", content: null, excerpt: null }), ports: {} });
    assert.equal(ok.next, "review", `at the limit (${JSON.stringify(unit)})`);
    const over = readOfSize(SEND_MAX_BYTES + 1, unit);
    await assert.rejects(
      extensionTool({ input: formCall(over, { title: "Opening hours", content: null, excerpt: null }), ports: {} }),
      (err) =>
        refusedWith("page_form_unavailable")(err) &&
        err.message.includes(`${SEND_MAX_BYTES + 1} bytes`) &&
        err.message.includes(`${SEND_MAX_BYTES} bytes the WordPress connector takes`),
      `one byte over (${JSON.stringify(unit)})`,
    );
  }
});

test("F27 a content that fits once but not twice (as read and as reviewed) is refused before the review", async () => {
  const { extensionTool, SEND_MAX_BYTES } = tool;
  const big = `<p>${"word ".repeat(Math.ceil((SEND_MAX_BYTES * 0.6) / 5))}</p>`;
  const read = { title: "Hours", content: big, excerpt: "", status: "draft" };
  assert.ok(bytesOf(sentText({ ...read })) < SEND_MAX_BYTES, "the read alone fits");
  await assert.rejects(
    extensionTool({ input: formCall(read, { title: null, content: big.replace("word", "Word"), excerpt: null }), ports: {} }),
    refusedWith("page_form_unavailable"),
  );
});

test("F28 the read-back of the approved revision measures the write text again and refuses one that is too long", async () => {
  const { extensionTool, SEND_MAX_BYTES } = tool;
  const read = { title: "Hours", content: "<p>Open</p>", excerpt: "", status: "draft" };
  const filed = await extensionTool({ input: formCall(read, { title: "Opening hours", content: null, excerpt: null }), ports: {} });
  assert.equal(filed.next, "review");
  const revision = { artifactId: "artifact-7", representationRevisionId: "revision-1" };
  const answer = JSON.stringify({
    approved: true,
    review: { envelopeVersion: 1, decision: "approved", reviewTaskId: "task-1", comment: null, targets: [revision] },
  });
  const ports = {
    artifacts: {
      async contentRead(request) {
        return { ...request, mime: "application/json", text: JSON.stringify(filed.pageForm), truncated: false };
      },
    },
  };
  const readBack = (excerpt) => ({
    ...formCall({ ...read, excerpt }, null),
    op: "read",
    pageForm: undefined,
    artifactId: JSON.stringify(revision.artifactId),
    reviewAnswer: JSON.stringify(answer),
  });
  const ok = await extensionTool({ input: readBack(""), ports });
  assert.equal(ok.reviewedTitle, "Opening hours");
  // The excerpt as read is not shown and not saved, but the write sends it as an expected value.
  await assert.rejects(
    extensionTool({ input: readBack("x".repeat(SEND_MAX_BYTES)), ports }),
    (err) => refusedWith("reviewed_change_unavailable")(err) && err.message.includes(`${SEND_MAX_BYTES} bytes the WordPress connector takes`),
  );
});

test("F29 the form step and the read-back take the row token the write sends, from the check of the read", () => {
  for (const node of ["form_page", REVIEWED_READ]) {
    assert.deepEqual(sourcesOf(node, "rowToken"), [[CHECK_STEP, "rowToken"]], node);
  }
  assert.deepEqual(sourcesOf(WRITE_STEP, "rowToken"), [[READ_STEP, "row_token"]]);
});

// --- the answer to the write, through the flow ------------------------------------

/**
 * The `write_outcome` call as the flow builds it from the site's answer to the
 * write: each input of the step comes by its one data edge; an input fed by
 * `write_page` takes the answer's own field of that name, and a field the
 * answer lacks takes what `missing` gives for the step's declared output; the
 * other inputs take the run's values; then each argument is the step's own
 * template, rendered as the runtime renders it (`tojson`).
 */
function outcomeThroughFlow(answer, missing, run = {}) {
  const declared = Object.fromEntries(parts[WRITE_STEP].outputs.map((o) => [o.title, o]));
  const values = {
    postId: "42",
    instanceId: "wp-prod",
    title: "Opening hours",
    content: "<p>Old</p>",
    excerpt: "",
    status: "publish",
    address: LINK,
    reviewedTitle: "",
    reviewedTitleSet: false,
    reviewedContent: "<p>New</p>",
    reviewedExcerpt: "",
    reviewedRevisionId: "revision-2",
    cinatra_run_id: "run-1",
    ...run,
  };
  const vars = {};
  for (const input of parts[OUTCOME_STEP].inputs) {
    const sources = sourcesOf(OUTCOME_STEP, input.title);
    assert.ok(sources.length <= 1, `${input.title} has at most one data edge`);
    const [node, output] = sources[0] ?? [];
    vars[input.title] =
      node === WRITE_STEP ? (Object.prototype.hasOwnProperty.call(answer, output) ? answer[output] : missing(declared[output])) : values[input.title];
  }
  const call = {};
  for (const [key, template] of Object.entries(parts[OUTCOME_STEP].data.input.input)) call[key] = key === "op" ? template : render(template, vars);
  return call;
}
// A field the site's answer lacks: wayflowcore 26.1.2 extracts each ApiNode
// output `X` with the jq query `.X`, which answers null for a missing key, and
// fills the declared default only for an output its step did not answer at all
// (executors/_flowexecutor.py `_writeback_step_outputs`). Both readings are tested.
const MISSING = {
  "the runtime's extraction (null)": () => null,
  "the step's declared default": (output) => output.default,
};
const STORED = ["post_id", "post_title", "post_content", "post_excerpt", "post_status"];

test("F30 a success answer is Saved only when it carries every stored field; a field missing in turn, at the flow's default, is unreadable", async () => {
  const { extensionTool } = await load();
  for (const [reading, missing] of Object.entries(MISSING)) {
    const full = await extensionTool({ input: outcomeThroughFlow(saved(), missing), ports: {} });
    assert.equal(full.next, "written", `${reading}: the complete answer is a save`);
    assert.match(full.message, /^Saved the reviewed change to post 42\./);
    for (const name of STORED) {
      const answer = saved();
      delete answer[name];
      await assert.rejects(extensionTool({ input: outcomeThroughFlow(answer, missing), ports: {} }), refusedWith("write_answer_unreadable"), `${reading}: ${name} missing`);
    }
    await assert.rejects(
      extensionTool({ input: outcomeThroughFlow({ success: true, post_id: 42 }, missing), ports: {} }),
      refusedWith("write_answer_unreadable"),
      `${reading}: success and the post id alone`,
    );
    const filtered = saved({ post_content: "<p>New!</p>" });
    delete filtered.sanitized_fields;
    await assert.rejects(
      extensionTool({ input: outcomeThroughFlow(filtered, missing), ports: {} }),
      refusedWith("write_answer_unreadable"),
      `${reading}: a stored value other than the reviewed one, with no sanitized_fields`,
    );
  }
  for (const name of ["post_title", "post_content", "post_excerpt", "post_status"]) {
    const output = parts[WRITE_STEP].outputs.find((o) => o.title === name);
    assert.equal(output.default, null, `write_page's ${name} defaults to null, which no stored text can be`);
    const input = parts[OUTCOME_STEP].inputs.find((i) => i.title === name);
    assert.equal(input.default, null, `write_outcome's ${name} defaults to null`);
  }
});

test("F31 each stored value must equal what was reviewed (a saved field), the value as read (a field not saved) and the status the save sets", async () => {
  const { extensionTool } = await load();
  const unreadable = [
    saved({ post_content: "<p>Other</p>" }),
    saved({ post_content: "<p>Other</p>", sanitized_fields: ["post_title"] }),
    saved({ post_title: "Another title" }),
    saved({ post_title: "Another title", sanitized_fields: ["post_title"] }),
    saved({ post_excerpt: "An excerpt" }),
    saved({ post_status: "publish" }),
    saved({ post_status: "pending", sanitized_fields: ["post_status"] }),
  ];
  for (const answer of unreadable) {
    await assert.rejects(extensionTool({ input: outcomeCall(answer), ports: {} }), refusedWith("write_answer_unreadable"), JSON.stringify(answer).slice(0, 120));
  }
  const draft = await extensionTool({ input: outcomeCall(saved(), { status: JSON.stringify("draft") }), ports: {} });
  assert.equal(draft.next, "written", "a draft stays a draft");
  assert.deepEqual(draft.changes, [{ field: "content", before: "<p>Old</p>", after: "<p>New</p>" }]);
  const cleared = await extensionTool({ input: outcomeCall(saved({ post_title: "" }), { reviewedTitleSet: "true" }), ports: {} });
  assert.equal(cleared.next, "written", "a cleared title is stored as the empty text");
});

// Every code the plugin's write can answer (cinatra.php at PR #120 head 5644e711:
// cinatra_ability_post_update_if_unchanged, cinatra_content_begin,
// cinatra_content_update_in_transaction, cinatra_content_end and their refusal
// helpers), with what the pack does with it.
const ANSWER_TABLE = [
  ["post_changed", undefined, "post_changed", "read_page"],
  ["site_policy_conflict", undefined, "nothing", "emit_output"],
  ["permission_unverified", undefined, "nothing", "emit_output"],
  ["post_locked", undefined, "nothing", "emit_output"],
  ["unsupported_status", undefined, "nothing", "emit_output"],
  ["invalid", undefined, "nothing", "emit_output"],
  ["empty_content", undefined, "nothing", "emit_output"],
  ["not_found", undefined, "nothing", "emit_output"],
  ["unsupported_storage", undefined, "nothing", "emit_output"],
  ...CONFLICT_CAUSES.map((cause) => ["transaction_conflict", cause, "nothing", "emit_output"]),
  ...[undefined, ...DB_ERROR_CAUSES].map((cause) => ["db_error", cause, "nothing", "emit_output"]),
  ...UNKNOWN_CAUSES.map((cause) => ["write_outcome_unknown", cause, "unknown", "emit_output"]),
];

test("F32 every answer code of the write has its own branch and outcome; none reaches the default branch, and the removed codes claim no outcome", async () => {
  const { extensionTool } = await load();
  const route = parts[ROUTE_STEP];
  const target = (branch) => controlFrom(ROUTE_STEP).filter((e) => e.from_branch === branch).map((e) => e.to_node.$component_ref);
  assert.deepEqual([...new Set(ANSWER_TABLE.map(([code]) => code))].sort(), [...PLUGIN_REFUSAL_CODES].sort(), "the table lists every code of the plugin");
  for (const [code, cause, kind, to] of ANSWER_TABLE) {
    const data = { ...(cause === undefined ? {} : { cause }), ...(code === "write_outcome_unknown" ? { site_changes_possible: true } : {}) };
    const out = await extensionTool({ input: outcomeCall({ success: false, code, message: "m", data }), ports: {} });
    assert.equal(out.next, code, `${code} ${cause ?? ""}: its own next`);
    assert.equal(route.mapping[code], code, `${code}: mapped to its own branch, not the default`);
    assert.deepEqual(target(code), [to], `${code}: one edge to ${to}`);
    if (kind === "nothing") assert.match(out.message, /^Nothing was written: /, `${code} ${cause ?? ""}`);
    if (kind === "unknown") assert.match(out.message, /check the page/);
    if (kind === "post_changed") assert.match(out.reviewNotice, /^Nothing was written/);
  }
  for (const code of REMOVED_CODES) {
    assert.equal(code in route.mapping, false, `${code} has no branch`);
    for (const data of [{}, { site_changes_possible: true }]) {
      await assert.rejects(extensionTool({ input: outcomeCall({ success: false, code, message: "m", data }), ports: {} }), refusedWith("write_answer_unreadable"), code);
    }
  }
});
