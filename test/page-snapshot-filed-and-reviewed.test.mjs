// cinatra-ai/cinatra#3862 — the agent reads the page, files the page snapshot
// with the published and the proposed words, the application reviews it, and
// the write step follows the review.
//
// Nine arms: S1 the flow's one road; S2 the read step; S3 the compose step, the
// form it answers and the form the tool derives from it; S4 the filing step and the package manifest; S5 the
// review step and the step that names the filed snapshot to it; S6 the write
// step; S7 the declared module; S8 the end node; S9 the read of the reviewed
// revision between the review and the write.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(join(root, "cinatra", "oas.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const parts = oas.$referenced_components;

const PACKAGE = "@cinatra-ai/wordpress-agent";
const SNAPSHOT_EXTENSION = "@cinatra-ai/website-artifacts";
const SNAPSHOT_TYPE = "@cinatra-ai/website-artifacts:page-snapshot";
const LLM_BRIDGE_PATH = "/api/llm-bridge";
const GATE = "page_review_gate";
const EXAMPLE_BEGIN = "BEGIN EXAMPLE FORM";
const EXAMPLE_END = "END EXAMPLE FORM";

const ROAD = [
  "start",
  "read_page",
  "compose_change",
  "form_page",
  "route_change",
  "file_page",
  "gather_page_review",
  "page_review_gate",
  "read_reviewed_page",
  "edit",
  "no_change_outcome",
  "emit_output",
  "end",
];
// The one road with a change, and the road of a request that changes nothing.
const REVIEW_ROAD = ROAD.filter((id) => id !== "no_change_outcome");
const CONTROL_EDGES = [
  ...REVIEW_ROAD.slice(0, -1).map((id, index) => [id, id === "route_change" ? "default" : null, REVIEW_ROAD[index + 1]]),
  ["route_change", "no_change", "no_change_outcome"],
  ["no_change_outcome", null, "emit_output"],
];
const RUN_OUTPUTS = ["postId", "instanceId", "proposalId", "changeSetId", "changes", "error"];

const edgeInto = (node, input) =>
  oas.data_flow_connections.find(
    (e) => e.destination_node.$component_ref === node && e.destination_input === input,
  );
const edgesInto = (node, input) =>
  oas.data_flow_connections.filter(
    (e) => e.destination_node.$component_ref === node && e.destination_input === input,
  );
const controlInto = (node) =>
  oas.control_flow_connections.filter((e) => e.to_node.$component_ref === node);
const titles = (list) => (list ?? []).map((entry) => entry.title);
const find = (list, title) => (list ?? []).find((entry) => entry.title === title);
const members = (declaration) => {
  const map = declaration?.properties ?? declaration?.json_schema?.properties;
  return map && typeof map === "object" ? map : null;
};
const items = (declaration) => declaration?.items ?? declaration?.json_schema?.items;
const assertEdgeFrom = (node, input, source, output) => {
  const edge = edgeInto(node, input);
  assert.ok(edge, `${node}.${input} is edge-sourced`);
  assert.equal(edge.source_node.$component_ref, source, `${node}.${input} comes from ${source}`);
  assert.equal(edge.source_output, output ?? input, `${node}.${input} is ${source}.${output ?? input}`);
};
const assertBridgeNode = (id) => {
  const node = parts[id];
  assert.ok(node, `the flow carries the step ${id}`);
  assert.equal(node.component_type, "ApiNode");
  assert.ok(node.url.endsWith(LLM_BRIDGE_PATH), `${id} is a bridge step`);
  assert.equal(node.http_method, "POST");
  assert.equal(node.data.agent_id, parts.edit.data.agent_id);
  assert.deepEqual(node.data.cinatra_llm, parts.edit.data.cinatra_llm);
  assert.equal(node.data.agent_run_id, "{{ agent_run_id }}");
  assert.ok(titles(node.inputs).includes("agent_run_id"), `${id} declares agent_run_id`);
  assert.equal(node.metadata.cinatra.riskClass, "read_only");
  assert.equal(node.metadata.cinatra.requiresApproval, false);
  assert.equal(node.metadata.cinatra.packageName, PACKAGE);
  return node;
};

