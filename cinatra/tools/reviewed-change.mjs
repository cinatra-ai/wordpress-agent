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
 *   show. A change that adds, removes or moves a character that draws nothing
 *   or changes the direction of the text is refused (see the invisible
 *   characters below). The excerpts the compose step answers, if any, are never filed. It
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

// --- invisible characters --------------------------------------------------
//
// The display draws the excerpts as plain text: a changed block as its source,
// so markup is shown. A character that draws nothing, or that changes the
// direction of the text around it, is not: the person who reviews the change
// cannot see it. Such a character is called invisible here:
// - a format character (Unicode category Cf): the zero-width space, non-joiner
//   and joiner, the word joiner, U+FEFF, the soft hyphen, the direction marks
//   and the direction embeddings, overrides and isolates, and the tag
//   characters;
// - a control character (Cc) other than tab, line feed and carriage return;
// - a space (Zs) other than U+0020 and U+00A0, and the line and paragraph
//   separators (Zl, Zp): a thin, hair or narrow space can join or split words
//   unseen, and the display draws a separator as a space;
// - any other character Unicode marks as default ignorable, which draws
//   nothing in normal text (for example U+034F or the Hangul fillers), except
//   the variation selectors U+FE00 to U+FE0F, which only choose the look of
//   the visible character before them (an emoji or a text form).
//
// U+00A0, the no-break space, is taken as a space and kept as it is: the
// display draws it as a space of full width, which is what it is; it changes
// no word and no direction; pages often hold it; and a block whose only change
// is a space to U+00A0 is refused already, as a change of white space alone.
//
// THE RULE: a change may not add, remove or move an invisible character. It
// is computed on the difference between the read value and the value to
// write, so a page that already holds such characters can still be edited.
// The visible text of the two values (each value without its invisible
// characters) is matched from the start and from the end. In the unchanged
// visible text at the start and at the end, every run of invisible characters
// must stand where it stood. In the changed part between them, each run of
// invisible characters must stand between the same two visible characters on
// both sides, as often: a run is kept where an edit leaves its visible
// neighbours alone, and is added, removed or moved otherwise. So removing a
// joiner from an emoji sequence, or replacing the sequence, is refused: it
// removes a joiner, and changes what is drawn in a way the plain text does not
// show. A change that breaks the rule is refused before anything is filed,
// with the first such character named by its code point.

const INVISIBLE_CLASS = String.raw`(?![\t\n\r \u00A0\uFE00-\uFE0F])[\p{Cf}\p{Cc}\p{Zs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]`;
const INVISIBLE_ONE = new RegExp(`^${INVISIBLE_CLASS}$`, "u");
const INVISIBLE_RUN = new RegExp(`(?:${INVISIBLE_CLASS})+`, "uy");
const INVISIBLE_ANY = new RegExp(INVISIBLE_CLASS, "u");

/**
 * The most invisible characters the changed part of one value may hold, on
 * both sides together: it bounds the memory of the check. A page holds a few.
 */
const MAX_INVISIBLE = 10_000;

