# wordpress-agent — AGENTS.md

Agent-specific guidance for `@cinatra/wordpress-agent`. Read alongside the repo-root `AGENTS.md` and the skill file at `skills/wordpress-agent/SKILL.md`.

## Agent role

A WayFlow `node`-type leaf agent. Receives natural language editing instructions and a WordPress post context, applies changes via `wordpress_*` MCP primitives, and returns a structured diff. Invoked via A2A blocking dispatch from `/api/agents/wordpress-content-editor/stream` (unified SSE gateway) or from `wordpress_content_editor_run` in Cinatra `/chat`.

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

All fields are strings. `postId` is a string representation of a numeric ID (the WordPress REST primitives use `z.coerce.number().int().positive()` to convert it). The agent reads these from the most recent user message in conversation history.

## A2A output contract

```json
{
  "postId": "42",
  "instanceId": "wp-prod",
  "changes": [
    { "field": "title", "before": "Old headline", "after": "New headline" },
    { "field": "content", "before": "Old paragraph...", "after": "Fixed paragraph..." }
  ]
}
```

The caller reads this from `task.history` (not `task.artifacts`) — WayFlow's `task.artifacts` is not implemented.

## Draft-revision workflow — CRITICAL asymmetry with Drupal

WordPress lacks a true draft-revision API. The SKILL.md enforces a **demote-then-edit** pattern:

1. `wordpress_post_get` → read current content (including `content` field — required for before/after diff)
2. If `postStatus === "publish"` → `wordpress_post_update(status: "draft")` — demotes the live post (the live revision is preserved in WordPress's revision history, but the front-of-site copy becomes a draft)
3. `wordpress_post_update` → apply field changes
4. Return diff JSON

**Do NOT add a `wordpress_post_create_draft_revision` primitive.** There is no WordPress REST API equivalent to Drupal's draft revision endpoint. The agent's SKILL.md explicitly forbids calling `wordpress_post_create_draft_revision` to prevent the LLM from attempting to call a non-existent primitive.

## MCP primitives used

| Primitive | Purpose |
|---|---|
| `wordpress_post_get` | Read current post including `content` field (required for diff) |
| `wordpress_post_update` | Update top-level fields (`title`, `content`, `excerpt`, `status`, `meta`) |
| `wordpress_post_update_meta` | Update only `meta` (legacy; use `wordpress_post_update` for new work) |
| `wordpress_post_status` | Check publish status / get admin URL |

`wordpress_post_create_draft` is forbidden by SKILL.md — never call it. Creating new posts is outside the scope of this agent.

## Timeout

The `wordpress_content_editor_run` MCP primitive uses `timeoutMs: 300_000` (5 minutes). The unified SSE gateway (`/api/agents/[agentSlug]/stream`) uses `timeoutMs: 600_000` at the A2A level. Do not reduce these without testing a full read → demote → update cycle.

## Local dev URL

Default WayFlow agent URL: `http://localhost:3021`. Start with:

```bash
docker compose --profile wordpress up -d
```

Override via `WP_CONTENT_EDITOR_A2A_URL` in `.env.local` (e.g. `http://wayflow-wordpress-content-editor:3021` when Cinatra itself runs inside Docker).
