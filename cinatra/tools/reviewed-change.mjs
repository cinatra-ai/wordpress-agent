/**
 * THE REVIEWED CHANGE: the page snapshot form the review shows, and the values
 * read back from the revision the review approved.
 *
 * Two operations, one per step of the flow:
 *
 * - `form` (step `form_page`, in front of the filing). The compose step answers
 *   the values to save (`writeFields`: the complete new `title`, `content` and
 *   `excerpt`, each a non-empty string or null). A value that equals the post
 *   as read is set to null: null means "not saved", so only a field that
 *   changes is filed and saved. This operation derives the excerpts the review
 *   shows from those values and the post as read, by code: each value is split
 *   into blocks by one rule, the blocks of the post as read and of the value
 *   are compared, and every block that differs is shown as its source text,
 *   markup and link targets included. The blocks it does not show are byte for
 *   byte the post as read. So no value can be saved that the review did not
 *   show. The excerpts the compose step answers, if any, are never filed. It
 *   also answers `next`: `no_change` when no value changes the post, so the
 *   flow ends the run completed past the filing and the review; `review`
 *   otherwise.
 * - `unchanged` (step `no_change_outcome`, on that road). It derives the
 *   changed values again, refuses unless none is left, and answers the run's
 *   outcome: the post, no changes, no error.
 * - `read` (step `read_reviewed_page`, after the review). It takes the revision
 *   the review's answer approves for the filed artifact, never the revision
 *   this run filed (after a Regenerate the approved revision is a successor of
 *   it). It reads that revision through the host's artifact read port by its
 *   revision id, derives the excerpts again from its `writeFields` and the post
 *   as read, and answers the values only when they equal the excerpts the
 *   revision shows and every value it would save is shown by them.
 *
 * Each operation refuses by the host's documented means: it throws an error
 * named `ExtensionToolCallRefusal` whose message is one sentence that starts
 * with its code (`page_form_unavailable` for `form` and `unchanged`,
 * `reviewed_change_unavailable` for `read`). The step and the run fail, so the
 * write step never runs. It reads no port but the artifact read, and writes no
 * port, no table and no artifact.
 */

export const FORM_CODE = "page_form_unavailable";
export const READ_CODE = "reviewed_change_unavailable";

/** The type of the page snapshot the flow files. */
const PAGE_TYPE = "@cinatra-ai/website-artifacts:page-snapshot";

/** The one envelope version of the review's answer this module reads. */
const ENVELOPE_VERSION = 1;

/** The display refuses a form with more excerpts. */
const MAX_EXCERPTS = 200;

/**
 * The longest text, in characters, of a value as read or to save that the tool
 * takes at all: far above any post a person reviews block by block, and it
 * bounds the work of splitting a value into blocks.
 */
const MAX_TEXT = 2_000_000;

/** The most top-level blocks a content value may have: it bounds the memory of the block lists. */
const MAX_BLOCKS = 20_000;

/**
 * The most cells of the comparison table, which covers only the blocks between
 * the unchanged blocks at the start and at the end of the content. 4,000,000
 * cells of 4 bytes are 16 MB, and admit for example a part of 2,000 blocks on
 * each side: ten times the 200 changed blocks the display can show, so a change
 * the display can show is refused only when its first and last changed block
 * are more than about 2,000 blocks apart.
 */
const MAX_TABLE_CELLS = 4_000_000;

/** The ONE name the host reads as a module's refusal of a call. */
const REFUSAL_NAME = "ExtensionToolCallRefusal";

/** The host repeats a refusal sentence of at most this many characters. */
const SENTENCE_MAX = 400;

const FIELDS = ["title", "content", "excerpt"];