const isHigh = (unit) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit) => unit >= 0xdc00 && unit <= 0xdfff;
const codePointName = (text) => `U+${text.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;

/** The width, in code units, of the character that starts at `i`. */
const widthAt = (text, i) => (isHigh(text.charCodeAt(i)) && isLow(text.charCodeAt(i + 1)) ? 2 : 1);

/** The width, in code units, of the character that ends at `k`. */
const widthBefore = (text, k) => (k >= 2 && isLow(text.charCodeAt(k - 1)) && isHigh(text.charCodeAt(k - 2)) ? 2 : 1);

/** The index after the run of invisible characters that starts at `i` (`i` when there is none). */
function runEnd(text, i) {
  INVISIBLE_RUN.lastIndex = i;
  const match = INVISIBLE_RUN.exec(text);
  return match === null ? i : i + match[0].length;
}

/** The index where the run of invisible characters that ends at `k` starts (`k` when there is none). */
function runStart(text, k) {
  let at = k;
  while (at > 0) {
    const width = widthBefore(text, at);
    if (!INVISIBLE_ONE.test(text.slice(at - width, at))) break;
    at -= width;
  }
  return at;
}

function refuseInvisible(verb, ch, region, refuse) {
  refuse(`the change ${verb} an invisible character ${codePointName(ch)} in the ${region}, which the page snapshot cannot show`);
}

/** Refuses when two runs of invisible characters at one unchanged place differ: names the first character that differs. */
function sameRun(region, was, will, refuse) {
  if (was === will) return;
  let i = 0;
  while (i < was.length && i < will.length && was.codePointAt(i) === will.codePointAt(i)) i += widthAt(was, i);
  if (i < will.length) refuseInvisible("adds", will.slice(i), region, refuse);
  refuseInvisible("removes", was.slice(i), region, refuse);
}

/**
 * The runs of invisible characters of `text` from `from` to `to`, each counted
 * by `sign` in `counts` under a key made of the visible character before it,
 * the run and the visible character after it.
 */
function countRuns(text, from, to, sign, counts, state) {
  let i = from;
  while (i < to) {
    const end = runEnd(text, i);
    if (end === i) {
      i += widthAt(text, i);
      continue;
    }
    state.characters += end - i;
    if (state.characters > MAX_INVISIBLE) {
      state.refuse(`the changed part of the ${state.region} holds more than ${MAX_INVISIBLE} invisible characters, more than the page snapshot form can check`);
    }
    const before = i === 0 ? "" : text.slice(i - widthBefore(text, i), i);
    const after = end >= text.length ? "" : text.slice(end, end + widthAt(text, end));
    const key = `${before}\u0000${text.slice(i, end)}\u0000${after}`;
    counts.set(key, (counts.get(key) ?? 0) + sign);
    i = end;
  }
}

/** Refuses unless the value to write keeps every invisible character of the read value, by THE RULE above, and adds none. */
export function checkedInvisibles(region, was, will, refuse) {
  if (!INVISIBLE_ANY.test(was) && !INVISIBLE_ANY.test(will)) return;
  // The unchanged start: the common text, cut back to the start of the run of
  // invisible characters it ends in, then matched visible character by
  // visible character.
  let start = 0;
  const shorter = Math.min(was.length, will.length);
  while (start < shorter && was.charCodeAt(start) === will.charCodeAt(start)) start += 1;
  if (start > 0 && isHigh(was.charCodeAt(start - 1))) start -= 1;
  start = runStart(was, start);
  let fromWas = start;
  let fromWill = start;
  let endWas;
  let endWill;
  for (;;) {
    endWas = runEnd(was, fromWas);
    endWill = runEnd(will, fromWill);
    const doneWas = endWas >= was.length;
    const doneWill = endWill >= will.length;
    const nextWas = doneWas ? "" : was.slice(endWas, endWas + widthAt(was, endWas));
    const nextWill = doneWill ? "" : will.slice(endWill, endWill + widthAt(will, endWill));
    if (nextWas !== nextWill) break;
    sameRun(region, was.slice(fromWas, endWas), will.slice(fromWill, endWill), refuse);
    if (doneWas) return;
    fromWas = endWas + nextWas.length;
    fromWill = endWill + nextWill.length;
  }
  // The unchanged end, matched the same way from the end, never into the
  // unchanged start.
  let tail = 0;
  const longest = Math.min(was.length - endWas, will.length - endWill);
  while (tail < longest && was.charCodeAt(was.length - 1 - tail) === will.charCodeAt(will.length - 1 - tail)) tail += 1;
  let toWas = was.length - tail;
  let toWill = will.length - tail;
  if (tail > 0 && toWas < was.length && isLow(was.charCodeAt(toWas))) {
    toWas += 1;
    toWill += 1;
  }
  const skip = runEnd(was, toWas) - toWas;
  toWas += skip;
  toWill += skip;
  for (;;) {
    const backWas = runStart(was, toWas);
    const backWill = runStart(will, toWill);
    const prevWas = backWas > endWas ? was.slice(backWas - widthBefore(was, backWas), backWas) : "";
    const prevWill = backWill > endWill ? will.slice(backWill - widthBefore(will, backWill), backWill) : "";
    if (prevWas === "" || prevWas !== prevWill) break;
    sameRun(region, was.slice(backWas, toWas), will.slice(backWill, toWill), refuse);
    toWas = backWas - prevWas.length;
    toWill = backWill - prevWill.length;
  }
  // The changed part: each run kept between the same two visible characters.
  const counts = new Map();
  const state = { region, refuse, characters: 0 };
  countRuns(was, fromWas, toWas, 1, counts, state);
  countRuns(will, fromWill, toWill, -1, counts, state);
  let removed;
  let added;
  for (const [key, count] of counts) {
    const run = key.split("\u0000")[1];
    if (count > 0 && removed === undefined) removed = run;
    if (count < 0 && added === undefined) added = run;
  }
  if (removed !== undefined && added !== undefined && removed.codePointAt(0) === added.codePointAt(0)) {
    refuseInvisible("moves", removed, region, refuse);
  }
  if (added !== undefined) refuseInvisible("adds", added, region, refuse);
  if (removed !== undefined) refuseInvisible("removes", removed, region, refuse);
}

function excerpt(region, position, published, proposed, refuse) {
  if (sameWords(published, proposed)) {
    refuse(`the change of the ${region} differs from the post only in white space, which the page snapshot cannot show`);
  }
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
 * value is checked first, then the invisible characters of each value that
 * changes (`checkedInvisibles`), then the content is split into blocks, each
 * counted against MAX_BLOCKS as it is made. `meter.blocks`, when given, counts
 * the blocks made.
 */
export function excerptsOf(read, writeFields, refuse, meter) {
  for (const field of FIELDS) {
    if (read[field].length > MAX_TEXT) refuse(`the ${field} as read is longer than ${MAX_TEXT} characters`);
    if (writeFields[field] !== null && writeFields[field].length > MAX_TEXT) {
      refuse(`the value to save for the ${field} is longer than ${MAX_TEXT} characters`);
    }
  }
  for (const field of FIELDS) {
    if (writeFields[field] !== null && writeFields[field] !== read[field]) checkedInvisibles(field, read[field], writeFields[field], refuse);
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

/** The statuses of a post this flow edits; a successful read answers one of them. */
const READ_STATUSES = new Set(["publish", "draft", "pending", "private", "future"]);

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
 * flow edits (`publish`, `draft`, `pending`, `private` or `future`; a trashed
 * post, an automatic draft, a revision and any other text are refused); a
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
