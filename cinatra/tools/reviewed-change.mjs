/**
 * THE REVIEWED CHANGE: the page snapshot form the review shows, and the values
 * read back from the revision the review approved.
 *
 * Five operations, one per step of the flow:
 *
 * - `page` (step `check_read`, right after the model-free read of the site
 *   ability `cinatra/post-read`): it takes the site's answer only when it is a
 *   successful read of the run's post and hands its values on; see `page`.
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
 *   show. A changed block that holds a character that draws nothing or changes
 *   the direction of the text, or whose white space the display cannot draw,
 *   is refused (see the one rule per changed block below). The excerpts the
 *   compose step answers, if any, are never filed. It
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
 *   revision shows and every value it would save is shown by them. It answers
 *   each value as its own text (empty when not saved) and the approved
 *   revision, which the publishing step takes one by one.
 * - `outcome` (step `write_outcome`, after the publishing step): it reads the
 *   site's answer to `cinatra/post-update-if-unchanged` and answers the branch
 *   the flow takes and the run's output; see `outcome`.
 *
 * Every operation takes the read only when it is a successful read
 * (`checkedRead`); any other read is refused and never ends the run as a
 * change of nothing. The page record (the post id, the status, the title and
 * the addresses) is built by code from that read (`pageOf`), never from the
 * compose step's answer. What `form` files and the revision `read` takes both
 * pass one check (`checkedSnapshot`): the display draws the snapshot, its
 * excerpts have the form `form` builds, and its page record is the one built
 * from this run's read.
 *
 * Each operation refuses by the host's documented means: it throws an error
 * named `ExtensionToolCallRefusal` whose message is one sentence that starts
 * with its code (`post_read_unavailable` for `page`, `page_form_unavailable`
 * for `form` and `unchanged`, `reviewed_change_unavailable` for `read`,
 * `write_answer_unreadable` or `write_outcome_unknown` for `outcome`). The step and the run fail; before
 * the write, the write step never runs. It reads no port but the artifact read, and writes no
 * port, no table and no artifact.
 */

export const FORM_CODE = "page_form_unavailable";
export const READ_CODE = "reviewed_change_unavailable";
export const PAGE_CODE = "post_read_unavailable";
/** The refusal of the run's inputs: nothing is read from the site. */
export const INPUT_CODE = "run_input_invalid";
export const OUTCOME_CODE = "write_answer_unreadable";
/**
 * The site's answer that the database did not confirm the save and the change
 * may or may not be stored. Unlike every refusal in `WRITE_REFUSALS`, nothing
 * is known about the post: the run fails with this code and never says that
 * nothing was written.
 */
export const OUTCOME_UNKNOWN_CODE = "write_outcome_unknown";

/**
 * The refusal codes of the site ability `cinatra/post-update-if-unchanged`
 * other than `post_changed` and `write_outcome_unknown`, each with the plain
 * message the run ends with. After each of them nothing was written. Every code
 * the ability answers has an explicit entry here, or is `post_changed` (the way
 * back to the read) or `write_outcome_unknown` (`OUTCOME_UNKNOWN_CODE`).
 */
export const WRITE_REFUSALS = {
  site_policy_conflict:
    "Nothing was written: the site's own save rules or code would also change another part of the post or its status, or changed the post during the save. A person makes this change on the site.",
  permission_unverified:
    "Nothing was written: the site could not verify that this account may edit the post. Check the site's caching and permission plugins, then start a new run.",
  post_locked: "Nothing was written: another user is editing the post on the site. Start a new run when they are done.",
  unsupported_status: "Nothing was written: the post is no longer published or a draft, and this agent edits only published posts and drafts.",
  invalid: "Nothing was written: the site refused the request as malformed. This is a fault of the agent; report it.",
  empty_content:
    "Nothing was written: the change would have left the post empty, or the site's own rules count the result as empty. Ask for a change that keeps some content.",
  transaction_conflict:
    "Nothing was written: the site's database has another transaction open, lost the transaction of this save, or is set so that this save cannot run on its own. Try again later; if it keeps happening, check the site's database settings and plugins.",
  not_found: "Nothing was written: the post no longer exists, or this account may no longer edit it.",
  unsupported_storage: "Nothing was written: the site's database cannot lock a post row (the posts table does not use InnoDB).",
  db_error: "Nothing was written: the site's database refused the save. Start a new run later.",
};

/**
 * `transaction_conflict` with `data.site_changes_possible` exactly true: this
 * save did not change the post, but the site's own save code ran during the
 * attempt and may have stored changes of its own. It must not say that nothing
 * was written, so it replaces the message of `WRITE_REFUSALS.transaction_conflict`.
 */
const SITE_CHANGES_POSSIBLE =
  "The post itself was not changed by this save, but other parts of the site may have been changed by the site's own code during the attempt. Check the post and the site before trying again.";

/** Added to the message of a refusal that says the site's cache may still serve the post as it was. */
const CACHE_STALE_NOTE = "The site may still show an outdated copy of the post for a while.";

/** `data.cache_stale` exactly true: the answer says a stale copy of the post may still be served. */
const cacheStale = (data) => isPlainObject(data) && data.cache_stale === true;

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

