// cinatra-ai/cinatra#3745 — the write step saves only what a person reviewed.
//
// The pack's `reviewed_change` tool (cinatra/tools/reviewed-change.mjs) has two
// operations, and the flow calls each from one step:
//
// - `form_page` (op `form`), in front of the filing: the compose step answers
//   the values to save (`writeFields`); the tool derives the shown excerpts
//   from those values and the post as read, by code. Every changed block of a
//   written value is shown as its source text, markup and link targets
//   included, so the review shows each written change and no value can be
//   written that the excerpts do not show.
// - `read_reviewed_page` (op `read`), after the review: it takes the revision
//   the review's answer approves for the filed artifact (after a Regenerate, a
//   successor of the filed revision), reads that revision by its id, derives
//   the excerpts again from its `writeFields` and refuses when they differ
//   from the excerpts the revision shows. The write step saves only the values
//   this read answers.
//
// A refusal fails the step and so the run, before the write step, the only
// step that names a site write; the tool itself reads only the artifact port.
//
// What this file executes: the tool, with fake ports, and the shape of
// cinatra/oas.json. What it does not execute: the host's flow runner, the
// model steps and the display; the display's reading of the form is copied
// below (the rule that refuses a block whose two sides hold the same words).
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

const TOOL = "reviewed_change";
const MODULE = "./cinatra/tools/reviewed-change.mjs";
const PAGE_TYPE = "@cinatra-ai/website-artifacts:page-snapshot";
const READ_CODE = "reviewed_change_unavailable";
const FORM_CODE = "page_form_unavailable";
const FILED = { artifactId: "artifact-7", representationRevisionId: "revision-1" };
const SUCCESSOR = "revision-2";

const READ = {
  title: "Opening hours",
  content:
    '<!-- wp:heading -->\n<h2>When we are open</h2>\n<!-- /wp:heading -->\n\n<!-- wp:paragraph -->\n<p>We are open Monday to Friday.</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:paragraph -->\n<p>See <a href="https://example.org/old">the map</a>.</p>\n<!-- /wp:paragraph -->',
  excerpt: "Our hours.",
};
const PAGE = { title: "Opening hours", address: "https://example.org/opening-hours/", cmsAddress: "https://example.org/wp-admin/post.php?post=42&action=edit" };
const FILED_FIELDS = { title: "Opening hours and holidays", content: READ.content.replace("Monday to Friday", "Monday to Saturday"), excerpt: null };
const SUCCESSOR_FIELDS = { title: null, content: READ.content.replace("https://example.org/old", "https://example.org/new"), excerpt: null };

const sourcesOf = (node, input) =>
  oas.data_flow_connections
    .filter((e) => e.destination_node.$component_ref === node && e.destination_input === input)
    .map((e) => [e.source_node.$component_ref, e.source_output]);
const controlInto = (node) =>
  oas.control_flow_connections.filter((e) => e.to_node.$component_ref === node).map((e) => e.from_node.$component_ref);
const titles = (list) => (list ?? []).map((entry) => entry.title);
const sameWords = (a, b) => a.trim().split(/\s+/).join(" ") === b.trim().split(/\s+/).join(" ");

const load = () => import("../cinatra/tools/reviewed-change.mjs");

/** The values the flow sends, each as JSON text. */
const readInputs = (read = READ) => ({
  title: JSON.stringify(read.title),
  content: JSON.stringify(read.content),
  excerpt: JSON.stringify(read.excerpt),
});

async function formOf(writeFields, read = READ, extra = {}) {
  const { extensionTool } = await load();
  const result = await extensionTool({
    input: { op: "form", pageForm: JSON.stringify({ cinatraCmsPage: 1, system: "wordpress", page: PAGE, writeFields, ...extra }), ...readInputs(read) },
    ports: {},
  });
  return result.pageForm;
}

/** The review's answer as the application sends it into the paused run on an approval. */
function answer(targets, over = {}, reviewOver = {}) {
  return JSON.stringify({
    approved: true,
    review: { envelopeVersion: 1, decision: "approved", reviewTaskId: "task-1", comment: null, targets, ...reviewOver },
    ...over,
  });
}

