// cinatra-ai/cinatra#3745 — what is filed is a snapshot the display draws, the
// approved revision is the snapshot of this run's post, its addresses come from
// the read and never from a model's answer, and only a successful read leads
// anywhere.
//
// 1. The status of a post never changes without a text change: the values to
//    save carry only the title, the content and the excerpt, a request names
//    no status, and the write step demotes a published post only together with
//    the reviewed text. A compose answer that names another field is refused.
// 2. One check, used by the form step on what it files and by the read-back on
//    the approved revision: the display's parser accepts the snapshot, the
//    system is WordPress, each excerpt has the exact form the form step builds,
//    and the page record equals, key by key, the record built from this run's
//    read (post id, status, title, address and edit address).
// 3. The page record is built by code from the read step's values; the compose
//    step answers no page record, and an address a model writes never reaches
//    it.
// 4. A successful read is defined positively: an error object whose code and
//    message are both empty, a status this flow edits (publish, draft,
//    pending, private, future), a change time, a title and a content that are
//    texts, and a post id of the run that the read answered too. Every other
//    read, of any shape, and every flow default standing in for one, is
//    refused: it never ends the run as a change of nothing.
//
// Zero-dependency; runs on plain node:test (`node --test`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(join(root, "cinatra", "oas.json"), "utf8"));
const parts = oas.$referenced_components;

const FORM_CODE = "page_form_unavailable";
const READ_CODE = "reviewed_change_unavailable";
const refusedWith = (code) => (err) =>
  err instanceof Error && err.name === "ExtensionToolCallRefusal" && err.message.startsWith(`${code}: `) && !err.message.includes("\n");
const refusedSaying = (code, text) => (err) => refusedWith(code)(err) && err.message.includes(text);

const load = () => import("../cinatra/tools/reviewed-change.mjs");

const READ = {
  postId: "42",
  title: "Opening hours",
  content: "<h2>When we are open</h2><p>We are open Monday to Friday.</p>",
  excerpt: "Our hours.",
  status: "draft",
  modified: "2026-11-20 10:00:00",
  address: "https://example.org/opening-hours/",
  error: { code: "", message: "" },
};
const PAGE = {
  postId: "42",
  status: "draft",
  title: "Opening hours",
  address: "https://example.org/opening-hours/",
  cmsAddress: null,
};

/** The read inputs as the flow renders them: each value as JSON text. The run's post id comes from the start, the read's from the read step. */
const readInputs = (read = READ) => ({
  postId: JSON.stringify(read.postId),
  readPostId: JSON.stringify(read.readPostId ?? read.postId),
  title: JSON.stringify(read.title),
  content: JSON.stringify(read.content),
  excerpt: JSON.stringify(read.excerpt),
  status: JSON.stringify(read.status),
  modified: JSON.stringify(read.modified),
  rowToken: JSON.stringify("a".repeat(64)),
  address: JSON.stringify(read.address),
  error: JSON.stringify(read.error),
});
const composed = (writeFields, page) => JSON.stringify({ cinatraCmsPage: 1, system: "wordpress", ...(page ? { page } : {}), writeFields });
const formCall = (writeFields, read = READ, page) => ({ op: "form", pageForm: composed(writeFields, page), ...readInputs(read) });
const unchangedCall = (writeFields, read = READ) => ({ op: "unchanged", instanceId: JSON.stringify("site-1"), pageForm: composed(writeFields), ...readInputs(read) });

const FILED = { artifactId: "artifact-7", representationRevisionId: "revision-1" };
const ANSWER = JSON.stringify({ approved: true, review: { envelopeVersion: 1, decision: "approved", targets: [FILED] } });
const readCall = (read = READ) => ({ op: "read", artifactId: JSON.stringify(FILED.artifactId), reviewAnswer: JSON.stringify(ANSWER), ...readInputs(read) });
const portsWith = (form) => ({
  artifacts: {
    async contentRead(request) {
      return { ...request, text: typeof form === "string" ? form : JSON.stringify(form), truncated: false };
    },
  },
});

const CONTENT_CHANGE = { title: null, content: READ.content.replace("Friday", "Saturday"), excerpt: null };
const NOTHING = { title: null, content: null, excerpt: null };

const sourcesOf = (node, input) =>
  oas.data_flow_connections
    .filter((e) => e.destination_node.$component_ref === node && e.destination_input === input)
    .map((e) => [e.source_node.$component_ref, e.source_output]);