/**
 * The most top-level blocks a content value may have: it bounds the memory of
 * the block lists. The splitting counts each block as it makes it and refuses
 * at the first block past this limit.
 */
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

/** How a refusal sentence of each code starts and ends. */
const REFUSAL_WORDS = {
  [FORM_CODE]: ["nothing was filed", "start a new run"],
  [READ_CODE]: ["nothing was written", "start a new run"],
  [PAGE_CODE]: ["nothing was proposed", "start a new run"],
  [INPUT_CODE]: ["nothing was read from the site", "start a new run with a valid post and site"],
  [OUTCOME_CODE]: ["the outcome of the save is not known", "check the post on the site before a new run"],
  [OUTCOME_UNKNOWN_CODE]: ["the site did not confirm whether the change was stored", "check the post, its revisions and the site's caches before trying again"],
};

class Refusal extends Error {
  constructor(code, cause) {
    const [start, end] = REFUSAL_WORDS[code];
    const line = `${code}: ${start}, because ${cause}; ${end}.`.replace(/\s+/g, " ").trim();
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
 * to the block before it (white space before the first block belongs to the
 * first block). The blocks joined are the value, byte for byte.
 *
 * `refuse`, when given, bounds the work: each block is counted as it is made,
 * and the splitting refuses at the first block past MAX_BLOCKS, so it never
 * makes more than one block past the limit. `meter.blocks`, when given, counts
 * the blocks made.
 */
export function blocksOf(text, refuse, meter) {
  const blocks = [];
  let lead = "";
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
    i = end;
    if (piece.trim() === "") {
      if (blocks.length > 0) blocks[blocks.length - 1] += piece;
      else lead += piece;
      continue;
    }
    if (meter !== undefined) meter.blocks += 1;
    if (refuse !== undefined && blocks.length >= MAX_BLOCKS) {
      refuse(`the content has more than ${MAX_BLOCKS} blocks, more than the page snapshot form can compare`);
    }
    blocks.push(lead + piece);
    lead = "";
  }
  if (lead !== "") blocks.push(lead);
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

// --- invisible characters and white space: one rule per changed block --------
//
// The display draws each changed block as plain text: its source, markup
// included, with a run of white space drawn as one space. So what it cannot
// show must not change. The rule works on each changed block (the unit the
// review shows), byte for byte, with no exception and no normalisation:
//
// 1. A changed block that holds an invisible character, in the post as read or
//    in the value to save, is refused: the agent does not change such a block,
//    and a person changes it on the site. An invisible character is any
//    character of the Unicode classes Cf, Cc (except tab, line feed and
//    carriage return), Zs (except U+0020, so U+00A0 is one), Zl, Zp,
//    Default_Ignorable_Code_Point and Variation_Selector.
// 2. The changed part of a block is what lies between its unchanged start and
//    its unchanged end, both byte for byte equal, widened so that no run of
//    white space is cut. In it, on both sides, white space may only be a single
//    U+0020 between two visible characters: that is exactly what the display
//    draws. Any other white space there (a tab, a line break, two spaces, a
//    space at the edge of the block) is refused.
// 3. A block whose sides differ only in white space stays refused, as the
//    display's parser rejects it.

const INVISIBLE = /(?![\t\n\r ])[\p{Cf}\p{Cc}\p{Zs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Variation_Selector}]/u;
const SPACE = /\s/;

const codePointName = (text) => `U+${text.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;

/** Whether `text` holds, from `from` to `to`, white space other than one U+0020 between two visible characters. */
function otherSpace(text, from, to) {
  for (let i = from; i < to; i += 1) {
    if (!SPACE.test(text[i])) continue;
    if (text[i] !== " " || i === 0 || i === text.length - 1 || SPACE.test(text[i - 1]) || SPACE.test(text[i + 1])) return true;
  }
  return false;
}

/** Refuses a changed block (`published` against `proposed`) that breaks the rule above. */
export function checkedBlock(region, position, published, proposed, refuse) {
  const name = `the changed block ${position + 1} of the ${region}`;
  for (const side of [published, proposed]) {
    const found = INVISIBLE.exec(side);
    if (found !== null) {
      refuse(`${name} holds the invisible character ${codePointName(side.slice(found.index))}, which the page snapshot cannot show, and the agent does not change a block that holds one; make that change on the site`);
    }
  }
  let start = 0;
  const shorter = Math.min(published.length, proposed.length);
  while (start < shorter && published[start] === proposed[start]) start += 1;
  let end = 0;
  while (end < shorter - start && published[published.length - 1 - end] === proposed[proposed.length - 1 - end]) end += 1;
  while (start > 0 && SPACE.test(published[start - 1])) start -= 1;
  while (end > 0 && SPACE.test(published[published.length - end])) end -= 1;
  if (otherSpace(published, start, published.length - end) || otherSpace(proposed, start, proposed.length - end)) {
    refuse(`${name} changes white space other than one plain space between visible characters, which the page snapshot cannot show as it is; keep that white space as it is, or make that change on the site`);
  }
}

function excerpt(region, position, published, proposed, refuse) {
  if (sameWords(published, proposed)) {
    refuse(`the change of the ${region} differs from the post only in white space, which the page snapshot cannot show`);
  }
  checkedBlock(region, position, published, proposed, refuse);
  const { kind, level } = region === "title" ? { kind: "heading", level: 1 } : region === "excerpt" ? { kind: "paragraph", level: null } : kindOf(proposed !== "" ? proposed : published);
  return { region, position, kind, level, published, proposed };
}

/** The content's changed blocks, each with its source text on both sides. */
function contentExcerpts(before, after, refuse, meter) {
  const out = [];
  const was = blocksOf(before, refuse, meter);
  const will = blocksOf(after, refuse, meter);
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
 * value that equals the post as read shows no excerpt. The length of each
 * value is checked first, then the content is split into blocks, each counted
 * against MAX_BLOCKS as it is made, and each changed block is checked by
 * `checkedBlock`. `meter.blocks`, when given, counts the blocks made.
 */
export function excerptsOf(read, writeFields, refuse, meter) {
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
    out.push(...contentExcerpts(read.content, writeFields.content, refuse, meter));
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
  const other = Object.keys(value).filter((key) => !FIELDS.includes(key));
  if (other.length > 0) {
    refuse(`the values to save name ${other.map((key) => JSON.stringify(key)).join(", ")}, which this flow does not save: it saves only the title, the content and the excerpt, and never changes a status without a reviewed text`);
  }
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

// --- the read ----------------------------------------------------------------

/** The statuses of a post this flow edits (the site ability writes only these); a successful read answers one of them. */
const READ_STATUSES = new Set(["publish", "draft"]);

/** A text input as the flow renders it (JSON text of a string), or undefined when it is not one. */
function textInput(value) {
  if (typeof value !== "string") return undefined;
  const parsed = parseJson(value);
  return typeof parsed === "string" ? parsed : undefined;
}

/**
 * THE READ, accepted only when it is a successful read. A successful read
 * always carries: an error object whose `code` and `message` are both the
 * empty text (the read step's contract for a successful read); a status this
 * flow edits (`publish` or `draft`, the two the site ability writes; any
 * other status and any other text are refused); a
 * non-empty change time; a title, a content, an excerpt and an address that
 * are texts (each may be empty); and the run's post id, a whole number, which
 * the read step answered too. Anything else is a failed read, whatever its
 * shape: `{}`, `{ message }`, `null`, a text, a missing input and each flow
 * default that stands in for one. A failed read is refused with its own
 * message when it has one, else with a fixed one; it never leads to a filing,
 * to the no-change outcome or to a write.
 */
function checkedRead(call, refuse) {
  const error = readObject(call.error);
  if (error === undefined || error.code !== "" || error.message !== "") {
    const message = error !== undefined && typeof error.message === "string" ? error.message.trim() : "";
    refuse(message !== "" ? `the read of the post failed: ${message}` : "no successful read of the post was handed to this step");
  }
  const postId = (textInput(call.postId) ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(postId)) refuse("the run names no post id that is a whole number");
  if ((textInput(call.readPostId) ?? "").trim() !== postId) refuse("the read answered another post id than the run's post");
  const status = (textInput(call.status) ?? "").trim();
  if (!READ_STATUSES.has(status)) {
    refuse(status === "" ? "the read answered no status, so it was not a successful read" : `the read answered the status ${JSON.stringify(status.slice(0, 40))}, which is not a status of a post this flow edits`);
  }
  if ((textInput(call.modified) ?? "").trim() === "") refuse("the read answered no change time, so it was not a successful read");
  const texts = {};
  for (const name of [...FIELDS, "address"]) {
    texts[name] = textInput(call[name]);
    if (texts[name] === undefined) refuse(`the read answered no ${name} text, so it was not a successful read`);
  }
  return { postId, status, title: texts.title, content: texts.content, excerpt: texts.excerpt, address: texts.address.trim() };
}

/** The address, when its text starts with `https://`, it parses, its protocol is https and it carries no user name or password; else null. */
function httpsAddress(value) {
  if (!/^https:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url : null;
  } catch {
    return null;
  }
}

/**
 * The page record the snapshot files, built by code from this run's read only:
 * the post id, the status, the title, the post's own address as the read
 * answered it (null when empty) and the address that opens the post in the
 * WordPress editor, on the origin of that address (null when the address is
 * not an https address). No value of the compose step's answer reaches it.
 */
function pageOf(read) {
  const url = httpsAddress(read.address);
  return {
    postId: read.postId,
    status: read.status,
    title: read.title,
    address: read.address === "" ? null : read.address,
    cmsAddress: url === null ? null : `${url.origin}/wp-admin/post.php?post=${read.postId}&action=edit`,
  };
}

// ---------------------------------------------------------------------------
// THE ONE CHECK OF A PAGE SNAPSHOT, used by `form` on what it files and by
// `read` on the approved revision.
//
// `displayReading` restates the rules by which the display's parser accepts a
// snapshot (cinatra-ai/website-artifacts, src/cms-page-model.ts, parseCmsPage):
// the marker and its version, at least one excerpt and at most 200, a system it
// knows, a page record with a text title, and each excerpt with a region, a
// whole position of 0 or more, a kind it draws, two text sides that do not hold
// the same words, a heading level of 1 to 6 (2 when absent), and positions that
// rise between consecutive excerpts of one region. It answers the parser's
// reason. The parser reads only the title and the two addresses of the page
// record, so the post id and the status beside them do not change its answer.
// `checkedSnapshot` adds what this pack files: the WordPress system, each
// excerpt with exactly the keys and the level form `excerptsOf` builds, and a
// page record equal, key by key, to the one built from this run's read.
// ---------------------------------------------------------------------------

const DISPLAY_SYSTEMS = ["wordpress", "drupal"];
const DISPLAY_KINDS = ["heading", "paragraph", "list-item"];
const EXCERPT_KEYS = ["kind", "level", "position", "proposed", "published", "region"];
const PAGE_PARTS = [
  ["postId", "post id"],
  ["status", "status"],
  ["title", "title"],
  ["address", "address"],
  ["cmsAddress", "edit address"],
];

/** Whether the display's parser accepts one excerpt. */
function displayDrawsExcerpt(value) {
  if (!isPlainObject(value)) return false;
  const { region, position, kind, level, published, proposed } = value;
  if (typeof region !== "string" || region.length === 0) return false;
  if (typeof position !== "number" || !Number.isInteger(position) || position < 0) return false;
  if (typeof kind !== "string" || !DISPLAY_KINDS.includes(kind)) return false;
  if (typeof published !== "string" || typeof proposed !== "string") return false;
  if (sameWords(published, proposed)) return false;
  if (kind === "heading" && level !== undefined && !(typeof level === "number" && Number.isInteger(level) && level >= 1 && level <= 6)) {
    return false;
  }
  return true;
}

/** The display parser's answer for a snapshot: `{ ok: true }` or `{ ok: false, reason }`, with its reasons. */
export function displayReading(form) {
  if (!isPlainObject(form) || !Object.prototype.hasOwnProperty.call(form, "cinatraCmsPage")) return { ok: false, reason: "not-the-form" };
  if (form.cinatraCmsPage !== 1) return { ok: false, reason: "form-version" };
  const { excerpts, system, page } = form;
  if (excerpts === undefined || (Array.isArray(excerpts) && excerpts.length === 0)) return { ok: false, reason: "no-excerpts" };
  if (typeof system !== "string" || !DISPLAY_SYSTEMS.includes(system)) return { ok: false, reason: "malformed" };
  if (!isPlainObject(page) || typeof page.title !== "string") return { ok: false, reason: "malformed" };
  if (!Array.isArray(excerpts) || excerpts.length > MAX_EXCERPTS) return { ok: false, reason: "malformed" };
  let previous;
  for (const entry of excerpts) {
    if (!displayDrawsExcerpt(entry)) return { ok: false, reason: "malformed" };
    if (previous !== undefined && previous.region === entry.region && entry.position <= previous.position) {
      return { ok: false, reason: "malformed" };
    }
    previous = entry;
  }
  return { ok: true };
}

/** THE ONE CHECK: refuses, naming the part that differs, unless the snapshot is one the display draws of this run's post. */
export function checkedSnapshot(form, page, refuse) {
  if (isPlainObject(form) && !isPlainObject(form.page)) refuse("the page snapshot carries no page record");
  const reading = displayReading(form);
  if (!reading.ok) refuse(`the page snapshot is not one the page display draws (${reading.reason})`);
  if (form.system !== "wordpress") refuse("the page snapshot is not a WordPress page snapshot");
  const keys = Object.keys(form.page).sort();
  if (JSON.stringify(keys) !== JSON.stringify(PAGE_PARTS.map(([key]) => key).sort())) {
    refuse("the page record of the page snapshot holds other keys than the post id, status, title, address and edit address");
  }
  for (const [key, name] of PAGE_PARTS) {
    if (form.page[key] !== page[key]) refuse(`the page record of the page snapshot names another ${name} than this run's read of the post`);
  }
  for (const entry of form.excerpts) {
    if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(EXCERPT_KEYS)) {
      refuse("a changed block of the page snapshot holds other keys than the ones the page snapshot form builds");
    }
    const levelOk = entry.kind === "heading" ? Number.isInteger(entry.level) : entry.level === null;
    if (!levelOk) refuse("a changed block of the page snapshot has a level that is not the form the page snapshot builds");
  }
}

// ---------------------------------------------------------------------------
// THE SIZE OF THE WRITE. The publishing step sends one `argsJson` text: the
// write template of cinatra/oas.json rendered by the flow runtime, which
// carries the five values as read AND the reviewed values, so a content can be
// in it twice. The connector takes a text of at most 256 KiB in UTF-8
// (wordpress-mcp-connector src/mcp/handlers.ts SITE_TOOL_ARGS_JSON_MAX_BYTES)
// and refuses a longer one. So `form` measures that exact text before anything
// is filed for review, and `read` measures it again for the approved revision;
// a change whose text is longer is refused there, and nothing is written.
// ---------------------------------------------------------------------------

/** The most bytes of an `argsJson` text the connector takes. */
export const SEND_MAX_BYTES = 256 * 1024;

/** Python's json.dumps escape of one string with ASCII output (`ensure_ascii`), as `tojson` writes it. */
function pythonJsonString(text) {
  const SHORT = { 0x22: '\\"', 0x5c: "\\\\", 0x08: "\\b", 0x0c: "\\f", 0x0a: "\\n", 0x0d: "\\r", 0x09: "\\t" };
  let out = '"';
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (SHORT[unit] !== undefined) out += SHORT[unit];
    else if (unit >= 0x20 && unit <= 0x7e) out += text[i];
    // Every other UTF-16 unit (so U+007F, and each half of a character outside
    // the BMP) becomes \u and four lower-case hex digits.
    else out += `\\u${unit.toString(16).padStart(4, "0")}`;
  }
  return `${out}"`;
}

