// cinatra-ai/cinatra#3745 — a change of nothing is told to the person, never a silent success.
//
// The code cannot know whether a request truly needed no change: the compose
// step's answer with no value to save is the same for a request that is
// already satisfied and for a request the composing model dropped. So the run
// still ends completed, with empty `changes` and no `error`, but the no-change
// step answers a `message` built by code (never by the model): a fixed
// sentence that says that no change was proposed for this request on this
// post, that nothing was reviewed or written, and that repeats the request,
// flattened to one line and bounded. The request reaches the step by a data
// edge from the flow's start, and the message reaches the flow's output
// message and its end. On the write road, `write_outcome` hands its own
// message (built by code from the site's answer).
//
// Zero-dependency; runs on plain node:test (`node --test`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(path.join(root, "cinatra/oas.json"), "utf8"));
const parts = oas.$referenced_components;
const STEP = "no_change_outcome";

const load = () => import("../cinatra/tools/reviewed-change.mjs");

const READ = {
  postId: "42",
  title: "Opening hours",
  content: "<p>We are open Monday to Friday.</p>",
  excerpt: "Our hours.",
  status: "publish",
  modified: "2026-11-20 10:00:00",
  address: "https://example.org/opening-hours/",
  error: { code: "", message: "" },
};
const NOTHING = { title: null, content: null, excerpt: null };
const call = (instructions, read = READ, writeFields = NOTHING) => ({
  op: "unchanged",
  instanceId: JSON.stringify("site-1"),
  pageForm: JSON.stringify({ cinatraCmsPage: 1, system: "wordpress", writeFields }),
  instructions: JSON.stringify(instructions),
  postId: JSON.stringify(read.postId),
  readPostId: JSON.stringify(read.postId),
  title: JSON.stringify(read.title),
  content: JSON.stringify(read.content),
  excerpt: JSON.stringify(read.excerpt),
  status: JSON.stringify(read.status),
  modified: JSON.stringify(read.modified),
  address: JSON.stringify(read.address),
  error: JSON.stringify(read.error),
});

const sourcesOf = (node, input) =>
  oas.data_flow_connections
    .filter((e) => e.destination_node.$component_ref === node && e.destination_input === input)
    .map((e) => [e.source_node.$component_ref, e.source_output]);

const LEAD = 'No change was proposed for this request on post 42 ("Opening hours"), so nothing was reviewed or written: ';

test("N1 the no-change outcome carries a message built by code that names the post and repeats the request, and no error", async () => {
  const { extensionTool } = await load();
  const request = "Change the closing time in the content to six";
  const outcome = await extensionTool({ input: call(request), ports: {} });
  assert.deepEqual(outcome, {
    ok: true,
    postId: "42",
    instanceId: "site-1",
    proposalId: "",
    changeSetId: "",
    changes: [],
    error: {},
    message: `${LEAD}${request}`,
  });
  const equal = { title: READ.title, content: null, excerpt: null };
  assert.equal((await extensionTool({ input: call(request, READ, equal), ports: {} })).message, outcome.message, "values equal to the read");
});

test("N2 a long or multi-line request is flattened to one line and cut; an empty request is named as empty", async () => {
  const { extensionTool, REQUEST_MAX } = await load();
  assert.equal(typeof REQUEST_MAX, "number");
  const flat = (await extensionTool({ input: call("Change the title\n\tto  Summer hours\r\nand the excerpt too"), ports: {} })).message;
  assert.equal(flat, `${LEAD}Change the title to Summer hours and the excerpt too`);
  const cut = (await extensionTool({ input: call("word ".repeat(400)), ports: {} })).message;
  assert.ok(cut.startsWith(LEAD));
  assert.ok(cut.endsWith("…"), "a cut request ends with an ellipsis");
  assert.ok(cut.length - LEAD.length <= REQUEST_MAX, "the request part is bounded");
  assert.doesNotMatch(cut, /[\r\n\t]/);
  const longTitle = (await extensionTool({ input: call("x", { ...READ, title: `A\n${"t".repeat(600)}` }), ports: {} })).message;
  assert.doesNotMatch(longTitle, /[\r\n]/);
  assert.ok(longTitle.length < 1000, "the title is bounded too");
  for (const empty of ["", "  \n "]) {
    assert.equal((await extensionTool({ input: call(empty), ports: {} })).message, `${LEAD.slice(0, -2)}; the request was empty.`);
  }
});

test("N3 the message never claims that something was written, saved or published", async () => {
  const { extensionTool } = await load();
  const message = (await extensionTool({ input: call("Fix the typo"), ports: {} })).message;
  const fixed = message.slice(0, message.length - "Fix the typo".length);
  assert.match(fixed, /nothing was reviewed or written/);
  assert.doesNotMatch(fixed.replace("nothing was reviewed or written", ""), /\b(written|saved|published|updated|changed|demoted)\b/i);
});

