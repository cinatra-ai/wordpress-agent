# WordPress Agent

Edit a post on a connected WordPress site from a plain-language instruction — "tighten the intro", "swap the headline" — and get back a precise before-and-after diff of every field that changed. Preserves revision history when editing a published post. Pages are read-only in this release.

**Purpose.** Bridges Cinatra's content-edit interface to the connected site's own MCP ability catalog through Cinatra's governed site-tool channel: reads the post, applies only the requested changes, returns a structured diff.

**Install.** Add `@cinatra-ai/wordpress-agent` from the Cinatra marketplace. The agent resolves the connected site from the instance record — no extra server configuration is needed.

**Configuration.** Supply `instanceId` (your registered WordPress instance), `postId`, `postType` (`post`, the default; `page` is read-only), `postStatus` (`publish` or `draft`), and a plain-language `instructions` string.

**Usage.** Trigger via the Cinatra content editor or the A2A API at `/api/agents/wordpress-content-editor/stream`. For a published post the agent demotes it to draft before applying changes; for a draft it writes directly.

**Development.** Start the local stack with `docker compose --profile wordpress up -d`. Runs on port 3021; override with `WP_CONTENT_EDITOR_A2A_URL` in `.env.local`.

**API contract.** Inputs: `instanceId`, `postId`, `postType`, `postStatus`, `instructions` (all strings). Success: `postId`, `instanceId`, `proposalId` (required), optional `changeSetId`, and `changes: [{field, before, after}]`; a demote also adds a status entry. Failure: empty `changes` plus `error.code` — `unsupported_post_type` / `page_editing_unsupported` / `call_failed` (no `proposalId`) or `reread_failed` (write saved, reread failed; `proposalId` included).

**Troubleshooting.** A `500` usually means `instanceId` doesn't match a registered connection — check workspace settings. Empty `changes` alone isn't proof of a no-op — check `error` first (absent = no matching field; present = failed, or for `reread_failed`, saved but unconfirmed).

## Works with
- WordPress

## Capabilities
- Edit a WordPress post from a natural-language instruction
- Return a precise before-and-after diff of every field that changed
- Preserve WordPress revision history when editing a published post
- Touch only the fields you asked to change — leave the rest untouched
- Read a page for reference (`postType: "page"`) — page editing not yet supported