class Refusal extends Error {
  constructor(code, cause) {
    const start = code === FORM_CODE ? "nothing was filed" : "nothing was written";
    const line = `${code}: ${start}, because ${cause}; start a new run.`.replace(/\s+/g, " ").trim();
    super(line.length <= SENTENCE_MAX ? line : `${line.slice(0, SENTENCE_MAX - 1).trimEnd()}…`);
    this.name = REFUSAL_NAME;
  }
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isNonBlank = (value) => typeof value === "string" && value.trim() !== "";

/** A text value the flow sends as JSON text (or as the bare text), read back; "" when absent. */
function readText(value) {
  if (typeof value !== "string") return "";
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "string") return parsed;
  } catch {
    // the bare text itself
  }
  return value;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** An object value the flow sends as JSON text, or as the object. */
function readObject(value) {
  if (isPlainObject(value)) return value;
  if (typeof value !== "string") return undefined;
  let parsed = parseJson(value);
  if (typeof parsed === "string") parsed = parseJson(parsed);
  return isPlainObject(parsed) ? parsed : undefined;
}

/** The two texts hold the same words, white space aside: the display shows no difference. */
const sameWords = (a, b) => a.trim().split(/\s+/).join(" ") === b.trim().split(/\s+/).join(" ");

// --- the blocks of a value -------------------------------------------------

const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const OPEN_TAG = /<([A-Za-z][A-Za-z0-9-]*)/y;
const ANY_TAG = /<(\/?)([A-Za-z][A-Za-z0-9-]*)/y;

/** The index after the `>` that closes the tag starting at `from`, quotes respected. */
function tagEnd(text, from) {
  let quote = null;
  for (let i = from + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i + 1;
    }
  }
  return text.length;
}

function commentEnd(text, from) {
  const end = text.indexOf("-->", from + 4);
  return end < 0 ? text.length : end + 3;
}

/** The index after the element that starts at `from`, with its matching end tag. */
function elementEnd(text, from, name) {
  const first = tagEnd(text, from);
  if (VOID_ELEMENTS.has(name) || text[first - 2] === "/") return first;
  let depth = 1;
  let i = first;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) return text.length;
    if (text.startsWith("<!--", lt)) {
      i = commentEnd(text, lt);
      continue;
    }
    ANY_TAG.lastIndex = lt;
    const match = ANY_TAG.exec(text);
    const end = tagEnd(text, lt);
    if (match !== null && match[2].toLowerCase() === name) {
      if (match[1] === "/") depth -= 1;
      else if (text[end - 2] !== "/") depth += 1;
      if (depth === 0) return end;
    }
    i = match !== null ? end : lt + 1;
  }
  return text.length;
}

function startsBlock(text, at) {
  if (text.startsWith("<!--", at)) return true;
  OPEN_TAG.lastIndex = at;
  return OPEN_TAG.test(text);
}

/**
 * The top-level blocks of a value, in order: an element with its content, a
 * comment, or a run of text between them. White space between blocks belongs
 * to the block before it. The blocks joined are the value, byte for byte.
 */
export function blocksOf(text) {
  const blocks = [];
  let i = 0;
  while (i < text.length) {
    let end;
    if (text.startsWith("<!--", i)) {
      end = commentEnd(text, i);
    } else {
      OPEN_TAG.lastIndex = i;
      const match = OPEN_TAG.exec(text);
      if (match !== null) {
        end = elementEnd(text, i, match[1].toLowerCase());
      } else {
        end = i + 1;
        while (end < text.length) {
          const lt = text.indexOf("<", end);
          if (lt < 0) {
            end = text.length;
            break;
          }
          if (startsBlock(text, lt)) {
            end = lt;
            break;
          }
          end = lt + 1;
        }
      }
    }
    const piece = text.slice(i, end);
    if (piece.trim() === "" && blocks.length > 0) blocks[blocks.length - 1] += piece;
    else blocks.push(piece);
    i = end;
  }
  if (blocks.length > 1 && blocks[0].trim() === "") blocks.splice(0, 2, blocks[0] + blocks[1]);
  return blocks;
}