/** Python's repr of a number as json.dumps writes it (a whole number as an int). */
function pythonJsonNumber(value) {
  if (!Number.isFinite(value)) throw new Error("reviewed_change: a value to send is not a finite number");
  if (Number.isInteger(value)) return BigInt(value).toString();
  const [mantissa, exponentText] = value.toExponential().split("e");
  const exponent = Number(exponentText);
  if (exponent >= -4 && exponent < 16) return String(value);
  return `${mantissa}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
}

/**
 * THE TEXT `{{ value | tojson }}` RENDERS TO in the flow runtime. wayflowcore
 * 26.1.2 renders an ApiNode's data with `render_str_template`
 * (`_utils/_templating_helpers.py:482-492`), which sets `json.dumps_kwargs` to
 * `{"sort_keys": False}`; Jinja 3.1.6 `do_tojson` calls `htmlsafe_json_dumps`
 * (`jinja2/utils.py:637-673`). So: Python's json.dumps with its defaults
 * (separators ", " and ": ", `ensure_ascii`, keys in the order the value holds
 * them), then each < > & ' written as \u003c, \u003e, \u0026 and \u0027. The
 * size check below and the tests' renderer both use this one function.
 */
export function tojsonText(value) {
  const dumps = (v) => {
    if (v === null) return "null";
    if (v === true) return "true";
    if (v === false) return "false";
    if (typeof v === "string") return pythonJsonString(v);
    if (typeof v === "number") return pythonJsonNumber(v);
    if (Array.isArray(v)) return `[${v.map(dumps).join(", ")}]`;
    if (isPlainObject(v)) return `{${Object.entries(v).map(([k, item]) => `${pythonJsonString(k)}: ${dumps(item)}`).join(", ")}}`;
    throw new Error("reviewed_change: a value to send is not JSON");
  };
  return dumps(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/'/g, "\\u0027");
}

/**
 * The write step's `argsJson` as the runtime renders `write_page`'s template:
 * the same literal punctuation, a `tojson` per value, a reviewed value only
 * when it is not empty (`{% if reviewedTitle %}`), and the demotion of a
 * published post. A test renders the template of cinatra/oas.json for every
 * shape it takes and requires this text byte for byte, so the two cannot drift.
 */
export function writeArgsText(read, reviewed) {
  const t = tojsonText;
  let text = `{"post_id": ${t(read.postId)}, "if_unmodified_since": ${t(read.modified)}, "expected": {"title": ${t(read.title)}, "content": ${t(read.content)}, "excerpt": ${t(read.excerpt)}, "status": ${t(read.status)}, "row_token": ${t(read.rowToken)}}`;
  for (const field of FIELDS) {
    const value = reviewed[field] ?? "";
    if (value !== "") text += `, ${t(field)}: ${t(value)}`;
  }
  if (read.status === "publish") text += ', "status": "draft"';
  return `${text}}`;
}

/** Refuses a change whose write text, as the publishing step would send it, is longer than the connector takes. */
function checkedWriteSize(call, post, writeFields, refuse) {
  const rowToken = textInput(call.rowToken);
  if (rowToken === undefined || !ROW_TOKEN_FORM.test(rowToken)) refuse("the read answered no row token, so the save cannot be measured");
  const sent = writeArgsText(
    { postId: Number(post.postId), modified: textInput(call.modified), title: post.title, content: post.content, excerpt: post.excerpt, status: post.status, rowToken },
    writeFields,
  );
  const bytes = new TextEncoder().encode(sent).length;
  if (bytes > SEND_MAX_BYTES) {
    refuse(
      `the save of this change would send ${bytes} bytes to the site, more than the ${SEND_MAX_BYTES} bytes the WordPress connector takes in one call, so ask for a smaller change or make it on the site`,
    );
  }
}

// --- form ------------------------------------------------------------------

function form(call) {
  const refuse = (cause) => {
    throw new Refusal(FORM_CODE, cause);
  };
  const read = checkedRead(call, refuse);
  const composed = readObject(call.pageForm);
  if (composed === undefined) refuse("the compose step answered no page form");
  const writeFields = changedOf(read, writeFieldsOf(composed.writeFields, refuse));
  if (nothingChanges(writeFields)) {
    return { ok: true, next: "no_change", pageForm: {} };
  }
  const page = pageOf(read);
  const pageForm = { cinatraCmsPage: 1, system: "wordpress", page, writeFields, excerpts: excerptsOf(read, writeFields, refuse) };
  checkedSnapshot(pageForm, page, refuse);
  checkedWriteSize(call, read, writeFields, refuse);
  return { ok: true, next: "review", pageForm };
}

// --- unchanged ---------------------------------------------------------------

/** The most characters of the request the no-change message repeats. */
export const REQUEST_MAX = 300;

/** The most characters of the post's title the no-change message repeats. */
const TITLE_MAX = 120;

/** Text on one line, cut to `max` characters with an ellipsis. */
function oneLine(text, max) {
  const line = String(text).replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The outcome of a request that changes nothing: the post, no changes, no
 * error, and a message built here, never by the model. The compose step's
 * answer is the same for a request that needs no change and for a request it
 * dropped, and no code can tell the two apart. So the run ends completed, and
 * the message tells the person that nothing was proposed, reviewed or written
 * for their request, and repeats the request so they can see it.
 */
function unchanged(call) {
  const refuse = (cause) => {
    throw new Refusal(FORM_CODE, cause);
  };
  const read = checkedRead(call, refuse);
  const composed = readObject(call.pageForm);
  if (composed === undefined) refuse("the compose step answered no page form");
  const writeFields = changedOf(read, writeFieldsOf(composed.writeFields, refuse));
  if (!nothingChanges(writeFields)) refuse("the values to save change the post, which needs the review");
  const title = oneLine(read.title, TITLE_MAX);
  const request = oneLine(textInput(call.instructions) ?? "", REQUEST_MAX);
  const lead = `No change was proposed for this request on post ${read.postId} ("${title}"), so nothing was reviewed or written`;
  return {
    ok: true,
    postId: read.postId,
    instanceId: readText(call.instanceId).trim(),
    proposalId: "",
    changeSetId: "",
    changes: [],
    error: {},
    message: request === "" ? `${lead}; the request was empty.` : `${lead}: ${request}`,
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
  const post = checkedRead(call, refuse);
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
  checkedSnapshot(snapshot, pageOf(post), refuse);
  const derived = excerptsOf(post, writeFields, refuse);
  const regions = new Set(derived.map((e) => e.region));
  for (const field of FIELDS) {
    if (writeFields[field] !== null && !regions.has(field)) {
      refuse(`the reviewed revision would save the ${field}, which its excerpts do not show`);
    }
  }
  if (shown(derived) !== shown(snapshot.excerpts)) {
    refuse("the values to save in the reviewed revision differ from the excerpts it shows");
  }
  checkedWriteSize(call, post, writeFields, refuse);
  return {
    ok: true,
    reviewedTitle: writeFields.title ?? "",
    reviewedContent: writeFields.content ?? "",
    reviewedExcerpt: writeFields.excerpt ?? "",
    reviewedRevisionId: revisionId,
    reviewedSnapshot: [{ artifactId, representationRevisionId: revisionId }],
  };
}

// --- input: the check of the run's inputs, before anything is read -----------

/** The form of a canonical post id: digits only, no sign, no point, no leading zero. */
const POST_ID_FORM = /^[1-9][0-9]*$/;
/** The form of a site instance id: present, no white space, no control character. */
const INSTANCE_ID_FORM = /^[^\s\p{Cc}]{1,200}$/u;

/**
 * The post id as a number, or undefined. A text must be canonical (digits
 * only, no sign, no decimal point, no leading zero) and a number must be a
 * whole number; either must be a positive safe integer.
 */
function canonicalPostId(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
  if (typeof value !== "string" || !POST_ID_FORM.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

/**
 * THE RUN'S INPUTS, checked before the flow makes any site call. The post id
 * is a canonical positive integer and is answered as a number, which the read
 * step renders as it is; the site instance id is present and has no white
 * space; the type hint is empty, post or page. Anything else is refused, and
 * the run ends before the read.
 */
function runInput(call) {
  const refuse = (cause) => {
    throw new Refusal(INPUT_CODE, cause);
  };
  const postId = canonicalPostId(jsonValue(call.postId));
  if (postId === undefined) refuse("the run's post id is not a whole number from 1 written in digits only");
  const instanceId = jsonValue(call.instanceId);
  if (typeof instanceId !== "string" || !INSTANCE_ID_FORM.test(instanceId)) refuse("the run names no WordPress site");
  const hint = jsonValue(call.postType);
  if (typeof hint !== "string" || !TYPE_HINTS.has(hint.trim())) refuse("the run asks for a post type other than post or page");
  return { ok: true, postId, instanceId, postType: hint.trim() };
}

// --- page: the check of the site's read --------------------------------------

/** A value the flow renders with `tojson`, read back; the value itself when it is not JSON text. */
function jsonValue(value) {
  if (typeof value !== "string") return value;
  const parsed = parseJson(value);
  return parsed === undefined ? value : parsed;
}

/** The post types the site ability reads and writes. */
const POST_TYPES = new Set(["post", "page"]);
/** The run's type hints this flow accepts; the type itself comes from the read. */
const TYPE_HINTS = new Set(["", "post", "page"]);
/** The form of the site's change time and of its row token. */
const MODIFIED_FORM = /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$/;
const ROW_TOKEN_FORM = /^[0-9a-f]{64}$/;
/** The form of a code or a column name the site answers; any other text is not repeated. */
const NAME_FORM = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * THE CHECK OF THE READ (step `check_read`, right after the model-free read of
 * `cinatra/post-read`). It takes the site's answer only when it is a
 * successful read of the run's post: `success` exactly true, the run's post id
 * (a whole number) as the answered `post_id`, a post or a page, a status the
 * site ability writes (`publish` or `draft`), a change time and a row token of
 * the site's form, and a title, a content, an excerpt and an address that are
 * texts. It hands those values on, unchanged, under the names the later steps
 * read, with an empty error. Anything else is refused: the run fails before
 * the model step, and nothing is proposed, filed or written. A refusal names
 * the site's refusal code when it has the form of one, and never repeats the
 * site's text.
 */
function page(call) {
  const refuse = (cause) => {
    throw new Refusal(PAGE_CODE, cause);
  };
  if (jsonValue(call.success) !== true) {
    const code = jsonValue(call.code);
    refuse(typeof code === "string" && NAME_FORM.test(code) ? `the site refused the read (${code})` : "the site answered no successful read of the post");
  }
  const validated = canonicalPostId(jsonValue(call.postId));
  if (validated === undefined) refuse("the run names no post id that is a whole number");
  const postId = String(validated);
  const answered = jsonValue(call.post_id);
  if (answered !== validated) refuse("the site answered another post than the run's post");
  const hint = (textInput(call.postType) ?? "").trim();
  if (!TYPE_HINTS.has(hint)) refuse("the run asks for a post type other than post or page");
  const values = {};
  for (const name of ["post_type", "post_status", "post_modified_gmt", "row_token", "post_title", "post_content", "post_excerpt", "permalink"]) {
    values[name] = jsonValue(call[name]);
    if (typeof values[name] !== "string") refuse(`the site's read answered no ${name.replace("post_", "")} text`);
  }
  if (!POST_TYPES.has(values.post_type)) refuse("the post is neither a post nor a page");
  if (!READ_STATUSES.has(values.post_status)) refuse("the post is neither published nor a draft, and the site writes only those");
  if (!MODIFIED_FORM.test(values.post_modified_gmt)) refuse("the site's read answered no change time");
  if (!ROW_TOKEN_FORM.test(values.row_token)) refuse("the site's read answered no row token");
  return {
    ok: true,
    postId,
    instanceId: readText(call.instanceId).trim(),
    postType: values.post_type,
    title: values.post_title,
    content: values.post_content,
    excerpt: values.post_excerpt,
    status: values.post_status,
    address: values.permalink.trim(),
    modified: values.post_modified_gmt,
    rowToken: values.row_token,
    error: { code: "", message: "" },
  };
}