// ---------------------------------------------------------------------------
// A COPY of the display's form reader, as plain JavaScript, from
// cinatra-ai/website-artifacts src/cms-page-model.ts (the file as last changed
// at 86aeea92f768c85acceeed67e8e5af9dae334c23, unchanged at 26763267):
// framableAddress, frameAddress and parseCmsPage with the helpers they call,
// line for line with the types removed. The pack's own restatement of the
// parser's rules (`displayReading` in cinatra/tools/reviewed-change.mjs) is
// compared with this copy below (S3b).
// ---------------------------------------------------------------------------
const CMS_PAGE_FORM_MARKER = "cinatraCmsPage";
const CMS_PAGE_FORM_VERSION = 1;
const CMS_PAGE_MAX_EXCERPTS = 200;
const SYSTEMS = ["wordpress", "drupal"];
const KINDS = ["heading", "paragraph", "list-item"];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HTTPS_TEXT = /^https:\/\//i;

function framableAddress(value) {
  if (typeof value !== "string" || !HTTPS_TEXT.test(value)) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  return value;
}

const LOCAL_NAMES = ["localhost", "local", "internal"];

function frameAddress(value) {
  const admitted = framableAddress(value);
  if (admitted === null) return null;
  let url;
  try {
    url = new URL(admitted);
  } catch {
    return null;
  }
  if (url.port !== "") return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[")) return null;
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((label) => label === "")) return null;
  const top = labels[labels.length - 1];
  if (/^[0-9]+$/.test(top) || LOCAL_NAMES.includes(top)) return null;
  if (host === "home.arpa" || host.endsWith(".home.arpa")) return null;
  return admitted;
}

function sameWords(a, b) {
  return a.trim().split(/\s+/).join(" ") === b.trim().split(/\s+/).join(" ");
}

function parseExcerpt(value) {
  if (!isRecord(value)) return null;
  const { region, position, kind, level, published, proposed } = value;
  if (typeof region !== "string" || region.length === 0) return null;
  if (typeof position !== "number" || !Number.isInteger(position) || position < 0) return null;
  if (typeof kind !== "string" || !KINDS.includes(kind)) return null;
  if (typeof published !== "string" || typeof proposed !== "string") return null;
  // A block whose two sides hold the same words, whitespace aside, is no change.
  if (sameWords(published, proposed)) return null;
  let headingLevel = null;
  if (kind === "heading") {
    if (level === undefined) headingLevel = 2;
    else if (typeof level === "number" && Number.isInteger(level) && level >= 1 && level <= 6) headingLevel = level;
    else return null;
  }
  return { region, position, kind, level: headingLevel, published, proposed };
}

function parseCmsPage(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not-json" };
  }
  if (!isRecord(value) || !(CMS_PAGE_FORM_MARKER in value)) return { ok: false, reason: "not-the-form" };
  if (value[CMS_PAGE_FORM_MARKER] !== CMS_PAGE_FORM_VERSION) return { ok: false, reason: "form-version" };

  const excerpts = value.excerpts;
  if (excerpts === undefined || (Array.isArray(excerpts) && excerpts.length === 0)) {
    return { ok: false, reason: "no-excerpts" };
  }

  const system = value.system;
  const page = value.page;
  if (typeof system !== "string" || !SYSTEMS.includes(system)) return { ok: false, reason: "malformed" };
  if (!isRecord(page) || typeof page.title !== "string") return { ok: false, reason: "malformed" };
  if (!Array.isArray(excerpts) || excerpts.length > CMS_PAGE_MAX_EXCERPTS) return { ok: false, reason: "malformed" };

  const parsed = [];
  for (const entry of excerpts) {
    const excerpt = parseExcerpt(entry);
    if (excerpt === null) return { ok: false, reason: "malformed" };
    const previous = parsed[parsed.length - 1];
    if (previous !== undefined && previous.region === excerpt.region && excerpt.position <= previous.position) {
      return { ok: false, reason: "malformed" };
    }
    parsed.push(excerpt);
  }

  return {
    ok: true,
    page: {
      system,
      page: {
        title: page.title,
        address: frameAddress(page.address),
        cmsAddress: framableAddress(page.cmsAddress),
      },
      readAt: typeof value.readAt === "string" ? value.readAt : null,
      excerpts: parsed,
    },
  };
}

