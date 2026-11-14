// cinatra-ai/cinatra#3745 — the content editor writes through the site write tool.
//
// The connector's read proxy `wordpress_site_tool_call` forwards read abilities
// only; a write or publish goes through `wordpress_site_tool_write`, which the
// platform holds for the person's recorded decision on an agent run. So the
// write step names the write tool for `ewpa/update-post`, keeps its reads on the
// read tool, and the package declares both tools as consumed primitives. The
// read step stays read-only and never names the write tool.
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

const system = parts.edit.data.system;
const section = (from, to) => system.split(from)[1]?.split(to)[0] ?? "";

test("W1: the write step names both tools and no longer claims a single call primitive", () => {
  assert.ok(system.includes(`\`${READ_TOOL}\``), "the write step names the read tool");
  assert.ok(system.includes(`\`${WRITE_TOOL}\``), "the write step names the write tool");
  assert.doesNotMatch(system, /exactly one WordPress call primitive/, "the one-primitive claim is gone");
});

test("W2: the update ability goes through the write tool, the reads through the read tool", () => {
  const step2 = section("**STEP 2", "**STEP 3");
  assert.ok(step2.includes(WRITE_TOOL), "Step 2 calls the write tool");
  assert.equal(step2.includes(READ_TOOL), false, "Step 2 does not call the read tool");
  assert.match(step2, /recorded decision/, "Step 2 says the write waits for the person's recorded decision");
  const step3 = section("**STEP 3", "**STEP 4");
  assert.ok(step3.includes(READ_TOOL), "Step 3 re-reads through the read tool");
  assert.equal(step3.includes(WRITE_TOOL), false, "Step 3 never names the write tool");
  const lines = section("## How you reach WordPress", "## Rules").split("\n");
  const update = lines.find((line) => line.startsWith("- `ewpa/update-post`")) ?? "";
  assert.ok(update.includes(WRITE_TOOL), "the ability list sends ewpa/update-post through the write tool");
  for (const read of ["ewpa/get-post", "ewpa/get-page"]) {
    const line = lines.find((l) => l.startsWith(`- \`${read}\``)) ?? "";
    assert.ok(line.length > 0, `the ability list names ${read}`);
    assert.equal(line.includes(WRITE_TOOL), false, `${read} is not a write-tool call`);
  }
});

test("W3: the never-list keeps each ability on its own tool", () => {
  const never = section("## What to NEVER do", "\n## ");
  const rule = never.split("\n").find((line) => line.includes("Never call any WordPress ability other than")) ?? "";
  assert.ok(rule.includes(READ_TOOL), "the rule names the read tool");
  assert.ok(rule.includes(WRITE_TOOL), "the rule names the write tool");
  assert.match(rule, /ewpa\/update-post[^.]*wordpress_site_tool_write/, "ewpa/update-post is tied to the write tool");
});

test("W4: the read step stays read-only and never names the write tool", () => {
  const read = parts.read_page.data.system;
  assert.ok(read.includes(READ_TOOL), "the read step reads through the read tool");
  assert.equal(read.includes(WRITE_TOOL), false, "the read step never names the write tool");
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

test("W6: AGENTS.md names the write tool where it describes the write path", () => {
  const doc = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
  const docSection = (from) => doc.split(from)[1]?.split("\n## ")[0] ?? "";
  const gap = docSection("## KNOWN GAP");
  const role = docSection("## Agent role");
  assert.ok(gap.length > 0 && role.length > 0, "the known-gap and role sections exist");
  // The release gate (item 2) is about a write: it must name the write tool,
  // and no sentence of AGENTS.md may send a write through the read tool.
  const gateItem = gap.split("\n").find((line) => line.startsWith("2. ")) ?? "";
  assert.ok(gateItem.includes(WRITE_TOOL), "the review-before-publish gate item names the write tool");
  assert.doesNotMatch(doc, /writes?\b[^.\n]{0,60}through `wordpress_site_tool_call`/, "no write goes through the read tool");
  // The allowlist item (3) must admit both primitives, not only the read tool.
  const allowItem = gap.split("\n").find((line) => line.startsWith("3. ")) ?? "";
  assert.ok(allowItem.includes(READ_TOOL) && allowItem.includes(WRITE_TOOL), "the allowlist item names both tools");
  assert.ok(role.includes(READ_TOOL) && role.includes(WRITE_TOOL), "the role text names both tools");
});
