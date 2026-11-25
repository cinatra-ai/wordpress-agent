# WordPress Agent

Edit a post on a connected WordPress site from a plain-language instruction — "tighten the intro", "swap the headline" — and get back a precise before-and-after diff of every field that changed. Preserves revision history when editing a published post. Pages are read-only in this release.

**Purpose.** Bridges Cinatra's content editor to the site's MCP ability catalog through the governed site-tool channel: reads the post, applies only the requested changes, returns a diff.

**Install.** Add `@cinatra-ai/wordpress-agent` from the Cinatra marketplace; the site comes from the instance record.

**Configuration.** Supply `instanceId` (your registered WordPress instance), `postId`, `postType` (`post`, the default; `page` is read-only), `postStatus` (`publish` or `draft`), and a plain-language `instructions` string.

**Usage.** Trigger via the Cinatra content editor or the A2A API at `/api/agents/wordpress-content-editor/stream`. It saves only the approved snapshot's values (each change shown as source text), if the post did not change during review; a published post becomes a draft.

**Development.** Start the local stack with `docker compose --profile wordpress up -d`. Runs on port 3021; override with `WP_CONTENT_EDITOR_A2A_URL` in `.env.local`.

**API contract.** Inputs (strings): `instanceId`, `postId`, `postType`, `postStatus`, `instructions`. Success: `postId`, `instanceId`, `proposalId` (required), optional `changeSetId`, and `changes: [{field, before, after}]`; a demote also adds a status entry. Failure: empty `changes` plus `error.code` — `unsupported_post_type` / `page_editing_unsupported` / `call_failed` (failed), `post_changed` (nothing written), `page_form_unavailable` / `reviewed_change_unavailable` (failed, nothing written) or `reread_failed` (saved, reread failed; has `proposalId`).

**Troubleshooting.** A `500` usually means `instanceId` matches no registered connection. Empty `changes`, no `error`: no change was proposed; `message` repeats the request. Check `error` first (`reread_failed`: saved, unconfirmed).

## Works with
- WordPress

## Capabilities
- Edit a WordPress post from a natural-language instruction
- Return a precise before-and-after diff of every field that changed
- Preserve WordPress revision history when editing a published post
- Touch only the fields you asked to change — leave the rest untouched
- Read a page for reference (`postType: "page"`) — page editing not yet supported