// --- outcome: the site's answer to the write ---------------------------------

/** The site's column names and the field names of the run's changes. */
const COLUMN_FIELDS = { post_title: "title", post_content: "content", post_excerpt: "excerpt", post_status: "status", post_modified_gmt: "change time", row_token: "row" };

/** The changed parts the site names, as field names, in the site's order; names of another form are left out. */
function changedParts(data) {
  const list = isPlainObject(data) && Array.isArray(data.changed) ? data.changed : [];
  const names = list.filter((name) => typeof name === "string" && NAME_FORM.test(name)).slice(0, 20);
  return [...new Set(names.map((name) => COLUMN_FIELDS[name] ?? name.replace(/^post_/, "")))];
}

/**
 * THE OUTCOME OF THE WRITE (step `write_outcome`, right after the publishing
 * step). It reads the site's answer to `cinatra/post-update-if-unchanged` and
 * answers `next`, the branch the flow takes, with the run's output, all built
 * here, never by a model:
 *
 * - `written` for `success` exactly true with the run's post id and the stored
 *   title, content, excerpt and status as texts. `changes` names each field the
 *   reviewed revision saves, with the value as read before and the value the
 *   site stored after (the site's save filters can change it; `message` then
 *   names the fields), and the status when it changed. `proposalId` is
 *   `wp-<post id>-<reviewed revision id>`.
 * - `post_changed`: nothing was written, because the post changed on the site
 *   after the read. The flow goes back to the read; `reviewNotice` tells the
 *   person on the next review that the change was proposed again against the
 *   current post, naming the changed parts the site named.
 * - each other refusal code of the ability (`WRITE_REFUSALS`): nothing was
 *   written; the run ends completed with `error` and its plain message. The
 *   one exception is `transaction_conflict` with `data.site_changes_possible`
 *   exactly true: the post was not changed by this save, but the site's own
 *   code may have changed other parts of the site, so its message does not say
 *   that nothing was written.
 * - `write_outcome_unknown`: the site did not confirm whether the change was
 *   stored (`data.cause` `unreadable`, `matches` or `differs`; with `matches`
 *   the post shows the change, but the site's after-save steps did not run).
 *   The run fails with that code, and its message never says that nothing was
 *   written or that the change was saved: the person checks the post, its
 *   revisions and the site's caches before trying again.
 * - On a refusal, `data.cache_stale` exactly true adds one sentence: the site
 *   may still show an outdated copy of the post.
 *
 * Any other answer is refused (`write_answer_unreadable`): the run fails and
 * tells the person to check the post on the site, because the save's outcome
 * is not known. The site's own text is never repeated.
 */