/** Fake ports: one artifact read, recorded; any other port touched is recorded too. */
function portsAnswering(byRevision) {
  const reads = [];
  const touched = new Set();
  const ports = new Proxy(
    {
      artifacts: {
        async contentRead(request) {
          reads.push(request);
          const entry = byRevision[request.representationRevisionId];
          if (entry instanceof Error) throw entry;
          if (typeof entry === "function") return entry(request);
          return {
            artifactId: request.artifactId,
            representationRevisionId: request.representationRevisionId,
            mime: "application/json",
            text: entry,
            truncated: false,
          };
        },
      },
    },
    { get: (target, key, receiver) => (touched.add(key), Reflect.get(target, key, receiver)) },
  );
  return { reads, touched, ports };
}

const readCall = (reviewAnswer, artifactId = FILED.artifactId) => ({
  op: "read",
  artifactId: JSON.stringify(artifactId),
  reviewAnswer: JSON.stringify(reviewAnswer),
  ...readInputs(),
});

const refusedWith = (code) => (err) =>
  err instanceof Error && err.name === "ExtensionToolCallRefusal" && err.message.startsWith(`${code}: `) && !err.message.includes("\n");

// --- the flow ---------------------------------------------------------------

test("T1 the flow derives the filed form by the tool, and reads the approved revision back by the tool", () => {
  const road = oas.nodes.map((n) => n.$component_ref);
  assert.deepEqual(road, [
    "start", "read_page", "compose_change", "form_page", "route_change", "file_page", "gather_page_review",
    "page_review_gate", "read_reviewed_page", "edit", "no_change_outcome", "emit_output", "end",
  ]);
  for (const id of ["form_page", "read_reviewed_page"]) {
    const node = parts[id];
    assert.equal(node.component_type, "ApiNode");
    assert.ok(node.url.endsWith("/api/agents/passthrough"));
    assert.equal(node.data.tool, "extension_tool");
    assert.equal(node.data.input.name, TOOL);
    assert.equal(node.data.agent_run_id, "{{ cinatra_run_id }}");
    assert.equal(node.metadata.cinatra.riskClass, "read_only");
    assert.equal("publishes" in node.metadata.cinatra, false);
    for (const field of ["title", "content", "excerpt"]) assert.deepEqual(sourcesOf(id, field), [["read_page", field]]);
  }
  assert.equal(parts.form_page.data.input.input.op, "form");
  assert.deepEqual(sourcesOf("form_page", "pageForm"), [["compose_change", "pageForm"]]);
  assert.deepEqual(sourcesOf("file_page", "pageForm"), [["form_page", "pageForm"]], "the filed form is the derived one");
  assert.equal(parts.read_reviewed_page.data.input.input.op, "read");
  assert.deepEqual(sourcesOf("read_reviewed_page", "artifactId"), [["file_page", "artifactId"]]);
  assert.deepEqual(sourcesOf("read_reviewed_page", "reviewAnswer"), [["page_review_gate", "pageReviewNote"]], "the revision read is the one the answer names");
  assert.deepEqual(sourcesOf("read_reviewed_page", "representationRevisionId"), [], "the filed revision is never the one read");
  assert.deepEqual(controlInto("read_reviewed_page"), ["page_review_gate"]);
  assert.deepEqual(controlInto("edit"), ["read_reviewed_page"]);
  assert.deepEqual(sourcesOf("edit", "reviewedFields"), [["read_reviewed_page", "reviewedFields"]]);
  assert.deepEqual(sourcesOf("edit", "reviewedRevisionId"), [["read_reviewed_page", "reviewedRevisionId"]]);
  assert.deepEqual(
    oas.data_flow_connections
      .filter((e) => e.destination_node.$component_ref === "edit" && ["file_page", "compose_change", "form_page"].includes(e.source_node.$component_ref))
      .map((e) => e.destination_input),
    [],
    "no value reaches the write step from the filing or the compose step around the review",
  );
  assert.deepEqual(pkg.cinatra.tools.find((t) => t.name === TOOL), { name: TOOL, module: MODULE });
  assert.ok(pkg.files.includes("cinatra"), "the tool file is packed");
});

// --- the form the review shows ------------------------------------------------

