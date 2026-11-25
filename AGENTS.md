# wordpress-agent — AGENTS.md

Agent-specific guidance for `@cinatra/wordpress-agent`. Read alongside the repo-root `AGENTS.md` and the agent instructions in `cinatra/oas.json` (the `edit` node's `data.system`).

## KNOWN GAP — do not merge/deploy this cutover until ALL THREE close (cinatra-ai/cinatra#2022, #2043)

This repo's manifest/prompt now target the generic connector-instance invokers (`wordpress_site_tool_call` for reads, `wordpress_site_tool_write` for the post update) instead of the named `wordpress_post_get`/`wordpress_post_update` tools. Three things must be true before this actually ships to real traffic, not just "code exists":

1. **wordpress-mcp-connector's transport retarget merges and soaks first.** This agent's prompt assumes `ewpa/get-post` / `ewpa/get-page` / `ewpa/update-post` exist and behave as wordpress-mcp-connector's own retarget PR documents (branch `feat/2022-s7-tau-review-gate`) — if that approach changes before it merges, this prompt needs a matching follow-up.
2. **The review-before-publish gate (`evaluateStagedContentWrite`, cinatra#2043) must be reachable from this agent's new call path — it is NOT, yet.** Today that gate is wired INLINE inside wordpress-mcp-connector's `wordpress_post_update` handler, which is the exact handler this agent is being moved OFF of. wordpress-mcp-connector's transport-retarget PR explicitly does not migrate the gate onto the generic invoker's shared review-hook slot — it's a disclosed, deferred follow-up (binding a WordPress-specific hook into cinatra core's `register-host-connector-services.ts`, alongside where the existing destructive-confirmation hook is bound today, since a connector-only package cannot make that host-side edit). Until that binding lands AND is verified to fire for a write reaching WordPress through `wordpress_site_tool_write` (not just through the old named tool), deploying this agent's rewrite lets it apply real content writes with **no review-before-publish enforcement at all** — a silent regression, not a cosmetic one. Confirm that binding is live and tested before merging/cutting this agent over. Inside this flow, the write step saves only the values of the page snapshot revision the person reviewed: `read_reviewed_page` reads that revision back after the review, by its revision id, and the write step takes `title`/`content`/`excerpt` only from its `writeFields` member; with no usable reviewed change it writes nothing (`reviewed_change_unavailable`). That is an instruction to the model, not an enforcement: only the host-side gate holds a write to the reviewed revision.
3. **cinatra core's in-admin CMS tool allowlist must admit the generic primitives — it does NOT, yet.** This agent's runs are classified host-side as in-admin CMS content-editor dispatches, and the hosted-MCP relay only advertises/permits tools named in `IN_ADMIN_CMS_MCP_ALLOWED_TOOLS` (`packages/mcp-server/src/in-admin-cms-tool-policy.ts` in the cinatra monorepo) — which today lists `wordpress_post_get`/`wordpress_post_update`, neither `wordpress_site_tool_call` (reads) nor `wordpress_site_tool_write` (the post update). Declaring a primitive in this repo's `consumes[]` is an install-time dependency check only; it grants nothing at runtime. Until the cinatra-core allowlist swaps in both `wordpress_site_tool_call` and `wordpress_site_tool_write` (planned to land together with the facade-deletion PR and this cutover, per the program's design), every call this agent's rewritten prompt makes is rejected by the relay with a structured denial — the agent simply cannot work. A connector/agent-repo PR structurally cannot make that edit; it must ship as its own cinatra-core change.

## Repair capability (cinatra-ai/cinatra#2286) — declared, but inert until cinatra core catches up

`package.json`'s `cinatra.lifecycle.repairCapable: true` means this template's own runs can be re-driven for a repair round-trip: when a reviewer requests changes on a post this agent already edited, cinatra core can dispatch a NEW run of this SAME template instead of escalating straight to a human. That dispatched run uses no new input shape — it is the ordinary `instanceId`/`postId`/`postType`/`postStatus`/`instructions` contract documented below, with `instructions` describing the reviewer's findings instead of a person's free-form request. `cinatra/oas.json`'s `compose_change.data.system` tells the compose step to treat such findings as the request ("On a repair round the findings ARE the request"); the write step then saves only what the person reviewed, as on any run.

**This declaration has no effect by itself yet — nothing dispatches a repair run against it today.** It only starts doing anything once (a) cinatra core ships the delivered-repair execution bridge (the run-dispatch + completion-adapter plumbing that turns an open repair into a run of this template and reads the resulting write back into the repair record — this agent has no producer-side code of its own; its own normal run execution IS the handler), and (b) cinatra's pin for this package advances to a version carrying this declaration. Until both land, `repairCapable` is a harmless, unused label on the manifest — same posture as the KNOWN GAP above.

## Agent role

A WayFlow `node`-type leaf agent. Receives natural language editing instructions and a WordPress post context, applies changes through the site's own MCP ability catalog via the governed connector-instance invokers (reads through `wordpress_site_tool_call`, the post update through `wordpress_site_tool_write`, cinatra-ai/cinatra#2022 S7), and returns a structured diff. Invoked via A2A blocking dispatch from `/api/agents/wordpress-content-editor/stream` (unified SSE gateway) or from `wordpress_content_editor_run` in Cinatra `/chat`.

Mirrors `agents/drupal-content-editor` structurally but differs in the draft-revision approach — see the critical section below.

## A2A input contract

The caller sends a single `user` message whose text is a JSON-stringified object:

```json
{
  "instanceId": "wp-prod",
  "postId": "42",
  "postType": "post",
  "postStatus": "publish",
  "instructions": "Change the title to 'New headline' and fix the second paragraph."
}
```

All fields are strings. `postId` is a string representation of a numeric ID — the agent itself must coerce it to a number before including it as `post_id` in any `ewpa/*` ability args (there is no longer a schema-level coercion step between the agent and WordPress; see "MCP primitives used" below). The agent reads these from the most recent user message in conversation history.

## A2A output contract

```json
{
  "postId": "42",
  "instanceId": "wp-prod",
  "proposalId": "wp-42-k3f9qz",
  "changeSetId": "rev-311",
  "changes": [
    { "field": "title", "before": "Old headline", "after": "New headline" },
    { "field": "content", "before": "Old paragraph...", "after": "Fixed paragraph..." }
  ]
}
```

`proposalId` is REQUIRED on every diff result (minted by the agent, opaque correlation string linking the diff card to the already-saved draft); `changeSetId` is OPTIONAL (present only when a response actually carried a revision identifier — never fabricated).

**Unsupported-postType error variant** (no write attempted, so no `proposalId` — nothing was saved to correlate with):

```json
{
  "postId": "42",
  "instanceId": "wp-prod",
  "changes": [],
  "error": { "code": "unsupported_post_type", "message": "..." }
}
```

Emitted when `postType` is neither unset/`"post"` nor `"page"` (code `unsupported_post_type`, no WordPress call made at all). An edit requested for a page (code `page_editing_unsupported`) ends the run failed at the compose step, before anything is filed, reviewed or shown on the publish card. A request that changes nothing is no error: it ends the run completed with empty `changes`, no `error` and a `message`, past the filing and the review (see below).

**Stopped variant** (the run completes, nothing was written, no `proposalId`): `post_changed` when the post's change time or status differs, just before the write, from the read the review was based on (another editor changed, published or unpublished it during the review), and `reviewed_change_unavailable` when the write step is handed no usable reviewed values (a backstop; the step in front of it already fails the run in that case, see below). The `message` says that nothing was written.

The caller reads this from `task.history` (not `task.artifacts`) — WayFlow's `task.artifacts` is not implemented.

## The write saves only the reviewed change (cinatra-ai/cinatra#3745)

The flow is `start` → `read_page` → `compose_change` → `form_page` →
`route_change` → `file_page` → `gather_page_review` → `page_review_gate` →
`read_reviewed_page` → `edit` → `emit_output` → `end`. When no value to save
changes the post, `form_page` answers `next: "no_change"` and the branch
`route_change` takes the run to `no_change_outcome` (op `unchanged`, which
checks this again) → `emit_output` → `end`: the run completes with empty
`changes` and no `error`, and nothing is filed, reviewed or written. The
output then carries `message`, built in code (never by the model) from the
run's `instructions` (a data edge from `start`), the post id and the read
title: "No change was proposed for this request on post 42 ("Opening
hours"), so nothing was reviewed or written: <request>", the request
flattened to one line and cut to 300 characters. The compose step's answer is
the same for a request already satisfied and for a request the model dropped,
so no code can tell them apart; the message lets the person see it. On the
`edit` road `message` stays empty and is left out of the output.

`compose_change` answers the values to save in `pageForm.writeFields`: the
complete new `title`, `content` and `excerpt`, each a non-empty string or
null. It answers no excerpts. `form_page` calls the pack's `reviewed_change`
tool (`cinatra/tools/reviewed-change.mjs`, op `form`). It sets each value that
equals the post as read to null (not saved), so the filed values, the shown
excerpts and the saved values name the same fields. It derives the
excerpts the review shows from those values and the post as read, by code: each
value is split into its top-level blocks (an element with its content, a
comment, or a run of text), the blocks of the post as read and of the value are
compared, and every block that differs is shown with its source text on both
sides, markup and link targets included. The blocks it does not show are byte
for byte the post as read. So a change of a link target alone is shown, and no
value can be saved that the review does not show. The tool refuses
(`page_form_unavailable`, the run fails, nothing is filed) when the values
differ from the post only in white space (the display shows no
difference there), touch more than 200 blocks, or are not texts or null. It
bounds its work before it compares: a value of more than 2,000,000
characters, a content of more than 20,000 blocks, or a changed part (the
blocks between the unchanged ones at the start and at the end) whose
comparison table would exceed 4,000,000 cells is refused. The read-back
applies the same bounds.

After the review, `read_reviewed_page` calls the same tool (op `read`). It
takes the revision the review's answer approves (`review.targets` of the
answer that resumes the run; the answer must be an approval: `approved: true`
and `review.decision` "approved", envelope version 1, exactly one target, on
the artifact this run filed), never the revision this run filed: after a
Regenerate the approved revision is a successor of the filed one. It reads that
revision through the host's artifact read port by its revision id, derives the
excerpts again from its `writeFields` and the post as read, and answers
`reviewedFields` (the JSON text of the values) and `reviewedRevisionId` only
when they equal the excerpts the revision shows and the excerpts show every
value it would save. `edit` saves exactly
`reviewedFields`. The tool refuses, so the run fails with
`reviewed_change_unavailable` and a message and no WordPress call is made, when
the answer names no single approved revision of the filed artifact, when the
read fails, is cut short or answers another revision or artifact, when the text
is not a WordPress page snapshot or carries no values to save, and when its
values differ from the excerpts it shows or include a value the excerpts do
not show. The re-read of the post before the
write (`post_changed`), `page_editing_unsupported` and
the rows of the publish card stay as they are.

