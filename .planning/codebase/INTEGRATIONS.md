# External Integrations

**Analysis Date:** 2026-06-09

## APIs & External Services

**Cinatra LLM Bridge:**
- Service: Cinatra platform LLM proxy (`{{CINATRA_BASE_URL}}/api/llm-bridge`)
  - Called by: `edit` ApiNode in `cinatra/oas.json`
  - HTTP method: POST
  - Auth: platform-managed (resolved via `CINATRA_BASE_URL` at runtime)
  - Payload fields: `system`, `user`, `agent_id`, `cinatra_llm`
  - Preferred LLM provider: `openai`, preferred model: `gpt-5.5`

**WordPress MCP Server:**
- Service: WordPress site accessed via the WordPress MCP server (described in `package.json` description and SKILL.md)
  - The agent instructs the LLM to use WordPress MCP tools (read/write posts) by passing `instanceId`, `postId`, `postType`, `postStatus`, and `instructions` through the LLM bridge
  - Connection details are not embedded in this repo — they are resolved at runtime by the Cinatra platform from the WordPress integration instance identified by `instanceId`

**Cinatra Marketplace:**
- Service: `registry.cinatra.ai`
  - Used for: publishing this extension on GitHub Release
  - Secret: `CINATRA_MARKETPLACE_VENDOR_TOKEN` (GitHub org secret)
  - Submission pipeline: `extension-submit-for-review` → approval saga → promotion
  - Reusable workflow: `cinatra-ai/.github/.github/workflows/reusable-extension-release.yml@main`

## Data Storage

**Databases:**
- Not applicable — this agent has no direct database connection; WordPress content is accessed through the WordPress MCP server via the platform

**File Storage:**
- Not applicable

**Caching:**
- None

## Authentication & Identity

**Auth Provider:**
- Platform-managed — all auth to WordPress is abstracted behind the Cinatra instance connection (`instanceId` input)
- LLM bridge auth is platform-internal (`CINATRA_BASE_URL`)
- Marketplace publish auth: `CINATRA_MARKETPLACE_VENDOR_TOKEN` GitHub org secret

## Monitoring & Observability

**Error Tracking:**
- Not detected — no error tracking SDK configured

**Logs:**
- CI gate logs to stdout/stderr via `console.log` / `console.error` in `extension-kind-gate.mjs`
- Runtime agent output is the structured JSON message emitted by `emit_output` OutputMessageNode: `{"postId":"...","changes":[...]}`

## CI/CD & Deployment

**Hosting:**
- Cinatra Marketplace (`registry.cinatra.ai`)

**CI Pipeline:**
- GitHub Actions — `.github/workflows/ci.yml` (triggered on push/PR to `main`)
  - Runs on `ubuntu-latest`, Node 24
  - Steps: checkout, setup-node, corepack enable, dependency-shape classification, install (skipped for source mirrors), typecheck (skipped for source mirrors), test (skipped for source mirrors), `npm pack --dry-run`, agent OAS validation gate (`node extension-kind-gate.mjs --package-root .`)
- GitHub Actions — `.github/workflows/release.yml` (triggered on GitHub Release published or `workflow_dispatch`)
  - Delegates entirely to `cinatra-ai/.github` reusable workflow

## Environment Configuration

**Required env vars / secrets:**
- `CINATRA_BASE_URL` — platform base URL; injected at agent runtime, not in this repo
- `CINATRA_MARKETPLACE_VENDOR_TOKEN` — GitHub org secret for marketplace publishing

**Secrets location:**
- GitHub org secrets (no `.env` file present in this repo)

## Webhooks & Callbacks

**Incoming:**
- None — this is a flow-based agent, not a webhook receiver

**Outgoing:**
- None explicit; the agent calls the Cinatra LLM bridge endpoint which in turn orchestrates WordPress MCP tool calls

---

*Integration audit: 2026-06-09*
