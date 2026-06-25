# WordPress Agent

Edit a post on a connected WordPress site from a plain-language instruction — "tighten the intro", "swap the headline for X", "add a CTA at the end" — and get back a precise before-and-after diff of every field that changed. Works on both posts and pages, and preserves WordPress revision history when editing a published post.

**Purpose.** Bridges Cinatra's content-edit interface to the WordPress REST API: reads the current post, applies only the requested field changes, and returns a structured diff for UI diff highlights.

**Install.** Add `@cinatra-ai/wordpress-agent` from the Cinatra marketplace. The agent resolves the REST endpoint from the instance record — no extra server configuration is needed.

**Configuration.** Supply `instanceId` (your registered WordPress instance), `postId`, `postType` (`post` or `page`), `postStatus` (`publish` or `draft`), and a plain-language `instructions` string.

**Usage.** Trigger via the Cinatra content editor or the A2A API at `/api/agents/wordpress-content-editor/stream`. For a published post the agent demotes it to draft before applying changes (WordPress has no draft-revision API); for a draft it writes directly. Both paths return `changes`: `[{ "field": "title", "before": "...", "after": "..." }]`.

**Development.** Start the local stack with `docker compose --profile wordpress up -d`. Agent runs on port 3021 by default; override with `WP_CONTENT_EDITOR_A2A_URL` in `.env.local`.

**API contract.** Inputs: `instanceId`, `postId`, `postType`, `postStatus`, `instructions` (all strings). Output: `postId` and a `changes` array of `{field, before, after}` objects. A published-post edit also emits `{ "field": "status", "before": "publish", "after": "draft" }`.

**Troubleshooting.** A `500` on the edit step usually means `instanceId` does not match a registered WordPress connection — verify the connection in Cinatra workspace settings. An empty `changes` array means no fields were modified; check that `instructions` names a field that exists on the post.

## Works with

- WordPress

## Capabilities

- Edit a WordPress post or page from a natural-language instruction
- Return a precise before-and-after diff of every field that changed
- Preserve WordPress revision history when editing a published post
- Touch only the fields you asked to change — leave the rest untouched