What the review cannot show: a change of white space alone (refused, see
above), and the post as read is the read step's answer, so the unshown blocks
equal that answer, not a second read of the site. Plain text also hides
characters and white space, so one rule applies to each changed block
(`checkedBlock`), at the form and at the read-back, byte for byte, with no
exception and no normalisation. A changed block that holds an invisible
character (Unicode Cf, Cc except tab, line feed and carriage return, Zs except
U+0020, so U+00A0 too, Zl, Zp, default ignorable characters and variation
selectors) in the post as read or in the value to save is refused: the agent
does not change such a block, a person does it on the site; this freezes
blocks with joined emoji, emoji variation selectors, soft hyphens, direction
marks or no-break spaces. In the changed part of a block (between its
byte-equal start and end, widened so no run of white space is cut), white
space may only be a single U+0020 between two visible characters: a tab, a
line break or two spaces there, in text or inside markup such as an attribute,
is refused. The excerpt shows the block's source, so markup and link targets
are seen; the agent can change words and markup and add a block written
without line breaks, but cannot change white space other than single spaces.

## Draft-revision workflow — CRITICAL asymmetry with Drupal

WordPress lacks a true draft-revision API. The agent prompt enforces a **demote-then-edit** pattern:

1. `ewpa/get-post` (or `ewpa/get-page`) → read current content (including `content` field — required for before/after diff) and its change time; the change is composed, filed as a page snapshot and reviewed
2. `ewpa/get-post` again just before the write — the write is made only when the change time and the status still equal the first read. This is a check, not a conditional write: `ewpa/update-post` takes no expected change time or revision (see the table below), so an edit saved on the site between this re-read and the update is overwritten. Closing that window needs the site ability to take an expected change time and refuse the update when the post's stored change time differs.
3. `ewpa/update-post` with the reviewed values AND `status: "draft"` in the SAME call when the status read is `publish` — demotes the live post (the live revision is preserved in WordPress's revision history, but the front-of-site copy becomes a draft)
4. `ewpa/get-post` again (independent re-read — the update ability's own response is not trusted for after-values, see below)
5. Return diff JSON

**Do NOT add a "create draft revision" call.** There is no WordPress ability equivalent to Drupal's draft revision endpoint, and the agent must never call `ewpa/create-post` for this — that ability creates a NEW, unrelated post. The agent prompt explicitly forbids it, to prevent the LLM from attempting to fabricate a revision that doesn't exist.

## MCP primitives used (cinatra-ai/cinatra#2022 S7 — generic invoker cutover)

This agent has two WordPress MCP call primitives: the read tool `wordpress_site_tool_call` and the write tool `wordpress_site_tool_write` (plus `wordpress_site_tools_list`, declared optional, unused by the current flow). There are no `wordpress_post_*` named tools anymore — every WordPress call goes through `wordpress_site_tool_call({ instanceId, toolName, args })` (reads only; it refuses an ability that writes) or `wordpress_site_tool_write({ instanceId, toolName, args })` (writes; on an agent run each call waits for the person's recorded decision). Both forward `args` unmodified to the target site's own MCP ability and returns that ability's raw response (`{ success, data }`) unwrapped by nothing in between.

| `toolName` | Purpose |
|---|---|
| `ewpa/get-post` | Read a post by id (`args: { post_id }`) — required for before/after diffs |
| `ewpa/get-page` | Read a page by id (`args: { post_id }`) — used instead of `ewpa/get-post` only when `postType === "page"` |
| `ewpa/update-post` | Via `wordpress_site_tool_write`. Update a post's top-level fields (`args: { post_id, title?, content?, excerpt?, status? }`) — supports `postType === "post"` (default) ONLY; there is no proven page-update or meta-update ability behind this cutover (see below). It has no argument for an expected change time or revision, so the update is unconditional |

`ewpa/create-post` is forbidden by the agent prompt — never call it. Creating new posts is outside the scope of this agent.

**Two capabilities this agent HAD before this cutover and does NOT have anymore, both inherited limitations from the connector-side retarget (wordpress-mcp-connector PR "feat/2022-s7-tau-review-gate", #97) rather than something this agent's own rewrite removes:**
- **Page edits.** The old `wordpress_post_update` handler forwarded `postType` to the plugin's own ability, which supported pages. The community catalog's `ewpa/update-post` has no proven page-safe behavior (no captured schema/execution, no distinct page-update ability) — the connector's own retarget refuses it fail-closed, and this agent's prompt does the same (Rule 6 in `cinatra/oas.json`'s `edit.data.system`) since it no longer routes through that connector handler to inherit the refusal automatically.
- **Meta-only writes.** `wordpress_post_update_meta` is gone from this agent's `consumes[]` (it was already dead per this repo's own AGENTS.md note before this cutover — the agent's SKILL/prompt never actually called it, only warned against misusing `wordpress_post_update` for meta).

## Timeout

The `wordpress_content_editor_run` MCP primitive uses `timeoutMs: 300_000` (5 minutes). The unified SSE gateway (`/api/agents/[agentSlug]/stream`) uses `timeoutMs: 600_000` at the A2A level. Do not reduce these without testing a full read → demote → update cycle.

## Local dev URL

Default WayFlow agent URL: `http://localhost:3021`. Start with:

```bash
docker compose --profile wordpress up -d
```

Override via `WP_CONTENT_EDITOR_A2A_URL` in `.env.local` (e.g. `http://wayflow-wordpress-content-editor:3021` when Cinatra itself runs inside Docker).
