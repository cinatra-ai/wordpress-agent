// Bridge outputs declare their item members — cinatra-ai/wordpress-agent#43.
//
// The runtime asks the model for exactly the shape a bridge node declares. An
// object level with no declared members is sent CLOSED and EMPTY, so an answer
// carries nothing inside it and structured consumers get unfielded entries.
// Issue #43 named two outputs of this pack measured that way at the flow this
// pack shipped at 5caf24d4 — `changes` and `error` on the `edit` bridge node.
// Since cinatra#3745 no model reads or writes the site: the write's `changes`
// and `error` are built by code, and the one bridge node left is
// `compose_change`. This suite holds every bridge output closed: it mirrors
// the host loader's own derivation pass (`_declared_members` /
// `_declared_items` / `_output_property_json_schema`, both agentspec spellings,
// the branch keywords and the array-without-items case) and asserts the pass
// reports nothing free-form anywhere in this flow.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(join(root, "cinatra", "oas.json"), "utf8"));

const LLM_BRIDGE_PATH = "/api/llm-bridge";
const BRANCH_KEYWORDS = ["anyOf", "oneOf", "allOf"];

/** True when an ApiNode `url` addresses the host's LLM bridge. */
const targetsLlmBridge = (url) =>
  typeof url === "string" && url.endsWith(LLM_BRIDGE_PATH);

/** The member map a declaration carries, in EITHER agentspec spelling. */
function declaredMembers(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  let members = node.properties;
  if (!members || typeof members !== "object" || Array.isArray(members)) {
    const nested = node.json_schema;
    members =
      nested && typeof nested === "object" && !Array.isArray(nested)
        ? nested.properties
        : undefined;
  }
  if (!members || typeof members !== "object" || Array.isArray(members)) return null;
  // An EMPTY map is not a declaration of members.
  return Object.keys(members).length > 0 ? members : null;
}

/** The item declaration a declaration carries, in EITHER spelling. */
function declaredItems(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
  if (node.items !== undefined && node.items !== null) return node.items;
  const nested = node.json_schema;
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested.items
    : undefined;
}

/** Every type a declaration names, in EITHER spelling. */
function declaredTypes(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return [];
  const declared = node.type;
  if (typeof declared === "string") return [declared];
  if (Array.isArray(declared)) return declared.filter((e) => typeof e === "string");
  return [];
}

/** Walk one declared subschema, collecting the levels the request cannot promise. */
function walkSubschema(node, path, freeForm) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const members = declaredMembers(node);
  if (members !== null) {
    for (const [name, member] of Object.entries(members))
      walkSubschema(member, `${path}.${name}`, freeForm);
  } else if (declaredTypes(node).includes("object")) {
    freeForm.push(path);
  }
  for (const keyword of BRANCH_KEYWORDS) {
    const branches = node[keyword];
    if (Array.isArray(branches))
      branches.forEach((branch, index) =>
        walkSubschema(branch, `${path}|${keyword}[${index}]`, freeForm),
      );
  }
  const items = declaredItems(node);
  if (Array.isArray(items)) {
    items.forEach((item, index) => walkSubschema(item, `${path}[${index}]`, freeForm));
  } else if (items !== undefined && items !== null) {
    walkSubschema(items, `${path}[]`, freeForm);
  } else if (declaredTypes(node).includes("array")) {
    freeForm.push(`${path}[]`);
  }
}

/** The free-form levels of ONE declared output property. */
function freeFormLevels(prop) {
  const freeForm = [];
  if (!prop || typeof prop !== "object") return freeForm;
  const { title, type } = prop;
  if (typeof title !== "string" || !title) return freeForm;
  if (typeof type !== "string" || !type) return freeForm;
  const members = declaredMembers(prop);
  if (members !== null) {
    for (const [name, member] of Object.entries(members))
      walkSubschema(member, `${title}.${name}`, freeForm);
  } else if (type === "object") {
    freeForm.push(title);
  }
  const items = declaredItems(prop);
  if (Array.isArray(items)) {
    items.forEach((item, index) => walkSubschema(item, `${title}[${index}]`, freeForm));
  } else if (items !== undefined && items !== null) {
    walkSubschema(items, `${title}[]`, freeForm);
  } else if (type === "array") {
    freeForm.push(`${title}[]`);
  }
  return freeForm;
}

/** Every ApiNode of this flow that addresses the LLM bridge, embedded copies included. */
function bridgeNodes(node, found = []) {
  if (Array.isArray(node)) {
    for (const value of node) bridgeNodes(value, found);
  } else if (node && typeof node === "object") {
    if (node.component_type === "ApiNode" && targetsLlmBridge(node.url)) found.push(node);
    for (const value of Object.values(node)) bridgeNodes(value, found);
  }
  return found;
}

const nodes = bridgeNodes(oas);
const nodeById = new Map(nodes.map((n) => [n.id, n]));
const outputs = (id) => nodeById.get(id)?.outputs ?? [];
const output = (id, title) => outputs(id).find((o) => o?.title === title);

/** A shape is intentionally open only where its own description records that. */
const FREE_FORM_WORDS = [
  "free-form",
  "free form",
  "freeform",
  "arbitrary",
  "unstructured",
  "no fixed shape",
  "opaque",
];
const recordsIntent = (prop) =>
  typeof prop?.description === "string" &&
  FREE_FORM_WORDS.some((word) => prop.description.toLowerCase().includes(word));

test("no bridge output of this flow leaves a level without declared members", () => {
  assert.ok(nodes.length > 0, "the flow carries at least one bridge node");
  const open = [];
  for (const node of nodes)
    for (const prop of node.outputs ?? []) {
      const levels = freeFormLevels(prop);
      if (levels.length > 0 && !recordsIntent(prop))
        open.push(`${node.id} / ${prop.title}: ${levels.join(", ")}`);
    }
  assert.deepEqual(
    open,
    [],
    "every bridge output declares its members, or records in its own description that the shape is intentionally free-form",
  );
});

test("the one model step declares the members of its error and of the values to save", () => {
  // cinatra#3745: the read and the write no longer run on the model bridge, so
  // `changes` and the write's `error` are built by code (write_outcome). The
  // one bridge node left, `compose_change`, declares its `error` as
  // `{ code, message }` and its `pageForm.writeFields` as the three values.
  assert.deepEqual(nodes.map((node) => node.id), ["compose_change"]);
  const error = output("compose_change", "error");
  assert.equal(error.type, "object");
  assert.deepEqual(Object.keys(error.json_schema.properties).sort(), ["code", "message"]);
  for (const name of ["code", "message"])
    assert.deepEqual(error.json_schema.properties[name], { type: "string" }, `${name} is a string`);
  const form = output("compose_change", "pageForm");
  assert.deepEqual(Object.keys(form.json_schema.properties.writeFields.properties).sort(), ["content", "excerpt", "title"]);
  assert.deepEqual(freeFormLevels(error), []);
});
