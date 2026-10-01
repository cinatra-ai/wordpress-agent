/**
 * The pack's one declared tool, `review_targets`: it names the filed page
 * snapshot to the application, which reviews it. It reads and writes no other
 * port, no table and no artifact.
 */

/** A value the flow sends as JSON text, read back. */
function parseJsonish(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** Hand the set to the application exactly as given, parsed when it is JSON text. */
async function review(input, ports) {
  const parsed = parseJsonish(input.reviewTargets);
  const targets = parsed === null ? input.reviewTargets : parsed;
  ports.review.file(targets);
  return { ok: true };
}

/** The one callable export: `{ input, ports }`, with the one operation `review`. */
export async function extensionTool({ input, ports }) {
  const call = input && typeof input === "object" ? input : {};
  if (call.op === "review") return review(call, ports);
  throw new Error(`review_targets: \`op\` must be review — got ${JSON.stringify(call.op)}`);
}