const members = (declaration) => declaration?.properties ?? declaration?.json_schema?.properties ?? {};
const find = (list, title) => (list ?? []).find((entry) => entry.title === title);

// --- 1. no status change without a text change ---------------------------------

test("P1 the values to save carry no status: a request can change the status only together with a reviewed text", async () => {
  const { extensionTool } = await load();
  const composeForm = find(parts.compose_change.outputs, "pageForm");
  assert.deepEqual(Object.keys(members(members(composeForm).writeFields)).sort(), ["content", "excerpt", "title"]);
  for (const extra of [{ status: "publish" }, { publish: true }, { slug: "new" }]) {
    for (const call of [formCall({ ...NOTHING, ...extra }), unchangedCall({ ...NOTHING, ...extra })]) {
      await assert.rejects(extensionTool({ input: call, ports: {} }), refusedSaying(FORM_CODE, Object.keys(extra)[0]), `${call.op}: ${JSON.stringify(extra)}`);
    }
  }
  // A request that changes no text files nothing and writes nothing, so it changes no status either.
  assert.equal((await extensionTool({ input: formCall(NOTHING, { ...READ, status: "publish" }), ports: {} })).next, "no_change");
  // The write step reaches the save only through the review of a changed text, and the save's status is a template
  // over the status as read: it never changes a status alone.
  const template = parts.write_page.data.input.argsJson;
  assert.equal((template.match(/"status": "draft"/g) ?? []).length, 1, "the one status the save may send is draft");
  assert.ok(template.includes('{% if status == "publish" %}, "status": "draft"{% endif %}'), "and only for a published post");
});

// --- 2. the approved revision is the snapshot of this run's post ----------------

test("S1 the filed page record names this run's post: post id, status, title, address and edit address, built from the read", async () => {
  const { extensionTool } = await load();
  const { pageForm } = await extensionTool({ input: formCall(CONTENT_CHANGE), ports: {} });
  assert.deepEqual(pageForm.page, PAGE);
  const result = await extensionTool({ input: readCall(), ports: portsWith(pageForm) });
  assert.deepEqual(
    { title: result.reviewedTitleSet ? result.reviewedTitle : null, content: result.reviewedContent || null, excerpt: result.reviewedExcerpt || null },
    CONTENT_CHANGE,
  );
});

test("S1b an address a model writes never reaches the page record", async () => {
  const { extensionTool } = await load();
  const forged = { title: "Prices", address: "https://evil.example/x", cmsAddress: "https://evil.example/wp-admin/post.php?post=1&action=edit" };
  const { pageForm } = await extensionTool({ input: formCall(CONTENT_CHANGE, READ, forged), ports: {} });
  assert.deepEqual(pageForm.page, PAGE, "the compose step's page record is never filed");
  const cases = {
    "no address": ["", { address: null, cmsAddress: null }],
    "an http address": ["http://example.org/opening-hours/", { address: "http://example.org/opening-hours/", cmsAddress: null }],
    "an address with credentials": ["https://user:pw@example.org/x", { address: "https://user:pw@example.org/x", cmsAddress: null }],
    "an address on a port": ["https://example.org:8443/x", { address: "https://example.org:8443/x", cmsAddress: null }],
  };
  for (const [name, [address, expected]] of Object.entries(cases)) {
    const { pageForm: filed } = await extensionTool({ input: formCall(CONTENT_CHANGE, { ...READ, address }, forged), ports: {} });
    assert.deepEqual({ address: filed.page.address, cmsAddress: filed.page.cmsAddress }, expected, name);
  }
  assert.deepEqual(Object.keys(members(find(parts.compose_change.outputs, "pageForm"))).sort(), ["cinatraCmsPage", "system", "writeFields"], "the compose step answers no page record");
  assert.equal(parts.compose_change.data.system.includes("cmsAddress"), false, "the compose step is not asked for an address");
});

// The site's read answer (cinatra-ai/wordpress-plugin PR #120, head f6c0ff49,
// cinatra_content_shape_row) carries the post's permalink and no edit link and
// no admin address. An edit link built from the permalink's origin is wrong for
// a site installed below a path or administered on another address, and can
// open another installation's post with the same id: none is built.
test("S1c the edit address is never built from the permalink: no edit link in the site's answer files none", async () => {
  const { extensionTool } = await load();
  const cases = {
    "WordPress installed below /blog": "https://example.org/blog/opening-hours/",
    "a public address other than the installation's": "https://www.example.org/opening-hours/",
    "a plain https permalink": "https://example.org/opening-hours/",
  };
  for (const [name, address] of Object.entries(cases)) {
    const { pageForm: filed } = await extensionTool({ input: formCall(CONTENT_CHANGE, { ...READ, address }), ports: {} });
    assert.equal(filed.page.address, address, `${name}: the address is the permalink as read, unchanged`);
    assert.equal(filed.page.cmsAddress, null, `${name}: no edit address is made up`);
  }
  assert.equal(parts.read_page.outputs.some((o) => /edit|admin/i.test(o.title)), false, "the read step answers no edit link to take");
});