// The display's WordPress fixture form, as tests/cms-page-fixture.ts of the
// same package at the same commit builds it (WORDPRESS_FORM).
const WORDPRESS_FIXTURE_FORM = {
  cinatraCmsPage: 1,
  system: "wordpress",
  page: {
    title: "Pricing — 2026 plans",
    address: "https://acme.example/pricing",
    cmsAddress: "https://acme.example/wp-admin/post.php?post=42&action=edit",
  },
  readAt: "2026-09-29T10:00:00.000Z",
  excerpts: [
    {
      region: "title",
      position: 0,
      kind: "heading",
      level: 1,
      published: "Pricing that grows with you",
      proposed: "Pricing — 2026 plans",
    },
    {
      region: "content",
      position: 2,
      kind: "paragraph",
      published: "Three plans, a price held since 2024, and the migration note under each.",
      proposed: "Three plans, one price change, and the migration note under each.",
    },
    {
      region: "content",
      position: 5,
      kind: "list-item",
      published: "Team — 35 per seat",
      proposed: "Team — 39 per seat",
    },
  ],
};

test("S1: the flow runs one road from the read through the review to the write", () => {
  assert.deepEqual(
    oas.nodes.map((n) => n.$component_ref),
    ROAD,
    "the thirteen steps, in this order",
  );
  for (const id of ROAD) assert.ok(parts[id], `the step ${id} is defined`);
  const edges = oas.control_flow_connections.map((e) => [e.from_node.$component_ref, e.from_branch ?? null, e.to_node.$component_ref]);
  assert.deepEqual(
    [...edges].sort(),
    [...CONTROL_EDGES].sort(),
    "the one road with a change, and one branch that takes a change of nothing past the filing and the review to the output",
  );
  assert.ok(ROAD.indexOf("edit") > ROAD.indexOf(GATE), "the write step comes after the review");
});

test("S2: the read step reads the page and writes nothing", () => {
  const node = assertBridgeNode("read_page");
  assert.equal("toolbox_ids" in node.data, false, "the read step keeps the default tool offer");
  const system = node.data.system;
  for (const word of ["ewpa/get-post", "ewpa/get-page", "wordpress_site_tool_call"])
    assert.ok(system.includes(word), `the read step names ${word}`);
  for (const word of ["ewpa/update-post", "ewpa/create-post"])
    assert.equal(system.includes(word), false, `the read step never names ${word}`);
  assert.deepEqual(titles(node.outputs), [
    "postId",
    "instanceId",
    "postType",
    "title",
    "content",
    "excerpt",
    "status",
    "address",
    "modified",
    "error",
  ]);
  for (const title of ["postId", "instanceId", "postType", "title", "content", "excerpt", "status", "address", "modified"])
    assert.equal(find(node.outputs, title).type, "string", `${title} is a string`);
  const error = find(node.outputs, "error");
  assert.equal(error.type, "object");
  assert.deepEqual(Object.keys(members(error)).sort(), ["code", "message"]);
  for (const input of ["instanceId", "postId", "postType"]) assertEdgeFrom("read_page", input, "start");
  assertEdgeFrom("read_page", "agent_run_id", "start", "cinatra_run_id");
});