test("N4 the step takes the request from the start and hands its message to the output message and the end; the write road hands its own", () => {
  const node = parts[STEP];
  assert.ok(node.inputs.some((i) => i.title === "instructions" && i.type === "string"), "the step declares the request");
  assert.deepEqual(sourcesOf(STEP, "instructions"), [["start", "instructions"]]);
  assert.match(node.data.input.input.instructions, /\{\{ instructions \| tojson \}\}/);
  assert.deepEqual(sourcesOf(STEP, "title"), [["check_read", "title"]]);
  assert.deepEqual(sourcesOf(STEP, "postId"), [["start", "postId"]]);
  assert.ok(node.outputs.some((o) => o.title === "message" && o.type === "string"), "the step answers a message");
  assert.deepEqual(sourcesOf("emit_output", "message").sort(), [[STEP, "message"], ["write_outcome", "message"]]);
  assert.deepEqual(sourcesOf("end", "message").sort(), [[STEP, "message"], ["write_outcome", "message"]]);
  const emitInput = parts.emit_output.inputs.find((i) => i.title === "message");
  assert.equal(emitInput?.default, "", "a road whose step answers no message leaves it empty");
  assert.equal(parts.end.outputs.find((o) => o.title === "message")?.default, "");
  assert.ok(oas.outputs.some((o) => o.title === "message" && o.type === "string"), "the flow declares the message");
  assert.match(parts.emit_output.message, /\{\{ message \}\}/, "the scanner sees the plain reference");
  assert.match(parts.emit_output.message, /\{% if message %\},"message":\{\{ message \| tojson \}\}\{% endif %\}/, "the closing message carries it");
});

test("N5 the read check still comes first: a failed read never answers a no-change message", async () => {
  const { extensionTool, FORM_CODE } = await load();
  await assert.rejects(extensionTool({ input: call("x", { ...READ, error: { code: "call_failed", message: "no" } }), ports: {} }), (e) => e.message.startsWith(`${FORM_CODE}: `));
  await assert.rejects(extensionTool({ input: call("x", READ, { title: "New", content: null, excerpt: null }), ports: {} }), (e) => e.message.startsWith(`${FORM_CODE}: `));
});

test("N6 the README says that a change of nothing ends with a message that repeats the request", () => {
  const readme = readFileSync(path.join(root, "README.md"), "utf8");
  assert.doesNotMatch(readme, /Empty `changes` with no `error`: nothing needed changing/);
  assert.match(readme, /no change was proposed/i);
});

// --- a second pass, after the site reported that the post changed ---------------

const RETRY_LEAD =
  'A change was proposed and reviewed for this request on post 42 ("Opening hours"), but the site reported that the post changed meanwhile, so that change was not written. ' +
  "On reading the post again, no further change was proposed (the post may already have the requested state), so nothing further was written.";

/** The notice the outcome step makes for a post_changed answer, which the flow hands to this step. */
async function noticeFor(data) {
  const { extensionTool } = await load();
  const out = await extensionTool({
    input: {
      op: "outcome",
      success: "false",
      code: JSON.stringify("post_changed"),
      data: JSON.stringify(data),
      postId: JSON.stringify("42"),
      instanceId: JSON.stringify("site-1"),
    },
    ports: {},
  });
  assert.equal(out.next, "post_changed");
  return out.reviewNotice;
}

test("N7 after post_changed the final message tells what happened in this run: proposed and reviewed, the post changed meanwhile, nothing further written", async () => {
  const { extensionTool } = await load();
  const reviewNotice = await noticeFor({ changed: ["post_content"] });
  const out = await extensionTool({ input: { ...call("Fix the typo"), reviewNotice: JSON.stringify(reviewNotice) }, ports: {} });
  assert.equal(out.message, `${RETRY_LEAD} Request: Fix the typo`);
  assert.deepEqual(out.changes, []);
  assert.deepEqual(out.error, {});
  assert.doesNotMatch(out.message, /No change was proposed|nothing was reviewed|outdated copy/);
  const empty = await extensionTool({ input: { ...call(""), reviewNotice: JSON.stringify(reviewNotice) }, ports: {} });
  assert.equal(empty.message, RETRY_LEAD);
});

test("N8 the stale-cache warning of the refused attempt is carried into the final message; none is made up", async () => {
  const { extensionTool } = await load();
  const stale = await noticeFor({ changed: ["post_content"], cache_stale: true });
  const out = await extensionTool({ input: { ...call("Fix the typo"), reviewNotice: JSON.stringify(stale) }, ports: {} });
  assert.equal(out.message, `${RETRY_LEAD} The site may still show an outdated copy of the post for a while. Request: Fix the typo`);
  const fresh = await extensionTool({ input: { ...call("Fix the typo"), reviewNotice: JSON.stringify(await noticeFor({ changed: [], cache_stale: false })) }, ports: {} });
  assert.doesNotMatch(fresh.message, /outdated/);
});

test("N9 the step takes the notice only from the write outcome, empty on a first pass, and a first pass keeps its message", async () => {
  const { extensionTool } = await load();
  assert.deepEqual(sourcesOf(STEP, "reviewNotice"), [["write_outcome", "reviewNotice"]]);
  const input = parts[STEP].inputs.find((i) => i.title === "reviewNotice");
  assert.equal(input.type, "string");
  assert.equal(input.default, "", "a first pass has no notice");
  assert.match(parts[STEP].data.input.input.reviewNotice, /\{\{ reviewNotice \| tojson \}\}/);
  const first = await extensionTool({ input: { ...call("Fix the typo"), reviewNotice: JSON.stringify("") }, ports: {} });
  assert.equal(first.message, `${LEAD}Fix the typo`);
});

test("N10 every message that can end a run holds on a second pass too: none says nothing was proposed, filed or reviewed", async () => {
  const { extensionTool, WRITE_REFUSALS } = await load();
  const messages = [];
  for (const input of [{ op: "page", success: "false", code: JSON.stringify("not_found") }, { op: "form", pageForm: "x" }]) {
    try {
      await extensionTool({ input, ports: {} });
    } catch (err) {
      messages.push(err.message);
    }
  }
  assert.equal(messages.length, 2);
  messages.push(...Object.values(WRITE_REFUSALS));
  for (const message of messages) {
    assert.doesNotMatch(message, /nothing was (proposed|reviewed|filed)|no change was proposed/i, message);
  }
  assert.ok(messages.some((m) => m.includes("no change was written")), "the failed read says that no change was written");
});