/** The kind and level the display draws a block as. */
function kindOf(block) {
  const heading = /^\s*<h([1-6])[\s>/]/i.exec(block);
  if (heading !== null) return { kind: "heading", level: Number(heading[1]) };
  if (/^\s*<li[\s>/]/i.test(block)) return { kind: "list-item", level: null };
  return { kind: "paragraph", level: null };
}

/**
 * The blocks of two values compared: one entry per block, in order, "same",
 * "removed" or "added". The unchanged blocks at the start and at the end are
 * matched first, in linear time; only the part between them is compared by
 * the longest common run of blocks, in a table of at most MAX_TABLE_CELLS
 * cells, checked before the table is made. Each block is compared by a number
 * that stands for its text, so one comparison costs the same for any block.
 * `meter`, when given, counts the cells of the table made.
 */
export function compareBlocks(before, after, refuse, meter) {
  const numbers = new Map();
  const numberOf = (block) => {
    let number = numbers.get(block);
    if (number === undefined) {
      number = numbers.size;
      numbers.set(block, number);
    }
    return number;
  };
  const a = before.map(numberOf);
  const b = after.map(numberOf);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const n = endA - start;
  const m = endB - start;
  const cols = m + 1;
  const cells = (n + 1) * cols;
  if (cells > MAX_TABLE_CELLS) {
    refuse(`the changed part of the content spans ${n} blocks of the post and ${m} blocks of the value to save, more blocks than the page snapshot form can compare`);
  }
  const longest = new Uint32Array(cells);
  if (meter !== undefined) meter.cells += cells;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      longest[i * cols + j] = a[start + i] === b[start + j]
        ? longest[(i + 1) * cols + j + 1] + 1
        : Math.max(longest[(i + 1) * cols + j], longest[i * cols + j + 1]);
    }
  }
  const out = [];
  for (let k = 0; k < start; k += 1) out.push({ op: "same" });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      out.push({ op: "same" });
      i += 1;
      j += 1;
    } else if (j < m && (i === n || longest[i * cols + j + 1] >= longest[(i + 1) * cols + j])) {
      out.push({ op: "added", text: after[start + j] });
      j += 1;
    } else {
      out.push({ op: "removed", text: before[start + i] });
      i += 1;
    }
  }
  for (let k = endA; k < a.length; k += 1) out.push({ op: "same" });
  return out;
}

function excerpt(region, position, published, proposed, refuse) {
  if (sameWords(published, proposed)) {
    refuse(`the change of the ${region} differs from the post only in white space, which the page snapshot cannot show`);
  }
  const { kind, level } = region === "title" ? { kind: "heading", level: 1 } : region === "excerpt" ? { kind: "paragraph", level: null } : kindOf(proposed !== "" ? proposed : published);
  return { region, position, kind, level, published, proposed };
}

/** The content's changed blocks, each with its source text on both sides. */
function contentExcerpts(before, after, refuse) {
  const out = [];
  const was = blocksOf(before);
  const will = blocksOf(after);
  if (was.length > MAX_BLOCKS || will.length > MAX_BLOCKS) {
    refuse(`the content has more than ${MAX_BLOCKS} blocks, more than the page snapshot form can compare`);
  }
  const entries = compareBlocks(was, will, refuse);
  let position = 0;
  let k = 0;
  while (k < entries.length) {
    if (entries[k].op === "same") {
      position += 1;
      k += 1;
      continue;
    }
    const removed = [];
    const added = [];
    while (k < entries.length && entries[k].op !== "same") {
      (entries[k].op === "removed" ? removed : added).push(entries[k].text);
      k += 1;
    }
    for (let p = 0; p < Math.max(removed.length, added.length); p += 1) {
      out.push(excerpt("content", position, removed[p] ?? "", added[p] ?? "", refuse));
      position += 1;
    }
  }
  return out;
}

/**
 * The excerpts the review shows for the values to save, derived from them and
 * the post as read: the title, the content's changed blocks, the excerpt. A
 * value that equals the post as read shows no excerpt.
 */