test("S2 a revision whose page record is missing or names another post, status, title or address is refused, saying which part differs", async () => {
  const { extensionTool } = await load();
  const { pageForm } = await extensionTool({ input: formCall(CONTENT_CHANGE), ports: {} });
  const page = pageForm.page;
  const cases = {
    "no page record": [{ ...pageForm, page: undefined }, "page record"],
    "a page record that is not an object": [{ ...pageForm, page: "Opening hours" }, "page record"],
    "another post": [{ ...pageForm, page: { ...page, postId: "43" } }, "post id"],
    "no post id": [{ ...pageForm, page: { ...page, postId: undefined } }, "post id"],
    "another title": [{ ...pageForm, page: { ...page, title: "Prices" } }, "title"],
    "another status": [{ ...pageForm, page: { ...page, status: "publish" } }, "status"],
    "another address": [{ ...pageForm, page: { ...page, address: "https://evil.example/x" } }, "address"],
    "another edit address": [{ ...pageForm, page: { ...page, cmsAddress: "https://evil.example/wp-admin/post.php?post=42&action=edit" } }, "edit address"],
    "an extra key": [{ ...pageForm, page: { ...page, id: "43" } }, "page record"],
    "another system": [{ ...pageForm, system: "drupal" }, "WordPress"],
  };
  for (const [name, [form, part]] of Object.entries(cases)) {
    await assert.rejects(extensionTool({ input: readCall(), ports: portsWith(form) }), refusedSaying(READ_CODE, part), name);
  }
  // The same revision read against another read is refused: the snapshot names post 42 as a draft.
  await assert.rejects(extensionTool({ input: readCall({ ...READ, postId: "43" }), ports: portsWith(pageForm) }), refusedSaying(READ_CODE, "post id"), "another run's post");
  await assert.rejects(extensionTool({ input: readCall({ ...READ, status: "publish" }), ports: portsWith(pageForm) }), refusedSaying(READ_CODE, "status"), "another status read");
  await assert.rejects(extensionTool({ input: readCall({ ...READ, address: "https://example.org/other/" }), ports: portsWith(pageForm) }), refusedSaying(READ_CODE, "address"), "another address read");
});

test("S3 an excerpt that has not the form the display draws, or not the form the form step builds, is refused", async () => {
  const { extensionTool } = await load();
  const { pageForm } = await extensionTool({ input: formCall({ ...CONTENT_CHANGE, title: "Hours" }), ports: {} });
  const [title, block] = pageForm.excerpts;
  assert.equal(title.region, "title");
  assert.equal(block.region, "content");
  const cases = {
    "a kind the display does not draw": [title, { ...block, kind: "quote" }],
    "a heading without its level": [{ ...title, level: undefined }, block],
    "a heading level out of range": [{ ...title, level: 7 }, block],
    "a level on a paragraph": [title, { ...block, level: 2 }],
    "a negative position": [title, { ...block, position: -1 }],
    "a position that is not a whole number": [title, { ...block, position: 1.5 }],
    "positions that do not rise in a region": [title, block, { ...block }],
    "two sides with the same words": [title, { ...block, proposed: block.published.replace(" open ", "  open ") }],
    "a side that is not text": [title, { ...block, proposed: 3 }],
    "no region": [title, { ...block, region: "" }],
    "an extra key": [title, { ...block, note: "x" }],
    "a missing key": [title, (({ level, ...rest }) => rest)(block)],
    "an entry that is not an object": [title, "x"],
    "excerpts that are not a list": "x",
    "no excerpts": [],
  };
  for (const [name, excerpts] of Object.entries(cases)) {
    await assert.rejects(extensionTool({ input: readCall(), ports: portsWith({ ...pageForm, excerpts }) }), refusedWith(READ_CODE), name);
  }
  const tooMany = Array.from({ length: 201 }, (_, i) => ({ ...block, position: i }));
  await assert.rejects(extensionTool({ input: readCall(), ports: portsWith({ ...pageForm, excerpts: tooMany }) }), refusedWith(READ_CODE), "more than 200 excerpts");
});