test("S3: the compose step answers the values to save, and the filed form shows each saved change as it is saved", async () => {
  const node = assertBridgeNode("compose_change");
  assert.deepEqual(node.data.toolbox_ids, [], "no tool joins the compose step");
  assert.deepEqual(titles(node.outputs), ["pageTitle", "pageForm", "error"]);
  assert.equal(find(node.outputs, "pageTitle").type, "string");
  const error = find(node.outputs, "error");
  assert.equal(error.type, "object");
  assert.deepEqual(Object.keys(members(error)).sort(), ["code", "message"]);

  const form = find(node.outputs, "pageForm");
  assert.equal(form.type, "object");
  const formMembers = members(form);
  assert.deepEqual(Object.keys(formMembers).sort(), ["cinatraCmsPage", "system", "writeFields"], "the compose step answers no excerpts and no page record");
  assert.deepEqual(Object.keys(members(formMembers.writeFields)).sort(), ["content", "excerpt", "title"]);
  for (const field of ["content", "excerpt", "title"])
    assert.deepEqual(members(formMembers.writeFields)[field], { type: ["string", "null"] }, `writeFields.${field} is a string or null`);
  const filed = members(find(parts.file_page.inputs, "pageForm"));
  assert.deepEqual(Object.keys(members(filed.page)).sort(), ["address", "cmsAddress", "postId", "status", "title"]);
  assert.deepEqual(
    Object.keys(members(items(filed.excerpts))).sort(),
    ["kind", "level", "position", "proposed", "published", "region"],
  );

  assertEdgeFrom("compose_change", "instructions", "start");
  for (const output of titles(parts.read_page.outputs)) assertEdgeFrom("compose_change", output, "read_page");

  const system = node.data.system;
  const begin = system.indexOf(EXAMPLE_BEGIN);
  const end = system.indexOf(EXAMPLE_END);
  assert.ok(begin >= 0 && end > begin, "the compose step's text carries one example form between its markers");
  assert.equal(system.indexOf(EXAMPLE_BEGIN, begin + 1), -1, "exactly one example form");
  const exampleForm = JSON.parse(system.slice(begin + EXAMPLE_BEGIN.length, end).trim());
  assert.equal("readAt" in exampleForm, false);
  assert.equal("excerpts" in exampleForm, false, "the example form carries no excerpts");
  assert.deepEqual(Object.keys(exampleForm.writeFields).sort(), ["content", "excerpt", "title"], "the example form carries writeFields");
  assert.equal(exampleForm.writeFields.excerpt, null, "a field that does not change is null");

  // The binding: the form the tool derives from the example's values and the
  // post as read is the form the display reads, its excerpts show every saved
  // change as source text, and the blocks they do not show are the post as read.
  const read = {
    title: "Opening hours",
    content:
      "<h2>When we are open</h2><p>We are open Monday to Friday.</p><p>Call ahead on public holidays.</p><ul><li>Monday to Friday: 9 to 18</li><li>Saturday: closed</li></ul>",
    excerpt: "",
  };
  const { extensionTool } = await import("../cinatra/tools/reviewed-change.mjs");
  const { pageForm } = await extensionTool({
    input: {
      op: "form",
      pageForm: JSON.stringify(exampleForm),
      postId: JSON.stringify("42"),
      readPostId: JSON.stringify("42"),
      title: JSON.stringify(read.title),
      content: JSON.stringify(read.content),
      excerpt: JSON.stringify(read.excerpt),
      status: JSON.stringify("publish"),
      modified: JSON.stringify("2026-11-20 10:00:00"),
      address: JSON.stringify("https://example.org/opening-hours/"),
      error: JSON.stringify({ code: "", message: "" }),
    },
    ports: {},
  });
  const example = parseCmsPage(JSON.stringify(pageForm));
  assert.equal(example.ok, true, `the derived form parses: ${JSON.stringify(example)}`);
  assert.equal(example.page.system, "wordpress");
  assert.deepEqual(example.page.page, {
    title: "Opening hours",
    address: "https://example.org/opening-hours/",
    cmsAddress: "https://example.org/wp-admin/post.php?post=42&action=edit",
  }, "the display draws the addresses built from the read");
  assert.deepEqual(pageForm.writeFields, exampleForm.writeFields, "the filed values are the composed values");
  assert.deepEqual(pageForm.excerpts.map((e) => e.region), ["title", "content", "content"]);
  assert.equal(pageForm.excerpts[0].proposed, exampleForm.writeFields.title, "the shown title is the saved title");
  let rebuilt = read.content;
  for (const excerpt of pageForm.excerpts.filter((e) => e.region === "content")) {
    assert.ok(excerpt.published.length > 0 && rebuilt.includes(excerpt.published));
    rebuilt = rebuilt.replace(excerpt.published, excerpt.proposed);
  }
  assert.equal(rebuilt, exampleForm.writeFields.content, "the shown blocks are the whole difference between the post as read and the saved content");

  const fixture = parseCmsPage(JSON.stringify(WORDPRESS_FIXTURE_FORM));
  assert.equal(fixture.ok, true, "the display's WordPress fixture form parses under the same copy");
  assert.equal(fixture.page.system, "wordpress");
});