export function excerptsOf(read, writeFields, refuse) {
  for (const field of FIELDS) {
    if (read[field].length > MAX_TEXT) refuse(`the ${field} as read is longer than ${MAX_TEXT} characters`);
    if (writeFields[field] !== null && writeFields[field].length > MAX_TEXT) {
      refuse(`the value to save for the ${field} is longer than ${MAX_TEXT} characters`);
    }
  }
  const out = [];
  if (writeFields.title !== null && writeFields.title !== read.title) {
    out.push(excerpt("title", 0, read.title, writeFields.title, refuse));
  }
  if (writeFields.content !== null && writeFields.content !== read.content) {
    out.push(...contentExcerpts(read.content, writeFields.content, refuse));
  }
  if (writeFields.excerpt !== null && writeFields.excerpt !== read.excerpt) {
    out.push(excerpt("excerpt", 0, read.excerpt, writeFields.excerpt, refuse));
  }
  if (out.length > MAX_EXCERPTS) refuse(`the change touches more than ${MAX_EXCERPTS} blocks, more than the page snapshot can show`);
  return out;
}

/** The values to save, as `title`, `content` and `excerpt`, each a non-empty string or null. */
function writeFieldsOf(value, refuse) {
  if (!isPlainObject(value)) refuse("there are no values to save");
  const fields = {};
  for (const field of FIELDS) {
    const item = value[field];
    if (item !== null && !isNonBlank(item)) refuse(`the value to save for the ${field} is neither a text nor null`);
    fields[field] = item;
  }
  return fields;
}

/** The values to save with each value that equals the post as read set to null: only a field that changes is saved. */
const changedOf = (read, writeFields) =>
  Object.fromEntries(FIELDS.map((field) => [field, writeFields[field] !== null && writeFields[field] !== read[field] ? writeFields[field] : null]));

const nothingChanges = (writeFields) => FIELDS.every((field) => writeFields[field] === null);

const readOf = (call) => ({ title: readText(call.title), content: readText(call.content), excerpt: readText(call.excerpt) });

// --- form ------------------------------------------------------------------

function form(call) {
  const refuse = (cause) => {
    throw new Refusal(FORM_CODE, cause);
  };
  const composed = readObject(call.pageForm);
  if (composed === undefined) refuse("the compose step answered no page form");
  const read = readOf(call);
  const writeFields = changedOf(read, writeFieldsOf(composed.writeFields, refuse));
  const page = isPlainObject(composed.page) ? composed.page : {};
  const address = (value) => (isNonBlank(value) ? value : null);
  const unchanged = nothingChanges(writeFields);
  return {
    ok: true,
    next: unchanged ? "no_change" : "review",
    pageForm: {
      cinatraCmsPage: 1,
      system: "wordpress",
      page: { title: read.title, address: address(page.address), cmsAddress: address(page.cmsAddress) },
      writeFields,
      excerpts: unchanged ? [] : excerptsOf(read, writeFields, refuse),
    },
  };
}

// --- unchanged ---------------------------------------------------------------

/** The outcome of a request that changes nothing: the post, no changes, no error. */
function unchanged(call) {
  const refuse = (cause) => {
    throw new Refusal(FORM_CODE, cause);
  };
  const error = readObject(call.error);
  if (error === undefined || (typeof error.code === "string" ? error.code.trim() !== "" : error.code !== undefined)) {
    refuse("the read failed, so nothing is known to need no change");
  }
  if (readText(call.status).trim() === "") refuse("the read answered no status, so nothing is known to need no change");
  const composed = readObject(call.pageForm);
  if (composed === undefined) refuse("the compose step answered no page form");
  const writeFields = changedOf(readOf(call), writeFieldsOf(composed.writeFields, refuse));
  if (!nothingChanges(writeFields)) refuse("the values to save change the post, which needs the review");
  return {
    ok: true,
    postId: readText(call.postId).trim(),
    instanceId: readText(call.instanceId).trim(),
    proposalId: "",
    changeSetId: "",
    changes: [],
    error: {},
  };
}