test("S4 the one check is the one the form step applies to what it files", async () => {
  const { checkedSnapshot, extensionTool } = await load();
  assert.equal(typeof checkedSnapshot, "function");
  const { pageForm } = await extensionTool({ input: formCall(CONTENT_CHANGE), ports: {} });
  const refuse = (cause) => {
    const error = new Error(`${READ_CODE}: ${cause}`);
    error.name = "ExtensionToolCallRefusal";
    throw error;
  };
  assert.doesNotThrow(() => checkedSnapshot(pageForm, PAGE, refuse));
  assert.throws(() => checkedSnapshot({ ...pageForm, excerpts: [] }, PAGE, refuse), refusedSaying(READ_CODE, "no-excerpts"));
  assert.throws(() => checkedSnapshot({ ...pageForm, page: { ...PAGE, postId: "43" } }, PAGE, refuse), refusedSaying(READ_CODE, "post id"));
  const source = readFileSync(join(root, "cinatra/tools/reviewed-change.mjs"), "utf8");
  assert.equal((source.match(/checkedSnapshot\(/g) ?? []).length, 3, "declared once, called by the form step and by the read-back");
});

// --- 3. only a successful read leads anywhere ------------------------------------

const FAILED_READS = {
  "an empty error object": { ...READ, error: {} },
  "an error with a message and no code": { ...READ, error: { message: "failure" } },
  "an error with a code and no message": { ...READ, error: { code: "" } },
  "an error that is null": { ...READ, error: null },
  "an error that is text": { ...READ, error: "failure" },
  "a failure code": { ...READ, error: { code: "call_failed", message: "The site did not answer." } },
  "a message beside an empty code": { ...READ, error: { code: "", message: "The site did not answer." } },
  "an unknown status": { ...READ, status: "unknown" },
  "a trashed post": { ...READ, status: "trash" },
  "an automatic draft": { ...READ, status: "auto-draft" },
  "a revision": { ...READ, status: "inherit" },
  "no status": { ...READ, status: "" },
  "no change time": { ...READ, modified: "" },
  "a title that is not text": { ...READ, title: null },
  "a content that is not text": { ...READ, content: null },
  "no post id": { ...READ, postId: "" },
  "a post id that is not a number": { ...READ, postId: "42&x=1" },
  "another post read": { ...READ, readPostId: "43" },
};

test("R1 a failed read of any shape is refused at every step of the tool, never routed as no change", async () => {
  const { extensionTool } = await load();
  const { pageForm } = await extensionTool({ input: formCall(CONTENT_CHANGE), ports: {} });
  for (const [name, read] of Object.entries(FAILED_READS)) {
    await assert.rejects(extensionTool({ input: formCall(NOTHING, read), ports: {} }), refusedWith(FORM_CODE), `form: ${name}`);
    await assert.rejects(extensionTool({ input: unchangedCall(NOTHING, read), ports: {} }), refusedWith(FORM_CODE), `unchanged: ${name}`);
    await assert.rejects(extensionTool({ input: formCall(CONTENT_CHANGE, read), ports: {} }), refusedWith(FORM_CODE), `form with a change: ${name}`);
    await assert.rejects(extensionTool({ input: readCall(read), ports: portsWith(pageForm) }), refusedWith(READ_CODE), `read: ${name}`);
  }
  await assert.rejects(
    extensionTool({ input: formCall(NOTHING, { ...READ, error: { message: "The site did not answer." } }), ports: {} }),
    refusedSaying(FORM_CODE, "The site did not answer."),
    "the read's own message is the reason",
  );
  await assert.rejects(extensionTool({ input: unchangedCall(NOTHING, { ...READ, error: {} }), ports: {} }), refusedSaying(FORM_CODE, "no successful read"), "a fixed reason otherwise");
  await assert.rejects(extensionTool({ input: formCall(NOTHING, { ...READ, status: "trash" }), ports: {} }), refusedSaying(FORM_CODE, "trash"), "the status is named");
});

test("R2 a read input missing from the call, or standing at the flow's default, is refused at every step of the tool", async () => {
  const { extensionTool } = await load();
  const { pageForm } = await extensionTool({ input: formCall(CONTENT_CHANGE), ports: {} });
  const steps = { form_page: formCall(NOTHING), no_change_outcome: unchangedCall(NOTHING), read_reviewed_page: readCall() };
  // At their defaults, `title`, `content`, `excerpt` and `address` are real
  // answers (a post with no title, no body, no excerpt or no address): those
  // are refused only when missing, and the other inputs still decide.
  const READ_INPUTS = ["postId", "readPostId", "title", "content", "excerpt", "status", "modified", "address", "error"];
  const REAL_AT_DEFAULT = new Set(["title", "content", "excerpt", "address"]);
  for (const [step, input] of Object.entries(steps)) {
    const declared = Object.fromEntries(parts[step].inputs.map((i) => [i.title, i]));
    for (const name of READ_INPUTS) {
      assert.ok(name in declared, `${step} declares ${name}`);
      assert.equal(sourcesOf(step, name).length, 1, `${step}.${name} has one source`);
      assert.ok("default" in declared[name], `${step}.${name} has a default`);
      const atDefault = { ...input, [name]: JSON.stringify(declared[name].default) };
      if (!REAL_AT_DEFAULT.has(name)) {
        await assert.rejects(extensionTool({ input: atDefault, ports: portsWith(pageForm) }), refusedWith(step === "read_reviewed_page" ? READ_CODE : FORM_CODE), `${step}: ${name} at its default`);
      }
      const missing = { ...input };
      delete missing[name];
      await assert.rejects(extensionTool({ input: missing, ports: portsWith(pageForm) }), refusedWith(step === "read_reviewed_page" ? READ_CODE : FORM_CODE), `${step}: no ${name}`);
    }
    const allDefaults = { ...input };
    for (const name of READ_INPUTS) allDefaults[name] = JSON.stringify(declared[name].default);
    await assert.rejects(extensionTool({ input: allDefaults, ports: portsWith(pageForm) }), refusedWith(step === "read_reviewed_page" ? READ_CODE : FORM_CODE), `${step}: every read input at its default`);
    for (const value of ["{}", "null", "\"\"", JSON.stringify({ message: "x" })]) {
      await assert.rejects(extensionTool({ input: { ...input, error: value }, ports: portsWith(pageForm) }), refusedWith(step === "read_reviewed_page" ? READ_CODE : FORM_CODE), `${step}: error ${value}`);
    }
  }
});

test("R3 the steps take the read's values from the check of the read, and the run's post id from the start", () => {
  for (const step of ["form_page", "no_change_outcome", "read_reviewed_page"]) {
    for (const name of ["title", "content", "excerpt", "status", "modified", "address", "error"]) {
      assert.deepEqual(sourcesOf(step, name), [["check_read", name]], `${step}.${name}`);
    }
    assert.deepEqual(sourcesOf(step, "readPostId"), [["check_read", "postId"]], `${step}.readPostId`);
    assert.deepEqual(sourcesOf(step, "postId"), [["start", "postId"]], `${step}.postId`);
  }
  for (const id of ["form_page", "file_page"]) {
    const form = id === "form_page" ? find(parts[id].outputs, "pageForm") : find(parts[id].inputs, "pageForm");
    assert.deepEqual(Object.keys(members(members(form).page)).sort(), ["address", "cmsAddress", "postId", "status", "title"], `${id}: the page record`);
  }
});

test("R4 a successful read that asks for no change still ends the run as a change of nothing", async () => {
  const { extensionTool } = await load();
  const told = (title) => ({
    ok: true,
    postId: "42",
    instanceId: "site-1",
    proposalId: "",
    changeSetId: "",
    changes: [],
    error: {},
    message: `No change was proposed for this request on post 42 ("${title}"), so nothing was reviewed or written; the request was empty.`,
  });
  const outcome = told(READ.title);
  const equal = { title: READ.title, content: READ.content, excerpt: READ.excerpt };
  for (const status of ["publish", "draft"]) {
    for (const writeFields of [NOTHING, equal]) {
      const read = { ...READ, status };
      assert.equal((await extensionTool({ input: formCall(writeFields, read), ports: {} })).next, "no_change", `${status}: form`);
      assert.deepEqual(await extensionTool({ input: unchangedCall(writeFields, read), ports: {} }), outcome, `${status}: unchanged`);
    }
  }
  const bare = { ...READ, title: "", content: "", excerpt: "", address: "" };
  assert.deepEqual(await extensionTool({ input: unchangedCall(NOTHING, bare), ports: {} }), told(""), "a post with no title, body, excerpt or address");
});