// The pack restates the parser's rules in `displayReading`, which the form
// step and the read-back apply through one check. Its answer equals the copy's
// on the fixture, on a built form and on each rule the parser applies.
test("S3b: the pack's restatement of the display's parser answers what the parser answers", async () => {
  const { displayReading } = await import("../cinatra/tools/reviewed-change.mjs");
  const base = WORDPRESS_FIXTURE_FORM;
  const [heading, paragraph] = base.excerpts;
  const cases = {
    "the fixture": base,
    "not an object": "x",
    "null": null,
    "a list": [base],
    "no marker": { ...base, cinatraCmsPage: undefined },
    "another version": { ...base, cinatraCmsPage: 2 },
    "the version as text": { ...base, cinatraCmsPage: "1" },
    "no excerpts": { ...base, excerpts: undefined },
    "an empty list of excerpts": { ...base, excerpts: [] },
    "excerpts that are not a list": { ...base, excerpts: "x" },
    "201 excerpts": { ...base, excerpts: Array.from({ length: 201 }, (_, i) => ({ ...paragraph, position: i })) },
    "200 excerpts": { ...base, excerpts: Array.from({ length: 200 }, (_, i) => ({ ...paragraph, position: i })) },
    "another system": { ...base, system: "joomla" },
    "no system": { ...base, system: undefined },
    "no page record": { ...base, page: undefined },
    "a page record that is a list": { ...base, page: [] },
    "a title that is not text": { ...base, page: { ...base.page, title: 3 } },
    "an empty title": { ...base, page: { ...base.page, title: "" } },
    "extra keys in the page record": { ...base, page: { ...base.page, postId: "42", status: "draft" } },
    "addresses the display refuses": { ...base, page: { ...base.page, address: "http://x", cmsAddress: "javascript:x" } },
    "no region": { ...base, excerpts: [{ ...paragraph, region: "" }] },
    "a region that is not text": { ...base, excerpts: [{ ...paragraph, region: 1 }] },
    "a negative position": { ...base, excerpts: [{ ...paragraph, position: -1 }] },
    "a fractional position": { ...base, excerpts: [{ ...paragraph, position: 0.5 }] },
    "a position as text": { ...base, excerpts: [{ ...paragraph, position: "1" }] },
    "another kind": { ...base, excerpts: [{ ...paragraph, kind: "quote" }] },
    "a side that is not text": { ...base, excerpts: [{ ...paragraph, published: null }] },
    "the same words": { ...base, excerpts: [{ ...paragraph, proposed: ` ${paragraph.published}  ` }] },
    "a heading without a level": { ...base, excerpts: [{ ...heading, level: undefined }] },
    "a heading level 0": { ...base, excerpts: [{ ...heading, level: 0 }] },
    "a heading level 7": { ...base, excerpts: [{ ...heading, level: 7 }] },
    "a heading level null": { ...base, excerpts: [{ ...heading, level: null }] },
    "a heading level as text": { ...base, excerpts: [{ ...heading, level: "1" }] },
    "a level on a paragraph": { ...base, excerpts: [{ ...paragraph, level: 9 }] },
    "an entry that is not an object": { ...base, excerpts: ["x"] },
    "positions that do not rise": { ...base, excerpts: [paragraph, { ...paragraph, position: 1 }] },
    "equal positions in one region": { ...base, excerpts: [paragraph, { ...paragraph }] },
    "equal positions in two regions": { ...base, excerpts: [paragraph, { ...paragraph, region: "excerpt" }] },
  };
  for (const [name, form] of Object.entries(cases)) {
    const copy = parseCmsPage(JSON.stringify(form));
    const pack = displayReading(JSON.parse(JSON.stringify(form) ?? "null"));
    assert.deepEqual(pack, copy.ok ? { ok: true } : { ok: false, reason: copy.reason }, name);
  }
});

