# wordpress-agent — AGENTS.md

Agent-specific guidance for `@cinatra/wordpress-agent`. Read alongside the repo-root `AGENTS.md` and the agent instructions in `cinatra/oas.json` (the `edit` node's `data.system`).

## KNOWN GAP — do not merge/deploy this cutover until ALL THREE close (cinatra-ai/cinatra#2022, #2043)

This repo's manifest/prompt now target the generic connector-instance invoker (`wordpress_site_tool_call`) instead of the named `wordpress_post_get`/`wordpress_post_update` tools. Three things must be true before this actually ships to real traffic, not just "code exists":

1. **wordpress-mcp-connector's transport retarget merges and soaks first.** This agent's prompt assumes `ewpa/get-post` / `ewpa/get-page` / `ewpa/update-post` exist and behave as wordpress-mcp-connector's own retarget PR documents (branch `feat/2022-s7-tau-review-gate`) — if that approach changes before it merges, this prompt needs a matching follow-up.
2. **The review-before-publish gate (`evaluateStagedContentWrite`, cinatra#2043) must be reachable from this agent's new call path — it is NOT, yet.** Today that gate is wired INLINE inside wordpress-mcp-connector's `wordpress_post_update` handler, which is the exact handler this agent is being moved OFF of. wordpress-mcp-connector's transport-retarget PR explicitly does not migrate the gate onto the generic invoker's shared review-hook slot — it's a disclosed, deferred follow-up (binding a WordPress-specific hook into cinatra core's `register-host-connector-services.ts`, alongside where the existing destructive-confirmation hook is bound today, since a connector-only package cannot make that host-side edit). Until that binding lands AND is verified to fire for a write reaching WordPress through `wordpress_site_tool_call` (not just through the old named tool), deploying this agent's rewrite lets it apply real content writes with **no review-before-publish enforcement at all** — a silent regression, not a cosmetic one. Confirm that binding is live and tested before merging/cutting this agent over.
3. **cinatra core's in-admin CMS tool allowlist must admit the generic primitives — it does NOT, yet.** This agent's runs are classified host-side as in-admin CMS content-editor dispatches, and the hosted-MCP relay only advertises/permits tools named in `IN_ADMIN_CMS_MCP_ALLOWED_TOOLS` (`packages/mcp-server/src/in-admin-cms-tool-policy.ts` in the cinatra monorepo) — which today lists `wordpress_post_get`/`wordpress_post_update`, not `wordpress_site_tool_call`. Declaring a primitive in this repo's `consumes[]` is an install-time dependency check only; it grants nothing at runtime. Until the cinatra-core allowlist swaps in `wordpress_site_tool_call` (planned to land together with the facade-deletion PR and this cutover, per the program's design), every call this agent's rewritten prompt makes is rejected by the relay with a structured denial — the agent simply cannot work. A connector/agent-repo PR structurally cannot make that edit; it must ship as its own cinatra-core change.

## Agent role

A WayFlow `node`-type leaf agent. Receives natural language editing instructions and a WordPress post context, applies changes through the site's own MCP ability catalog via the governed connector-instance invoker (`wordpress_site_tool_call`, cinatra-ai/cinatra#2022 S7), and returns a structured diff. Invoked via A2A blocking dispatch from `/api/agents/wordpress-content-editor/stream` (unified SSE gateway) or from `wordpress_content_editor_run` in Cinatra `/chat`.

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

Emitted when `postType` is neither unset/`"post"` nor `"page"` (code `unsupported_post_type`, no WordPress call made at all) or when an edit is requested for a page (code `page_editing_unsupported` — the read still happens for reference, the write is refused; see "MCP primitives used").

The caller reads this from `task.history` (not `task.artifacts`) — WayFlow's `task.artifacts` is not implemented.

## Draft-revision workflow — CRITICAL asymmetry with Drupal

WordPress lacks a true draft-revision API. The agent prompt enforces a **demote-then-edit** pattern:

1. `ewpa/get-post` (or `ewpa/get-page`) → read current content (including `content` field — required for before/after diff)
2. `ewpa/update-post` with the edits AND `status: "draft"` in the SAME call when `postStatus === "publish"` — demotes the live post (the live revision is preserved in WordPress's revision history, but the front-of-site copy becomes a draft)
3. `ewpa/get-post` again (independent re-read — the update ability's own response is not trusted for after-values, see below)
4. Return diff JSON

**Do NOT add a "create draft revision" call.** There is no WordPress ability equivalent to Drupal's draft revision endpoint, and the agent must never call `ewpa/create-post` for this — that ability creates a NEW, unrelated post. The agent prompt explicitly forbids it, to prevent the LLM from attempting to fabricate a revision that doesn't exist.

## MCP primitives used (cinatra-ai/cinatra#2022 S7 — generic invoker cutover)

This agent has exactly ONE WordPress MCP primitive: `wordpress_site_tool_call` (plus `wordpress_site_tools_list`, declared optional, unused by the current flow). There are no `wordpress_post_*` named tools anymore — every WordPress call goes through `wordpress_site_tool_call({ instanceId, toolName, args })`, which forwards `args` unmodified to the target site's own MCP ability and returns that ability's raw response (`{ success, data }`) unwrapped by nothing in between.

| `toolName` | Purpose |
|---|---|
| `ewpa/get-post` | Read a post by id (`args: { post_id }`) — required for before/after diffs |
| `ewpa/get-page` | Read a page by id (`args: { post_id }`) — used instead of `ewpa/get-post` only when `postType === "page"` |
| `ewpa/update-post` | Update a post's top-level fields (`args: { post_id, title?, content?, excerpt?, status? }`) — supports `postType === "post"` (default) ONLY; there is no proven page-update or meta-update ability behind this cutover (see below) |

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
