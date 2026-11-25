// cinatra-ai/cinatra#3745 — the flow reads through the site read tool and writes through the site write tool.
//
// The connector's read proxy `wordpress_site_tool_call` forwards read abilities
// only; a write goes through `wordpress_site_tool_write`, which the platform
// serves to a flow step only as the call of a released publishing step. So the
// read step calls the read tool with `cinatra/post-read`, the publishing step
// calls the write tool with `cinatra/post-update-if-unchanged`, no other step
// names either tool, and the package declares both tools as consumed
// primitives. AGENTS.md names, as known gaps, what the host must serve before
// the flow can run.
//
// Zero-dependency; runs on plain node:test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const flow = JSON.parse(readFileSync(new URL("../cinatra/oas.json", import.meta.url), "utf8"));
const parts = flow.$referenced_components;

const READ_TOOL = "wordpress_site_tool_call";
const WRITE_TOOL = "wordpress_site_tool_write";
const callers = (word) => Object.entries(parts).filter(([, node]) => JSON.stringify(node.data ?? {}).includes(word)).map(([id]) => id);

test("W1: the read step is the one step that calls the read tool, with the read ability", () => {
  assert.deepEqual(callers(READ_TOOL), ["read_page"]);
  assert.equal(parts.read_page.data.tool, READ_TOOL);
  assert.equal(parts.read_page.data.input.toolName, "cinatra/post-read");
});

test("W2: the publishing step is the one step that calls the write tool, with the conditional write ability", () => {
  assert.deepEqual(callers(WRITE_TOOL), ["write_page"]);
  assert.equal(parts.write_page.data.tool, WRITE_TOOL);
  assert.equal(parts.write_page.data.input.toolName, "cinatra/post-update-if-unchanged");
});

test("W3: no step names the old abilities", () => {
  for (const ability of ["ewpa/get-post", "ewpa/get-page", "ewpa/update-post", "ewpa/create-post"]) {
    assert.deepEqual(callers(ability), [], `no step names ${ability}`);
  }
});

test("W4: the read step never names the write tool", () => {
  assert.equal(JSON.stringify(parts.read_page).includes(WRITE_TOOL), false);
});

test("W5: the package consumes both site tools", () => {
  assert.deepEqual(
    pkg.cinatra.consumes.map((entry) => [entry.primitive, entry.requirement]),
    [
      [READ_TOOL, "required"],
      [WRITE_TOOL, "required"],
      ["wordpress_site_tools_list", "optional"],
    ],
  );
});

test("W6: AGENTS.md names, as known gaps, the host change each tool waits on", () => {
  const doc = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
  const gap = doc.split("## KNOWN GAP")[1]?.split("\n## ")[0] ?? "";
  assert.ok(gap.length > 0, "the known-gap section exists");
  const item = (n) => gap.split("\n").find((line) => line.startsWith(`${n}. `)) ?? "";
  assert.ok(item(1).includes(WRITE_TOOL) && item(1).includes("passthroughStep"), "item 1: the host serves the write tool to the publishing step");
  assert.ok(item(2).includes(READ_TOOL) && item(2).includes("cinatra#4796"), "item 2: the host serves the read tool to the read step after it enforces the read class");
  assert.doesNotMatch(doc, /writes?\b[^.\n]{0,60}through `wordpress_site_tool_call`/, "no write goes through the read tool");
});