test("S4: the filing step files the page snapshot, and the manifest declares what the flow produces", () => {
  const node = parts.file_page;
  assert.ok(node, "the flow carries the filing step");
  assert.equal(node.component_type, "ApiNode");
  assert.ok(node.url.includes("/api/agents/passthrough"));
  assert.equal(node.data.tool, "artifact_materialize");
  const input = node.data.input;
  assert.equal(input.extension, SNAPSHOT_EXTENSION);
  assert.equal(input.objectTypeId, SNAPSHOT_TYPE);
  assert.equal(input.declaredMime, "application/json");
  assert.equal(input.node_id, "file_page", "the filing step names its own step");
  assert.equal(input.title, "{{ pageTitle }}");
  assert.equal(
    input.content,
    "{# pyagentspec-input-hint (do not remove): {{ pageForm }} #}{{ pageForm | tojson }}",
  );
  assert.equal(node.data.agent_run_id, "{{ cinatra_run_id }}");
  assertEdgeFrom("file_page", "pageTitle", "read_page", "title");
  assert.equal(edgesInto("file_page", "pageTitle").length, 1, "the filed title has one source, the read step");
  assertEdgeFrom("file_page", "pageForm", "form_page");
  assertEdgeFrom("form_page", "pageForm", "compose_change");
  assertEdgeFrom("file_page", "cinatra_run_id", "start");
  assert.deepEqual(titles(node.outputs), ["artifactId", "representationRevisionId"]);
  assert.equal(node.metadata.cinatra.riskClass, "write");
  assert.equal(node.metadata.cinatra.requiresApproval, false);
  assert.equal(node.metadata.cinatra.packageName, PACKAGE);

  assert.deepEqual(pkg.cinatra.produces, [{ extension: SNAPSHOT_EXTENSION, objectTypeId: SNAPSHOT_TYPE }]);
  const dependencies = pkg.cinatra.dependencies;
  const connector = dependencies.findIndex((d) => d.kind === "connector");
  assert.ok(connector >= 0, "the connector entry stays");
  assert.deepEqual(dependencies[connector + 1], {
    packageName: SNAPSHOT_EXTENSION,
    edgeType: "runtime",
    versionConstraint: { kind: "semver-range", range: "^0.1.0" },
    requirement: "required",
    kind: "artifact",
  });
  for (const list of ["dependencies", "devDependencies", "optionalDependencies"])
    assert.deepEqual(
      Object.keys(pkg[list] ?? {}).filter((name) => name.startsWith("@cinatra-ai/")),
      [],
      `no first-party name in ${list}`,
    );
});

/** The step that fills the input the review step's marker names. */
const projectionStep = () => {
  const gate = parts[GATE];
  assert.ok(gate, "the flow carries the review step");
  const named = gate.metadata?.cinatra?.artifactReview?.targetsInput;
  assert.equal(named, "reviewTargets", "the review step names the input its targets travel in");
  const edge = edgeInto(GATE, named);
  assert.ok(edge, `the run fills the input "${named}"`);
  return { id: edge.source_node.$component_ref, named, edge };
};

test("S5: the application reviews the filed page snapshot, named to it by the projection step", () => {
  const gate = parts[GATE];
  const { id, named, edge } = projectionStep();
  assert.equal(id, "gather_page_review");
  assert.equal(edge.source_output, "reviewTargets");
  assert.equal(gate.component_type, "InputMessageNode");
  assert.equal(find(gate.inputs, "reviewTargets")?.type, "string");
  assert.ok(find(gate.inputs, "pageTitle"), "the review step declares pageTitle");
  assertEdgeFrom(GATE, "pageTitle", "read_page", "title");
  assert.equal(edgesInto(GATE, "pageTitle").length, 1, "the title the review shows has one source, the read step");
  assert.deepEqual(titles(gate.outputs), ["pageReviewNote"]);
  assert.equal(gate.metadata.cinatra.a2uiSurfaceId, "wordpress-agent:page-review");

  const node = parts[id];
  assert.equal(node.component_type, "ApiNode");
  assert.equal(node.data.tool, "extension_tool");
  assert.equal(node.data.input.name, "review_targets");
  assert.deepEqual(Object.keys(node.data.input.input).sort(), ["op", "reviewTargets"]);
  assert.equal(node.data.input.input.op, "review");
  assert.equal(node.data.result_input_passthrough, true);
  assert.equal(node.data.result_id_field, "ok");
  assert.equal(node.data.agent_run_id, "{{ cinatra_run_id }}");

  const template = node.data.input.input[named];
  assert.equal(typeof template, "string", "one JSON array string, which is what is parsed");
  const rendered = template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, name) => `RENDERED-${name}`);
  const targets = JSON.parse(rendered);
  assert.ok(Array.isArray(targets));
  assert.equal(targets.length, 1, "the page snapshot alone");
  assert.deepEqual(Object.keys(targets[0]).sort(), ["artifactId", "representationRevisionId"]);
  const declared = titles(node.inputs);
  for (const key of ["artifactId", "representationRevisionId"]) {
    const value = targets[0][key];
    assert.match(value, /^RENDERED-/, `the ${key} is a placeholder the run fills`);
    const input = value.slice("RENDERED-".length);
    assert.ok(declared.includes(input), `the step declares the input "${input}"`);
    assertEdgeFrom(id, input, "file_page", key);
  }

  const messageNodes = oas.nodes
    .map((n) => n.$component_ref)
    .filter((ref) => parts[ref]?.component_type === "InputMessageNode");
  assert.deepEqual(messageNodes, [GATE], "exactly one InputMessageNode in the flow");
});