function outcome(call) {
  const refuse = (cause) => {
    throw new Refusal(OUTCOME_CODE, cause);
  };
  const postId = (textInput(call.postId) ?? "").trim();
  const instanceId = readText(call.instanceId).trim();
  const base = { ok: true, postId, instanceId, proposalId: "", changeSetId: "", changes: [], error: {}, message: "", reviewNotice: "" };
  const success = jsonValue(call.success);
  const code = jsonValue(call.code);
  const data = jsonValue(call.data);
  const stale = cacheStale(data) ? ` ${CACHE_STALE_NOTE}` : "";
  if (success === false && code === "post_changed") {
    const parts = changedParts(data);
    const named = parts.length > 0 ? ` (changed: ${parts.join(", ")})` : "";
    return {
      ...base,
      next: "post_changed",
      reviewNotice:
        `Nothing was written: the post changed on the site after it was read${named}. ` +
        `The change was proposed again against the current post; review it again.${stale}`,
    };
  }
  if (success === false && typeof code === "string" && Object.prototype.hasOwnProperty.call(WRITE_REFUSALS, code)) {
    const flagged = code === "transaction_conflict" && isPlainObject(data) && data.site_changes_possible === true;
    const message = `${flagged ? SITE_CHANGES_POSSIBLE : WRITE_REFUSALS[code]}${stale}`;
    return { ...base, next: code, error: { code, message }, message };
  }
  if (success === false && code === OUTCOME_UNKNOWN_CODE) {
    const cause = isPlainObject(data) ? data.cause : undefined;
    const why =
      cause === "unreadable"
        ? "the post could not be read back after the save"
        : cause === "matches"
          ? "the post read back shows the change, but the site did not confirm the save and its after-save steps did not run"
          : cause === "differs"
            ? "the post read back is neither the post as it was before nor the change"
            : "the site's answer names no cause this agent knows";
    throw new Refusal(OUTCOME_UNKNOWN_CODE, `${why}${cacheStale(data) ? ", and the site may still show an outdated copy of the post" : ""}`);
  }
  if (success !== true) refuse("the site's answer is neither a save nor a refusal this agent knows");
  if (!/^[1-9][0-9]*$/.test(postId) || jsonValue(call.post_id) !== Number(postId)) refuse("the site's answer names another post than the run's post");
  const stored = {};
  for (const [field, column] of [["title", "post_title"], ["content", "post_content"], ["excerpt", "post_excerpt"], ["status", "post_status"]]) {
    stored[field] = jsonValue(call[column]);
    if (typeof stored[field] !== "string") refuse(`the site's answer to the save carries no stored ${field}`);
  }
  const revisionId = readText(call.reviewedRevisionId).trim();
  if (revisionId === "") refuse("the run names no reviewed revision");
  const changes = [];
  for (const [field, input] of [["title", "reviewedTitle"], ["content", "reviewedContent"], ["excerpt", "reviewedExcerpt"]]) {
    if ((textInput(call[input]) ?? "") === "") continue;
    changes.push({ field, before: textInput(call[field]) ?? "", after: stored[field] });
  }
  const statusBefore = textInput(call.status) ?? "";
  if (stored.status !== statusBefore) changes.push({ field: "status", before: statusBefore, after: stored.status });
  const sanitized = (Array.isArray(jsonValue(call.sanitized_fields)) ? jsonValue(call.sanitized_fields) : [])
    .filter((name) => typeof name === "string" && Object.prototype.hasOwnProperty.call(COLUMN_FIELDS, name))
    .map((name) => COLUMN_FIELDS[name]);
  const demoted = statusBefore === "publish" && stored.status === "draft" ? " The post was published; it is now a draft." : "";
  const filtered = sanitized.length > 0 ? ` The site's save filters changed the ${sanitized.join(", ")} as stored.` : "";
  return {
    ...base,
    next: "written",
    proposalId: `wp-${postId}-${revisionId}`,
    changes,
    message: `Saved the reviewed change to post ${postId}.${demoted}${filtered}`,
  };
}

/**
 * THE ONE CALLABLE EXPORT the declared-tools contract pins: one function of one
 * argument, `{ input, ports }`. Its operations are `input`, `page`, `form`, `unchanged`,
 * `read` and `outcome`; any other is refused.
 */
export async function extensionTool({ input, ports }) {
  const call = isPlainObject(input) ? input : {};
  const op = typeof call.op === "string" ? call.op.trim() : "";
  if (op === "form") return form(call);
  if (op === "unchanged") return unchanged(call);
  if (op === "read") return read(call, ports);
  if (op === "input") return runInput(call);
  if (op === "page") return page(call);
  if (op === "outcome") return outcome(call);
  throw new Error(`reviewed_change: \`op\` must be input, page, form, unchanged, read or outcome — got ${JSON.stringify(call.op)}`);
}
