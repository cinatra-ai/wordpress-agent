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

All fields are strings. `postId` must be a whole number from 1 written in digits only (no sign, decimal point, white space or leading zero, at most 9007199254740991); a number input must be such a whole number. `instanceId` must name the site (no white space). The check of the run's inputs refuses anything else with `run_input_invalid` before any site call; the read step sends the checked id to the site as a number. `postType` is a hint (`post`, `page` or empty); the type comes from the site's read, and pages are edited like posts. Any other `postType` ends the run at the check of the read. `postStatus` is not used: the status comes from the read.

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

- **Completed, nothing written, with `error`:** the site refused the save with `site_policy_conflict`, `permission_unverified`, `post_locked`, `unsupported_status`, `invalid`, `empty_content`, `transaction_conflict`, `not_found`, `unsupported_storage` or `db_error`. `error.code` is the site's code; `error.message` and `message` are a fixed plain sentence per code that starts "Nothing was written". The site answers these codes only when it showed its own transaction intact to the end, or refused before starting one (`transaction_conflict` now means only that, with `data.cause` `nested`, `open_transaction`, `autocommit_off` or `completion_type`). A refusal code that carries `data.site_changes_possible: true` contradicts that and fails the run as `write_answer_unreadable`. When the site's answer carries `data.cache_stale: true`, one more sentence says the site may still show an outdated copy of the post for a while (the same sentence ends the review notice after `post_changed`).
- **Completed, nothing written, no `error`:** the model proposed no change. `message` repeats the request ("No change was proposed for this request on post 42 …"). After a `post_changed` answer the same step ends a second pass whose new proposal changes nothing, and its `message` then tells this run's story instead: a change was proposed and reviewed, the site reported that the post changed meanwhile, no further change was proposed on reading the post again (it may already have the requested state), so nothing further was written; the stale-cache sentence of the refused attempt, if it had one, ends the sentence before the request.
- **Completed, outcome not known, `error.code` `write_outcome_unknown`:** the site could not show its own transaction intact to the end of the save (`data.site_changes_possible: true`, `data.cause` `unreadable`, `matches` or `differs`). It is the only site answer after which the change may have been written, and site code may have changed other parts of the site. `message` says that the site may have changed and to check the page at its link (the address as read, else the post id); with `matches` it says "The site reports the page now holds the reviewed content, but could not confirm its own save: check the page (<link>)." It never says that nothing was written or that the change was saved, `changes` is empty and `proposalId` is not set. `route_write` takes its own branch to the end: the save is never tried again by itself.
- **Failed:** `post_read_unavailable` (the read failed or is not of an editable post), `page_form_unavailable` (the proposal cannot be shown), `reviewed_change_unavailable` (no usable approved revision), `write_answer_unreadable` (the site's answer to the save is neither a complete save nor a code the site documents: check the post on the site). A save is claimed only when the answer carries the post id and the stored title, content, excerpt and status as its own fields of their types, each equal to what it should hold: the reviewed value for a saved field (or the value the site names in `sanitized_fields` as changed by its save filters), the value as read for a field not saved, and the status the save sets. A field the answer lacks reaches `write_outcome` as null (the runtime's extraction, and `write_page`'s declared default for the four texts), so it is never read as a match. A failure of the host's or the connector's call fails the step and the run.

The caller reads this from `task.history` (not `task.artifacts`).

## The flow (cinatra-ai/cinatra#3745)

```
start → check_input → read_page → check_read → compose_change → form_page → route_change
route_change:default → file_page → gather_page_review → page_review_gate → read_reviewed_page → write_page → write_outcome → route_write
route_change:no_change → no_change_outcome → emit_output → end
route_write:written | <each refusal code> | write_outcome_unknown | default → emit_output → end
route_write:post_changed → read_page
```

- `check_input` (pack tool, op `input`, no site call): checks `postId`, `instanceId` and the `postType` hint as described above, and answers the post id as a number. Else `run_input_invalid`, and the run ends before anything is read.
- `read_page` (no model): one call of `wordpress_site_tool_call` with `toolName: "cinatra/post-read"` and `argsJson: {"post_id": <checked post id>}`, rendered with `tojson` only. Its `instanceId` and `postId` come only from `check_input`. It outputs the site's answer as is: `success`, `code`, `post_id`, `post_title`, `post_content`, `post_excerpt`, `post_status`, `post_type`, `post_modified_gmt`, `permalink`, `row_token`.
- `check_read` (pack tool, op `page`): goes on only for `success: true`, the run's post id, a post or a page, status `publish` or `draft` (the two the site writes), a change time and a row token of the site's form. Else `post_read_unavailable`.
- `compose_change` is the only model step. It declares `metadata.cinatra.tools: []` and no toolbox, so the host serves it no tool. It answers `pageForm.writeFields`: the complete new `title`, `content` and `excerpt`, each a text or null. Null means "no change to this field"; the empty text means "set this field to empty" and is allowed for the title only (it clears the title). An empty content or excerpt is refused (`page_form_unavailable`): this agent never empties them.
- `form_page`, `file_page`, `gather_page_review`, `page_review_gate` and `read_reviewed_page` file the proposal as a page snapshot, have a person review it and read back the approved revision; see "What the review shows". `read_reviewed_page` answers `reviewedTitle`, `reviewedTitleSet` (true when the review saves the title, also as the empty text), `reviewedContent`, `reviewedExcerpt` (empty when not saved), `reviewedRevisionId` and `reviewedSnapshot` (that revision as a one-item list).
- `write_page` is the one publishing step (`publishes: true`, top-level, no model). See "The write".
- `write_outcome` (pack tool, op `outcome`) reads the site's answer and answers `next` and the run's output. `route_write` branches on `next`: `written`, each refusal code and `write_outcome_unknown` end the run; `post_changed` goes back to `read_page`.

**`post_changed`.** The site refused the save because the post changed after the read (another save, also in the same second or of another column such as the slug). Nothing was written. The run goes back to the read: the post is read again, the model proposes the change again against the current post, a new snapshot is filed and the person reviews it; the review shows `reviewNotice` ("Nothing was written: the post changed on the site after it was read (changed: content). The change was proposed again against the current post; review it again."). The write then needs a new release on the publish card. Each turn of this loop waits for a person, so it cannot run on alone.

## The write

`write_page` makes one call of `wordpress_site_tool_write` with `toolName: "cinatra/post-update-if-unchanged"` and `argsJson` rendered from a template over its own inputs:

```
{"post_id": <postId>, "if_unmodified_since": <modified>,
 "expected": {"title": <title>, "content": <content>, "excerpt": <excerpt>, "status": <status>, "row_token": <rowToken>}
 [, "title": <reviewedTitle> when the review saves the title, also as the empty text] [, "content": <reviewedContent>] [, "excerpt": <reviewedExcerpt>] [, "status": "draft" when status is publish]}
```

Each value is written with `tojson`; no value is put into the JSON text by hand. Each input has exactly one data edge: `postId`, `modified`, `title`, `content`, `excerpt`, `status` and `rowToken` from `read_page` (the site's answer, byte for byte), the reviewed values and the revision from `read_reviewed_page`, `instanceId` from `check_input`. `postId` is the read's own answer: `check_read` refuses a read whose `post_id` is not the checked id, and the write runs only after that check passed on the same read. No value of the model step reaches the write. A field the review does not save is absent from the request; a title the review clears is sent as the empty text (`reviewedTitleSet`), and the site accepts it unless the post would then be empty (`empty_content`). A published post is moved to draft in the same save, so the live page goes offline until a person publishes it; the previous revision stays in WordPress's revision history.

**Size of the write.** The connector takes an `argsJson` of at most 256 KiB in UTF-8 (`SITE_TOOL_ARGS_JSON_MAX_BYTES`), and this text carries the values as read and the reviewed values, so a content can be in it twice. `form_page` measures the exact text the write will send before anything is filed for review, and `read_reviewed_page` measures it again for the approved revision; a longer one is refused with a plain reason (`page_form_unavailable` or `reviewed_change_unavailable`), and nothing is written. The measure renders that text with `tojsonText` (`reviewed_change`), the runtime's `tojson`: Python's `json.dumps` with keys unsorted, separators `", "` and `": "` and ASCII output, then `< > & '` as `\u` escapes. A test requires the tool's text to equal the rendered `write_page` template byte for byte. The read's argument is a few bytes and is not measured.

The site compares, under a row lock, the change time, the four values and the row token with the stored post, and writes only when all are equal (see the plugin's documentation, "Content abilities"). There is no re-read before the write and no window between a check and an unconditional update.

**The publish card** shows four rows: the site (`instanceId`), the title as read, the status as read (its label states that a published post becomes a draft), and the reviewed page snapshot revision (`reviewedSnapshot`, an artifacts row: the changed blocks).

## What the review shows

`compose_change` answers the values to save in `pageForm.writeFields`. `form_page` calls the pack's `reviewed_change` tool (op `form`). It sets each value that equals the post as read to null (not saved; a title cleared on a post that has a title is not equal to it and stays the empty text), so the filed values, the shown excerpts and the saved values name the same fields. It derives the excerpts the review shows from those values and the post as read, by code: each value is split into its top-level blocks (an element with its content, a comment, or a run of text), the blocks of the post as read and of the value are compared, and every block that differs is shown with its source text on both sides, markup and link targets included. The blocks it does not show are byte for byte the post as read. The tool refuses (`page_form_unavailable`) when the values differ from the post only in white space, touch more than 200 blocks, or are not texts or null; it bounds its work before it compares (a value of more than 2,000,000 characters, a content of more than 20,000 blocks, or a comparison table of more than 4,000,000 cells is refused).

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