test("T2 the shown excerpts are derived from the values to save; a link-target change shows the link target", async () => {
  const form = await formOf(SUCCESSOR_FIELDS);
  assert.deepEqual(form.writeFields, SUCCESSOR_FIELDS);
  assert.equal(form.excerpts.length, 1);
  const [excerpt] = form.excerpts;
  assert.equal(excerpt.region, "content");
  assert.ok(excerpt.published.includes('href="https://example.org/old"'), "the old link target is shown");
  assert.ok(excerpt.proposed.includes('href="https://example.org/new"'), "the new link target is shown");
  assert.equal(sameWords(excerpt.published, excerpt.proposed), false, "the display does not refuse the block");
});

test("T3 every written change is shown: the unshown blocks of a written value equal the post as read", async () => {
  const form = await formOf(FILED_FIELDS);
  assert.deepEqual(form.excerpts.map((e) => [e.region, e.kind, e.level]), [["title", "heading", 1], ["content", "paragraph", null]]);
  assert.equal(form.excerpts[0].proposed, FILED_FIELDS.title);
  const body = form.excerpts[1];
  assert.equal(READ.content.replace(body.published, body.proposed), FILED_FIELDS.content, "the shown block is the whole difference");
  const positions = form.excerpts.filter((e) => e.region === "content").map((e) => e.position);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test("T4 the model's own excerpts are never filed", async () => {
  const lie = [{ region: "content", position: 0, kind: "paragraph", level: null, published: "a", proposed: "b" }];
  const form = await formOf(SUCCESSOR_FIELDS, READ, { excerpts: lie });
  assert.notDeepEqual(form.excerpts, lie);
});

test("T5 the form is refused when the change cannot be shown", async () => {
  await assert.rejects(formOf({ title: null, content: READ.content.replace("</p>\n<!-- /wp:paragraph -->", "</p>  \n<!-- /wp:paragraph -->"), excerpt: null }), refusedWith(FORM_CODE), "white space only");
  await assert.rejects(formOf({ title: null, content: "", excerpt: null }), refusedWith(FORM_CODE), "an empty value");
});

// --- the read after the review --------------------------------------------------

test("T6 the approval of a successor revision reads and answers the successor's values", async () => {
  const { extensionTool } = await load();
  const filed = JSON.stringify(await formOf(FILED_FIELDS));
  const successor = JSON.stringify(await formOf(SUCCESSOR_FIELDS));
  const { reads, touched, ports } = portsAnswering({ [FILED.representationRevisionId]: filed, [SUCCESSOR]: successor });
  const result = await extensionTool({ input: readCall(answer([{ artifactId: FILED.artifactId, representationRevisionId: SUCCESSOR }])), ports });
  assert.deepEqual(reads, [{ artifactId: FILED.artifactId, representationRevisionId: SUCCESSOR, objectType: PAGE_TYPE }]);
  assert.equal(result.reviewedRevisionId, SUCCESSOR);
  assert.deepEqual(JSON.parse(result.reviewedFields), SUCCESSOR_FIELDS);
  assert.deepEqual([...touched].filter((k) => typeof k === "string"), ["artifacts"]);
});

test("T7 the approval of the filed revision still answers its values", async () => {
  const { extensionTool } = await load();
  const filed = JSON.stringify(await formOf(FILED_FIELDS));
  const { reads, ports } = portsAnswering({ [FILED.representationRevisionId]: filed });
  const result = await extensionTool({ input: readCall(answer([FILED])), ports });
  assert.equal(reads.length, 1);
  assert.equal(result.reviewedRevisionId, FILED.representationRevisionId);
  assert.deepEqual(JSON.parse(result.reviewedFields), FILED_FIELDS);
});

test("T8 each refusal ends the run before the write, and the tool reaches no site", async () => {
  const { extensionTool } = await load();
  const good = JSON.stringify(await formOf(FILED_FIELDS));
  const parsed = JSON.parse(good);
  const hidden = JSON.stringify({ ...parsed, writeFields: { ...parsed.writeFields, content: parsed.writeFields.content.replace("https://example.org/old", "https://example.org/hidden") } });
  const target = [FILED];
  const cases = [
    ["not JSON", "approved", null],
    ["no approval flag", answer(target, { approved: false }), null],
    ["the approval flag alone", answer(target, {}, { decision: "rejected" }), null],
    ["the decision alone", JSON.stringify({ review: { envelopeVersion: 1, decision: "approved", targets: target } }), null],
    ["another envelope version", answer(target, {}, { envelopeVersion: 2 }), null],
    ["two targets", answer([FILED, { ...FILED, representationRevisionId: SUCCESSOR }]), null],
    ["no target", answer([]), null],
    ["another artifact", answer([{ ...FILED, artifactId: "artifact-8" }]), null],
    ["a blank revision", answer([{ ...FILED, representationRevisionId: " " }]), null],
    ["a failed read", answer(target), new Error("store fault")],
    ["a cut-short read", answer(target), (r) => ({ ...r, text: good, truncated: true })],
    ["another revision read", answer(target), (r) => ({ ...r, representationRevisionId: SUCCESSOR, text: good, truncated: false })],
    ["another artifact read", answer(target), (r) => ({ ...r, artifactId: "artifact-8", text: good, truncated: false })],
    ["not the pack's snapshot", answer(target), JSON.stringify({ ...parsed, system: "drupal" })],
    ["no values to write", answer(target), JSON.stringify({ ...parsed, writeFields: { title: null, content: null, excerpt: null } })],
    ["a value the excerpts do not show", answer(target), hidden],
    ["excerpts that differ from the values", answer(target), JSON.stringify({ ...parsed, excerpts: parsed.excerpts.slice(1) })],
  ];
  for (const [name, reviewAnswer, read] of cases) {
    const { touched, ports } = portsAnswering({ [FILED.representationRevisionId]: read ?? good });
    await assert.rejects(extensionTool({ input: readCall(reviewAnswer), ports }), refusedWith(READ_CODE), name);
    assert.deepEqual([...touched].filter((k) => typeof k === "string" && k !== "artifacts"), [], `${name}: no other port`);
  }
  const { ports } = portsAnswering({ [FILED.representationRevisionId]: good });
  await assert.rejects(extensionTool({ input: readCall(answer(target), " "), ports }), refusedWith(READ_CODE), "no filed artifact");
  const site = ["wordpress_site_tool_write", "wordpress_site_tool_call", "ewpa/"];
  const source = readFileSync(join(root, MODULE), "utf8");
  for (const word of site) assert.equal(source.includes(word), false, `the tool never names ${word}`);
  const writers = oas.nodes.map((n) => n.$component_ref).filter((id) => JSON.stringify(parts[id]).includes("wordpress_site_tool_write"));
  assert.deepEqual(writers, ["edit"], "the write step, after the read, is the only step that names a site write");
});

test("T9 the write step takes the values only from the read, and keeps its checks", () => {
  const { system, user } = parts.edit.data;
  assert.ok(titles(parts.edit.inputs).includes("reviewedFields"));
  for (const gone of ["reviewedPage", "reviewedTruncated", "artifactId", "representationRevisionId"])
    assert.equal(titles(parts.edit.inputs).includes(gone), false, `the write step takes no ${gone}`);
  assert.ok(user.includes("- reviewedFields: {{ reviewedFields }}"));
  for (const code of ["post_changed", "page_editing_unsupported", "reviewed_change_unavailable"]) assert.ok(system.includes(code));
});

// --- only a changed field is saved ----------------------------------------------

test("T10 a change of the title alone saves the title alone, though the compose step repeats the other values", async () => {
  const { extensionTool } = await load();
  const composed = { title: "Opening hours and holidays", content: READ.content, excerpt: READ.excerpt };
  const form = await formOf(composed);
  assert.deepEqual(form.writeFields, { title: composed.title, content: null, excerpt: null }, "an unchanged value is null in the filed form");
  assert.deepEqual(form.excerpts.map((e) => e.region), ["title"]);
  const { ports } = portsAnswering({ [FILED.representationRevisionId]: JSON.stringify(form) });
  const result = await extensionTool({ input: readCall(answer([FILED])), ports });
  assert.deepEqual(JSON.parse(result.reviewedFields), { title: composed.title, content: null, excerpt: null }, "the write step is handed the title alone");
});

test("T11 a change of the content alone saves the content alone", async () => {
  const { extensionTool } = await load();
  const content = READ.content.replace("Monday to Friday", "Monday to Saturday");
  const form = await formOf({ title: READ.title, content, excerpt: READ.excerpt });
  assert.deepEqual(form.writeFields, { title: null, content, excerpt: null });
  assert.deepEqual(form.excerpts.map((e) => e.region), ["content"]);
  const { ports } = portsAnswering({ [FILED.representationRevisionId]: JSON.stringify(form) });
  const result = await extensionTool({ input: readCall(answer([FILED])), ports });
  assert.deepEqual(JSON.parse(result.reviewedFields), { title: null, content, excerpt: null });
});

test("T12 the read-back refuses a revision that would save a field its excerpts do not show, also when that value equals the post as read", async () => {
  const { extensionTool } = await load();
  const form = await formOf({ title: "Opening hours and holidays", content: null, excerpt: null });
  for (const [field, value] of [["content", READ.content], ["excerpt", READ.excerpt]]) {
    const extra = JSON.stringify({ ...form, writeFields: { ...form.writeFields, [field]: value } });
    const { ports } = portsAnswering({ [FILED.representationRevisionId]: extra });
    await assert.rejects(extensionTool({ input: readCall(answer([FILED])), ports }), refusedWith(READ_CODE), `an unchanged ${field}`);
  }
  const edit = parts.edit.data.system;
  assert.ok(edit.includes("never write a field whose `reviewedFields` member is null"), "the write step never sends a null member");
  assert.ok(edit.includes("carrying exactly the `reviewedFields` members that are non-empty strings"), "the update carries only the returned values");
});

// --- the work of the comparison is bounded --------------------------------------

const manyBlocks = (count, change = () => null) =>
  Array.from({ length: count }, (_, i) => change(i) ?? `<!-- wp:paragraph -->\n<p>Block ${i}.</p>\n<!-- /wp:paragraph -->\n\n`).join("");

test("T13 a post of 5,000 blocks with one changed block compares only the changed block", async () => {
  const { compareBlocks, blocksOf } = await load();
  const before = manyBlocks(5000);
  const after = manyBlocks(5000, (i) => (i === 2500 ? "<!-- wp:paragraph -->\n<p>Block 2500, changed.</p>\n<!-- /wp:paragraph -->\n\n" : null));
  const meter = { cells: 0 };
  const entries = compareBlocks(blocksOf(before), blocksOf(after), () => assert.fail("not refused"), meter);
  assert.ok(meter.cells > 0 && meter.cells <= 16, `the table holds the changed blocks only, not ${meter.cells} cells`);
  assert.equal(entries.filter((e) => e.op !== "same").length, 2, "one block removed, one added");
  const form = await formOf({ title: null, content: after, excerpt: null }, { ...READ, content: before });
  assert.equal(form.excerpts.length, 1);
  assert.ok(form.excerpts[0].proposed.includes("Block 2500, changed."));
  assert.ok(form.excerpts[0].published.includes("Block 2500."));
});

test("T14 a change whose compared part is too large is refused, at the form and at the read-back", async () => {
  const { extensionTool } = await load();
  const before = manyBlocks(5000);
  const ends = (i) => (i === 0 || i === 4999 ? `<p>Block ${i}, changed.</p>\n\n` : null);
  const after = manyBlocks(5000, ends);
  const tooLarge = (code) => (err) => refusedWith(code)(err) && err.message.includes("more blocks than the page snapshot form can compare");
  await assert.rejects(formOf({ title: null, content: after, excerpt: null }, { ...READ, content: before }), tooLarge(FORM_CODE));
  const snapshot = JSON.stringify({ cinatraCmsPage: 1, system: "wordpress", page: PAGE, writeFields: { title: null, content: after, excerpt: null }, excerpts: [] });
  const { ports } = portsAnswering({ [FILED.representationRevisionId]: snapshot });
  const call = { ...readCall(answer([FILED])), content: JSON.stringify(before) };
  await assert.rejects(extensionTool({ input: call, ports }), tooLarge(READ_CODE));

  const blocks = manyBlocks(20001);
  await assert.rejects(formOf({ title: null, content: `${blocks}<p>x</p>`, excerpt: null }, { ...READ, content: blocks }), refusedWith(FORM_CODE), "too many blocks");
  const long = "a".repeat(2_000_001);
  await assert.rejects(formOf({ title: null, content: null, excerpt: long }), refusedWith(FORM_CODE), "too long a value");
  await assert.rejects(formOf({ title: "New", content: null, excerpt: null }, { ...READ, content: long }), refusedWith(FORM_CODE), "too long a read");
});

// --- a change of nothing ends the run completed -----------------------------------

test("T15 a change of nothing ends the run completed, past the filing and the review, and makes no site call", async () => {
  const BRANCH = "route_change";
  const NO_CHANGE = "no_change_outcome";
  const branch = parts[BRANCH];
  assert.ok(branch, "the flow carries the branch");
  assert.equal(branch.component_type, "BranchingNode");
  assert.deepEqual(branch.branches, ["default", "no_change"]);
  assert.deepEqual(branch.mapping, { no_change: "no_change" });
  assert.deepEqual(sourcesOf(BRANCH, "next"), [["form_page", "next"]]);
  const edges = oas.control_flow_connections.map((e) => [e.from_node.$component_ref, e.from_branch ?? null, e.to_node.$component_ref]);
  assert.deepEqual(edges.filter(([from]) => from === "form_page"), [["form_page", null, BRANCH]]);
  assert.deepEqual(edges.filter(([from]) => from === BRANCH), [[BRANCH, "default", "file_page"], [BRANCH, "no_change", NO_CHANGE]], "any other answer goes to the filing and the review");
  assert.deepEqual(edges.filter(([from]) => from === NO_CHANGE), [[NO_CHANGE, null, "emit_output"]]);
  assert.deepEqual(controlInto("file_page"), [BRANCH]);
  assert.deepEqual(controlInto("emit_output").sort(), ["edit", NO_CHANGE]);

  const node = parts[NO_CHANGE];
  assert.equal(node.component_type, "ApiNode");
  assert.equal(node.data.tool, "extension_tool");
  assert.equal(node.data.input.name, TOOL);
  assert.equal(node.data.input.input.op, "unchanged");
  assert.equal(node.metadata.cinatra.riskClass, "read_only");
  assert.equal("publishes" in node.metadata.cinatra, false);
  for (const word of ["wordpress_site_tool", "ewpa/"]) assert.equal(JSON.stringify(node).includes(word), false, `the no-change step names no ${word}`);
  assert.deepEqual(sourcesOf(NO_CHANGE, "pageForm"), [["compose_change", "pageForm"]]);
  for (const field of ["title", "content", "excerpt", "status", "error"]) assert.deepEqual(sourcesOf(NO_CHANGE, field), [["read_page", field]]);
  for (const input of ["postId", "instanceId", "proposalId", "changeSetId", "changes", "error"]) {
    assert.deepEqual(sourcesOf("emit_output", input), [["edit", input], [NO_CHANGE, input]], `the output's ${input} comes from the one step that ran`);
    assert.deepEqual(sourcesOf("end", input), [["edit", input], [NO_CHANGE, input]], `the end's ${input} comes from the one step that ran`);
  }

  const { extensionTool } = await load();
  const nothing = { title: null, content: null, excerpt: null };
  const route = async (writeFields) =>
    (await extensionTool({ input: { op: "form", pageForm: JSON.stringify({ cinatraCmsPage: 1, system: "wordpress", page: PAGE, writeFields }), ...readInputs() }, ports: {} })).next;
  assert.equal(await route(nothing), "no_change", "no values");
  assert.equal(await route({ title: READ.title, content: READ.content, excerpt: READ.excerpt }), "no_change", "values equal to the post as read");
  assert.equal(await route(FILED_FIELDS), "review", "a change is reviewed");

  const ok = JSON.stringify({ code: "", message: "" });
  const unchanged = (writeFields, over = {}) =>
    extensionTool({
      input: { op: "unchanged", postId: JSON.stringify("42"), instanceId: JSON.stringify("site-1"), pageForm: JSON.stringify({ writeFields }), status: JSON.stringify("publish"), error: ok, ...readInputs(), ...over },
      ports: {},
    });
  const outcome = { ok: true, postId: "42", instanceId: "site-1", proposalId: "", changeSetId: "", changes: [], error: {} };
  assert.deepEqual(await unchanged(nothing), outcome);
  assert.deepEqual(await unchanged({ title: READ.title, content: null, excerpt: null }), outcome);
  await assert.rejects(unchanged(FILED_FIELDS), refusedWith(FORM_CODE), "a change needs the review");
  await assert.rejects(unchanged(nothing, { error: JSON.stringify({ code: "call_failed", message: "no" }) }), refusedWith(FORM_CODE), "a failed read");
  await assert.rejects(unchanged(nothing, { status: JSON.stringify("") }), refusedWith(FORM_CODE), "a read with no status");
  await assert.rejects(unchanged(nothing, { pageForm: JSON.stringify("x") }), refusedWith(FORM_CODE), "no values");
});
