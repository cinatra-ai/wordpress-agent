# WordPress Agent

Edit a post or page on a connected WordPress site from a plain instruction — "tighten the intro", "swap the headline". A person reviews the proposed change; only the reviewed values are saved, and only if the page did not change on the site since it was read.

**Purpose.** Reads the post with the site's `cinatra/post-read` ability, has one model step propose the change, files it as a page snapshot for review, and saves it with `cinatra/post-update-if-unchanged`. No model takes part in the read or the save.

**Install.** Add `@cinatra-ai/wordpress-agent` from the marketplace; the site comes from the instance record. Needs the plugin's abilities (wordpress-plugin #120) and the host's guarded calls (cinatra #4788, #4796; wordpress-mcp-connector #121), all open.

**Configuration.** Supply `instanceId` (the site), `postId`, `postType` (a hint: `post`, `page` or empty), and a plain-language `instructions` string. `postStatus` is not used.

**Usage.** Trigger from the content editor or the A2A API: `/api/agents/wordpress-content-editor/stream`. Review the snapshot (each changed block as source text), then release the save on the publish card. A published post becomes a draft. If the page changed meanwhile, you review a new proposal.

**Development.** `docker compose --profile wordpress up -d`; port 3021 (override: `WP_CONTENT_EDITOR_A2A_URL`).

**API contract.** Inputs (strings): `instanceId`, `postId`, `postType`, `postStatus`, `instructions`. Success: `postId`, `instanceId`, `proposalId`, `changes: [{field, before, after}]` (after: the stored value; a demote adds status), `message`. Refused by the site: empty `changes`, `error.code` (the site's refusal code, e.g. `post_locked` or `empty_content`) and a plain `message`; nothing written. Failed runs: `run_input_invalid` (nothing read), `post_read_unavailable`, `page_form_unavailable` (also: change too large), `reviewed_change_unavailable`, `write_answer_unreadable` (check the post). Error `write_outcome_unknown`: the site may have changed; check the post (no retry).

**Troubleshooting.** A `500`: often an unknown `instanceId`. Empty `changes`, no `error`: no change was proposed.

## Works with
- WordPress

## Capabilities
- Edit a WordPress post or page from a natural-language instruction
- Show each proposed change for review before anything is saved
- Save only the reviewed values, only if the page is unchanged
- Preserve WordPress revision history when editing a published post