test("S6: the write step follows the review and saves only the reviewed page snapshot's values", () => {
  const node = parts.edit;
  assert.ok(node, "the write step keeps its id");
  assert.deepEqual(
    controlInto("edit").map((e) => e.from_node.$component_ref),
    ["read_reviewed_page"],
    "the only control edge into the write step comes from the read of the reviewed revision",
  );
  assertEdgeFrom("edit", "reviewedFields", "read_reviewed_page");
  assertEdgeFrom("edit", "reviewedRevisionId", "read_reviewed_page");
  for (const gone of ["artifactId", "representationRevisionId", "reviewedPage", "reviewedTruncated"])
    assert.equal(find(node.inputs, gone), undefined, `the write step takes no ${gone}`);
  assert.equal(find(node.inputs, "proposedFields"), undefined, "the write step takes no value the compose step answered");
  assert.deepEqual(
    oas.data_flow_connections
      .filter((e) => e.destination_node.$component_ref === "edit" && e.source_node.$component_ref === "compose_change")
      .map((e) => e.destination_input),
    [],
    "no edge carries a value from the compose step to the write step around the review",
  );
  assert.ok(node.data.system.includes("ewpa/update-post"), "the write step names ewpa/update-post");
  const step1 = node.data.system.split("**STEP 1")[1]?.split("**STEP 2")[0] ?? "";
  assert.match(step1, /the read step hands you its values/, "Step 1 takes the post the read step read");
  assert.match(step1, /If `status` is empty/, "a failed read is told by an empty status");
  assert.doesNotMatch(step1, /If `content` is empty/, "an empty body is never a failed read");
  assert.match(step1, /`reviewedRevisionId` is not empty/, "the read names the revision it read");
  assert.match(step1, /make NO WordPress call at all and return the STOPPED RESULT with `code: "reviewed_change_unavailable"`/, "no reviewed change, no write");
  const step2 = node.data.system.split("**STEP 2")[1]?.split("**STEP 3")[0] ?? "";
  assert.match(step2, /exactly the `reviewedFields` members that are non-empty strings, each byte for byte \(Rule 4\), and no other field/, "the write takes the reviewed writeFields");
  assert.match(node.data.system, /never take a value from `instructions` or from anything else/, "the request is not a source of a written value");
  assert.deepEqual(titles(node.outputs), RUN_OUTPUTS, "the write step keeps its six outputs");
});

