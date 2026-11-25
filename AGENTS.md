# wordpress-agent — AGENTS.md

Agent-specific guidance for `@cinatra/wordpress-agent`. Read alongside the repo-root `AGENTS.md`, the flow in `cinatra/oas.json` and the pack tool `cinatra/tools/reviewed-change.mjs`.

## KNOWN GAP — do not merge or deploy this flow until each item below is closed (cinatra-ai/cinatra#3745)

The flow reads and writes the site without a model: two of its steps call connector tools directly on the host's passthrough road (`/api/agents/passthrough`). The host does not serve connector tools there yet, so until these land a run fails at the read step with the road's refusal (`Tool "wordpress_site_tool_call" is not on the deterministic-passthrough allowlist`, HTTP 403). Nothing is written in that case.

1. **The host serves `wordpress_site_tool_write` to the publishing step `write_page`.** Today the road serves a tool off its allowlist only when a host-wired package declares `passthroughPublishingStep: true` (cinatra PR #4788, `src/lib/passthrough-publishing-step-tools.ts`, `HOST_PRIMITIVE_SOURCES`: the email send start only). The connector declares `passthroughStep: "publishing"` on the write tool's registration (wordpress-mcp-connector `src/mcp/registry.ts`, `PASSTHROUGH_STEPS`). The host must read that declaration from the installed connector's registration, serve the tool only to a top-level publishing step of the run's bound flow whose newest publish decision is released, use the decision once with the connector's own package, version, install id and digest as the action owner, run the handler in the run's MCP request frame (so the connector's instance write authority resolves), and let the released decision stand for the invoker's destructive confirmation (`cinatra/post-update-if-unchanged` is annotated destructive).
2. **The host serves `wordpress_site_tool_call` to the read step `read_page`, with no person's decision, only after it enforces the read class at execution** (cinatra#4796, open: the invoker refuses an entry whose annotations differ from the row the connector checked, and refuses a read-declared call whose resolved entry is not read-class). Only then does the connector add `passthroughStep: "read"` to the read tool, and the host serves a tool so declared to a step that is not a publishing step.
3. **The site runs the cinatra plugin with the two abilities `cinatra/post-read` and `cinatra/post-update-if-unchanged`** (cinatra-ai/wordpress-plugin PR #120). A site without them answers the read with an unknown tool, and the run fails at the read.

## Repair capability (cinatra-ai/cinatra#2286) — declared, but inert until cinatra core catches up

`package.json`'s `cinatra.lifecycle.repairCapable: true` means this template's own runs can be re-driven for a repair round-trip: when a reviewer requests changes on a post this agent already edited, cinatra core can dispatch a NEW run of this SAME template instead of escalating straight to a human. That dispatched run uses no new input shape — it is the ordinary `instanceId`/`postId`/`postType`/`postStatus`/`instructions` contract documented below, with `instructions` describing the reviewer's findings instead of a person's free-form request. `compose_change.data.system` tells the compose step to treat such findings as the request ("On a repair round the findings ARE the request"); the write step then saves only what the person reviewed, as on any run.

**This declaration has no effect by itself yet — nothing dispatches a repair run against it today.** It only starts doing anything once (a) cinatra core ships the delivered-repair execution bridge, and (b) cinatra's pin for this package advances to a version carrying this declaration.

## Agent role

A WayFlow `node`-type flow. It receives a plain-language request for one WordPress post or page, reads the post from the site, has one model step propose the new values, files them as a page snapshot for a person to review, and after the person's approval and release writes exactly the reviewed values, only if the post did not change on the site since the read. Invoked via A2A blocking dispatch from `/api/agents/wordpress-content-editor/stream` (unified SSE gateway) or from `wordpress_content_editor_run` in Cinatra `/chat`.

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

All fields are strings. `postId` must be a whole number; the read step sends it to the site as a number. `postType` is a hint (`post`, `page` or empty); the type comes from the site's read, and pages are edited like posts. Any other `postType` ends the run at the check of the read. `postStatus` is not used: the status comes from the read.

## A2A output contract

```json
{
  "postId": "42",
  "instanceId": "wp-prod",
  "proposalId": "wp-42-<reviewed revision id>",
  "changes": [
    { "field": "title", "before": "Old headline", "after": "New headline" },
    { "field": "status", "before": "publish", "after": "draft" }
  ],
  "message": "Saved the reviewed change to post 42. The post was published; it is now a draft."
}
```

All values are built by code (`write_outcome`), never by a model. `changes` names each saved field with the value as read and the value the site stored (its save filters can change it; `message` then names the fields), and the status when it changed. `proposalId` is present only after a save. `changeSetId` is never set (the site answers no revision id).

- **Completed, nothing written, with `error`:** the site refused the save with `site_policy_conflict`, `permission_unverified`, `post_locked`, `unsupported_status`, `invalid`, `not_found`, `unsupported_storage` or `db_error`. `error.code` is the site's code; `error.message` and `message` are a fixed plain sentence per code that starts "Nothing was written".
- **Completed, nothing written, no `error`:** the model proposed no change. `message` repeats the request ("No change was proposed for this request on post 42 …").
- **Failed:** `post_read_unavailable` (the read failed or is not of an editable post), `page_form_unavailable` (the proposal cannot be shown), `reviewed_change_unavailable` (no usable approved revision), `write_answer_unreadable` (the site's answer to the save is neither a save nor a known refusal: check the post on the site). A failure of the host's or the connector's call fails the step and the run.

The caller reads this from `task.history` (not `task.artifacts`).

## The flow (cinatra-ai/cinatra#3745)

```
start → read_page → check_read → compose_change → form_page → route_change
route_change:default → file_page → gather_page_review → page_review_gate → read_reviewed_page → write_page → write_outcome → route_write
route_change:no_change → no_change_outcome → emit_output → end
route_write:written | <each refusal code> | default → emit_output → end
route_write:post_changed → read_page
```

- `read_page` (no model): one call of `wordpress_site_tool_call` with `toolName: "cinatra/post-read"` and `argsJson: {"post_id": <postId as a number>}`. It outputs the site's answer as is: `success`, `code`, `post_id`, `post_title`, `post_content`, `post_excerpt`, `post_status`, `post_type`, `post_modified_gmt`, `permalink`, `row_token`.
- `check_read` (pack tool, op `page`): goes on only for `success: true`, the run's post id, a post or a page, status `publish` or `draft` (the two the site writes), a change time and a row token of the site's form. Else `post_read_unavailable`.
- `compose_change` is the only model step. It declares `metadata.cinatra.tools: []` and no toolbox, so the host serves it no tool. It answers `pageForm.writeFields`: the complete new `title`, `content` and `excerpt`, each a text or null.
- `form_page`, `file_page`, `gather_page_review`, `page_review_gate` and `read_reviewed_page` file the proposal as a page snapshot, have a person review it and read back the approved revision; see "What the review shows". `read_reviewed_page` answers `reviewedTitle`, `reviewedContent`, `reviewedExcerpt` (empty when not saved), `reviewedRevisionId` and `reviewedSnapshot` (that revision as a one-item list).
- `write_page` is the one publishing step (`publishes: true`, top-level, no model). See "The write".
- `write_outcome` (pack tool, op `outcome`) reads the site's answer and answers `next` and the run's output. `route_write` branches on `next`: `written` and each refusal code end the run; `post_changed` goes back to `read_page`.

**`post_changed`.** The site refused the save because the post changed after the read (another save, also in the same second or of another column such as the slug). Nothing was written. The run goes back to the read: the post is read again, the model proposes the change again against the current post, a new snapshot is filed and the person reviews it; the review shows `reviewNotice` ("Nothing was written: the post changed on the site after it was read (changed: content). The change was proposed again against the current post; review it again."). The write then needs a new release on the publish card. Each turn of this loop waits for a person, so it cannot run on alone.

## The write

`write_page` makes one call of `wordpress_site_tool_write` with `toolName: "cinatra/post-update-if-unchanged"` and `argsJson` rendered from a template over its own inputs:

```
{"post_id": <postId>, "if_unmodified_since": <modified>,
 "expected": {"title": <title>, "content": <content>, "excerpt": <excerpt>, "status": <status>, "row_token": <rowToken>}
 [, "title": <reviewedTitle>] [, "content": <reviewedContent>] [, "excerpt": <reviewedExcerpt>] [, "status": "draft" when status is publish]}
```

Each value is written with `tojson`; no value is put into the JSON text by hand. Each input has exactly one data edge: `postId`, `modified`, `title`, `content`, `excerpt`, `status` and `rowToken` from `read_page` (the site's answer, byte for byte), the reviewed values and the revision from `read_reviewed_page`, `instanceId` from `start`. No value of the model step reaches the write. A field the review does not save is not sent. A published post is moved to draft in the same save, so the live page goes offline until a person publishes it; the previous revision stays in WordPress's revision history.

The site compares, under a row lock, the change time, the four values and the row token with the stored post, and writes only when all are equal (see the plugin's documentation, "Content abilities"). There is no re-read before the write and no window between a check and an unconditional update.

**The publish card** shows four rows: the site (`instanceId`), the title as read, the status as read (its label states that a published post becomes a draft), and the reviewed page snapshot revision (`reviewedSnapshot`, an artifacts row: the changed blocks).

## What the review shows

`compose_change` answers the values to save in `pageForm.writeFields`. `form_page` calls the pack's `reviewed_change` tool (op `form`). It sets each value that equals the post as read to null (not saved), so the filed values, the shown excerpts and the saved values name the same fields. It derives the excerpts the review shows from those values and the post as read, by code: each value is split into its top-level blocks (an element with its content, a comment, or a run of text), the blocks of the post as read and of the value are compared, and every block that differs is shown with its source text on both sides, markup and link targets included. The blocks it does not show are byte for byte the post as read. The tool refuses (`page_form_unavailable`) when the values differ from the post only in white space, touch more than 200 blocks, or are not texts or null; it bounds its work before it compares (a value of more than 2,000,000 characters, a content of more than 20,000 blocks, or a comparison table of more than 4,000,000 cells is refused).

When no value changes the post, `form_page` answers `next: "no_change"` and `route_change` takes the run to `no_change_outcome` (op `unchanged`): the run completes with empty `changes`, no `error` and a `message` built from the request.

After the review, `read_reviewed_page` (op `read`) takes the revision the review's answer approves (`approved: true`, `review.decision` "approved", envelope version 1, exactly one target, on the artifact this run filed), never the revision this run filed: after a Regenerate the approved revision is a successor. It reads that revision through the host's artifact read port by its revision id, derives the excerpts again from its `writeFields` and the post as read, and answers the values only when they equal the excerpts the revision shows and the excerpts show every value it would save. Else `reviewed_change_unavailable`, and no site call is made.

Plain text hides characters and white space, so one rule applies to each changed block (`checkedBlock`), at the form and at the read-back, byte for byte. A changed block that holds an invisible character (Unicode Cf, Cc except tab, line feed and carriage return, Zs except U+0020, Zl, Zp, default ignorable characters and variation selectors) in the post as read or in the value to save is refused. In the changed part of a block, white space may only be a single U+0020 between two visible characters. The compose step's instructions say so: a new or changed block is written on one line.

## Timeout

The `wordpress_content_editor_run` MCP primitive uses `timeoutMs: 300_000` (5 minutes). The unified SSE gateway (`/api/agents/[agentSlug]/stream`) uses `timeoutMs: 600_000` at the A2A level. A run waits for a person at the review and at the publish card.

## Local dev URL

Default WayFlow agent URL: `http://localhost:3021`. Start with:

```bash
docker compose --profile wordpress up -d
```

Override via `WP_CONTENT_EDITOR_A2A_URL` in `.env.local` (e.g. `http://wayflow-wordpress-content-editor:3021` when Cinatra itself runs inside Docker).
