# WordPress Agent

Edit a post on a connected WordPress site from a plain-language instruction — "tighten the intro", "swap the headline" — and get back a precise before-and-after diff of every field that changed. Preserves revision history when editing a published post. Pages are read-only in this release.

**Purpose.** Bridges Cinatra's content-edit interface to the connected site's own MCP ability catalog through Cinatra's governed site-tool channel: reads the post, applies only the requested changes, returns a structured diff.

**Install.** Add `@cinatra-ai/wordpress-agent` from the Cinatra marketplace. The agent resolves the connected site from the instance record — no extra server configuration is needed.

**Configuration.** Supply `instanceId` (your registered WordPress instance), `postId`, `postType` (`post`, the default; `page` is read-only), `postStatus` (`publish` or `draft`), and a plain-language `instructions` string.

**Usage.** Trigger via the Cinatra content editor or the A2A API at `/api/agents/wordpress-content-editor/stream`. For a published post the agent demotes it to draft before applying changes; for a draft it writes directly. Both paths return `changes`: `[{ "field": "title", "before": "...", "after": "..." }]`.

**Development.** Start the local stack with `docker compose --profile wordpress up -d`. Runs on port 3021; override with `WP_CONTENT_EDITOR_A2A_URL` in `.env.local`.

**API contract.** Inputs: `instanceId`, `postId`, `postType`, `postStatus`, `instructions` (all strings). Output: `postId`, a `proposalId` correlation id, and a `changes` array of `{field, before, after}` objects; a published-post edit also emits a status change entry. An unsupported request (e.g. a page edit) returns empty `changes` plus an `error` object with a machine-readable `code`.

**Troubleshooting.** A `500` on the edit step usually means `instanceId` does not match a registered WordPress connection — verify it in workspace settings. Empty `changes` means no fields were modified; check that `instructions` names a field present on the post.

## Works with
- WordPress

## Capabilities
- Edit a WordPress post from a natural-language instruction
- Return a precise before-and-after diff of every field that changed
- Preserve WordPress revision history when editing a published post
- Touch only the fields you asked to change — leave the rest untouched
- Read a page for reference (`postType: "page"`) — page editing not yet supported