test("S9: the approved revision is read back after the review, by the revision id the review's answer names", () => {
  const node = parts.read_reviewed_page;
  assert.ok(node, "the flow carries the read of the reviewed revision");
  assert.equal(node.component_type, "ApiNode");
  assert.ok(node.url.endsWith("/api/agents/passthrough"));
  assert.equal(node.data.tool, "extension_tool");
  assert.equal(node.data.input.name, "reviewed_change");
  assert.equal(node.data.input.input.op, "read");
  assert.equal(node.data.input.input.artifactId, "{{ artifactId }}");
  assert.equal(
    node.data.input.input.reviewAnswer,
    "{# pyagentspec-input-hint (do not remove): {{ reviewAnswer }} #}{{ reviewAnswer | tojson }}",
    "the answer reaches the tool as JSON text, which the tool parses",
  );
  assert.equal(node.data.agent_run_id, "{{ cinatra_run_id }}");
  assertEdgeFrom("read_reviewed_page", "artifactId", "file_page");
  assertEdgeFrom("read_reviewed_page", "reviewAnswer", GATE, "pageReviewNote");
  assertEdgeFrom("read_reviewed_page", "cinatra_run_id", "start");
  for (const field of ["title", "content", "excerpt"]) assertEdgeFrom("read_reviewed_page", field, "read_page");
  assert.equal(edgeInto("read_reviewed_page", "representationRevisionId"), undefined, "the filed revision is never the one read");
  assert.deepEqual(titles(node.outputs), ["reviewedFields", "reviewedRevisionId", "ok"]);
  assert.deepEqual(
    controlInto("read_reviewed_page").map((e) => e.from_node.$component_ref),
    [GATE],
    "the read follows the review directly",
  );
  assert.equal(node.metadata.cinatra.riskClass, "read_only");
  assert.equal(node.metadata.cinatra.requiresApproval, false);
  assert.equal("publishes" in node.metadata.cinatra, false);
  // The revision the review is opened on is the filed one; the revision read is the approved one.
  const template = parts.gather_page_review.data.input.input.reviewTargets;
  assert.ok(template.includes("{{ pageRevisionId }}"));
  assertEdgeFrom("gather_page_review", "pageRevisionId", "file_page", "representationRevisionId");
});

test("S7: the declared module hands the review set to the application and touches nothing else", async () => {
  assert.deepEqual(pkg.cinatra.tools, [
    { name: "review_targets", module: "./cinatra/tools/review-targets.mjs" },
    { name: "reviewed_change", module: "./cinatra/tools/reviewed-change.mjs" },
  ]);
  const { extensionTool } = await import("../cinatra/tools/review-targets.mjs");
  assert.equal(typeof extensionTool, "function");

  const reference = { artifactId: "artifact-001", representationRevisionId: "revision-001" };
  const filed = [];
  const touched = new Set();
  const ports = new Proxy(
    { review: { file: (targets) => filed.push(targets) } },
    {
      get(target, key, receiver) {
        touched.add(key);
        return Reflect.get(target, key, receiver);
      },
    },
  );
  const result = await extensionTool({
    input: { op: "review", reviewTargets: JSON.stringify([reference]) },
    ports,
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(filed, [[reference]], "the parsed set is filed once");
  assert.deepEqual([...touched].filter((key) => typeof key === "string"), ["review"], "only the review port is read");

  await assert.rejects(
    extensionTool({ input: { op: "unknown" }, ports: { review: { file: () => {} } } }),
    Error,
    "an unknown op is refused",
  );
});

test("S8: the page snapshot is filed during the run, and the end node binds no artifact", () => {
  const filings = oas.nodes
    .map((n) => n.$component_ref)
    .filter(
      (id) =>
        parts[id]?.component_type === "ApiNode" &&
        parts[id].data?.tool === "artifact_materialize" &&
        parts[id].data?.input?.extension === SNAPSHOT_EXTENSION,
    );
  assert.deepEqual(filings, ["file_page"], "one mid-run filing of the page snapshot");
  const endOutputs = parts.end.outputs;
  assert.deepEqual(titles(endOutputs), [...RUN_OUTPUTS, "message"], "the end node keeps the six run outputs, and the message of a change of nothing");
  assert.deepEqual(
    endOutputs.filter((o) => o.cinatra?.artifact).map((o) => o.title),
    [],
    "no end output carries a binding",
  );
  assert.deepEqual(
    oas.outputs.filter((o) => o.cinatra?.artifact).map((o) => o.title),
    [],
    "no flow output carries a binding",
  );
  for (const output of RUN_OUTPUTS) {
    assertEdgeFrom("end", output, "edit");
    assertEdgeFrom("emit_output", output, "edit");
  }
});