// --- read ------------------------------------------------------------------

/** The revision of the filed artifact the review's answer approves. */
function approvedRevision(answerText, artifactId, refuse) {
  const answer = parseJson(answerText.trim());
  if (!isPlainObject(answer) || !isPlainObject(answer.review)) refuse("the review's answer names no approved revision");
  if (answer.approved !== true || answer.review.decision !== "approved") refuse("the review's answer is not an approval");
  if (answer.review.envelopeVersion !== ENVELOPE_VERSION) refuse("the review's answer is not of the version this pack reads");
  const targets = answer.review.targets;
  if (!Array.isArray(targets) || targets.length !== 1 || !isPlainObject(targets[0])) {
    refuse("the review's answer does not name exactly one approved revision");
  }
  const [target] = targets;
  if (target.artifactId !== artifactId) refuse("the review approved another artifact than the page snapshot this run filed");
  if (!isNonBlank(target.representationRevisionId)) refuse("the review's answer names no revision of the page snapshot");
  return target.representationRevisionId;
}

const shown = (list) =>
  JSON.stringify(
    (Array.isArray(list) ? list : []).map((e) =>
      isPlainObject(e) ? [e.region, e.position, e.kind, e.level ?? null, e.published, e.proposed] : null,
    ),
  );

async function read(call, ports) {
  const refuse = (cause) => {
    throw new Refusal(READ_CODE, cause);
  };
  const artifactId = readText(call.artifactId).trim();
  if (artifactId === "") refuse("the run filed no page snapshot");
  const revisionId = approvedRevision(readText(call.reviewAnswer), artifactId, refuse);
  let result;
  try {
    result = await ports.artifacts.contentRead({ artifactId, representationRevisionId: revisionId, objectType: PAGE_TYPE });
  } catch {
    refuse("the reviewed revision could not be read");
  }
  if (!isPlainObject(result) || typeof result.text !== "string") refuse("the reviewed revision could not be read");
  if (result.truncated !== false) refuse("the read of the reviewed revision was cut short");
  if (result.representationRevisionId !== revisionId) refuse("the read answered another revision than the approved one");
  if (result.artifactId !== undefined && result.artifactId !== artifactId) refuse("the read answered another artifact than the reviewed one");

  const snapshot = parseJson(result.text);
  if (!isPlainObject(snapshot) || snapshot.cinatraCmsPage !== 1 || snapshot.system !== "wordpress") {
    refuse("the reviewed revision is not a WordPress page snapshot");
  }
  const writeFields = writeFieldsOf(snapshot.writeFields, refuse);
  if (nothingChanges(writeFields)) refuse("the reviewed revision holds no values to save");
  const derived = excerptsOf(readOf(call), writeFields, refuse);
  const regions = new Set(derived.map((e) => e.region));
  for (const field of FIELDS) {
    if (writeFields[field] !== null && !regions.has(field)) {
      refuse(`the reviewed revision would save the ${field}, which its excerpts do not show`);
    }
  }
  if (shown(derived) !== shown(snapshot.excerpts)) {
    refuse("the values to save in the reviewed revision differ from the excerpts it shows");
  }
  return { ok: true, reviewedFields: JSON.stringify(writeFields), reviewedRevisionId: revisionId };
}

/**
 * THE ONE CALLABLE EXPORT the declared-tools contract pins: one function of one
 * argument, `{ input, ports }`. Its operations are `form`, `unchanged` and
 * `read`; any other is refused.
 */
export async function extensionTool({ input, ports }) {
  const call = isPlainObject(input) ? input : {};
  const op = typeof call.op === "string" ? call.op.trim() : "";
  if (op === "form") return form(call);
  if (op === "unchanged") return unchanged(call);
  if (op === "read") return read(call, ports);
  throw new Error(`reviewed_change: \`op\` must be form, unchanged or read — got ${JSON.stringify(call.op)}`);
}
