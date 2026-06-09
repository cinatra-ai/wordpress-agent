<!-- refreshed: 2026-06-09 -->
# Architecture

**Analysis Date:** 2026-06-09

## System Overview

```text
┌──────────────────────────────────────────────────────────────────┐
│                    Cinatra Platform (host)                        │
│  /api/agents/wordpress-content-editor/stream  (SSE gateway)      │
│  wordpress_content_editor_run  (MCP primitive in /chat)          │
└──────────────────┬───────────────────────────────────────────────┘
                   │  A2A blocking dispatch (JSON user message)
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│              WayFlow Flow  (cinatra/oas.json)                     │
│  start  →  edit (ApiNode)  →  emit_output  →  end                │
│  `cinatra/oas.json`                                               │
└──────────────────┬───────────────────────────────────────────────┘
                   │  POST {{CINATRA_BASE_URL}}/api/llm-bridge
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│              LLM Bridge  (OpenAI gpt-5.5 preferred)              │
│  Guided by SKILL.md system prompt                                 │
│  `skills/wordpress-agent/SKILL.md`                               │
└──────────────────┬───────────────────────────────────────────────┘
                   │  MCP tool calls
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│              WordPress MCP Server                                 │
│  wordpress_post_get / wordpress_post_update /                     │
│  wordpress_post_update_meta / wordpress_post_status              │
└──────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| OAS Flow spec | Declares the WayFlow graph: nodes, control-flow edges, data-flow edges, I/O contract | `cinatra/oas.json` |
| StartNode (`start`) | Receives and exposes the five A2A input fields | `cinatra/oas.json` (`$referenced_components.start`) |
| ApiNode (`edit`) | Calls `/api/llm-bridge` with a templated prompt; performs the actual LLM-driven post read/demote/edit cycle | `cinatra/oas.json` (`$referenced_components.edit`) |
| OutputMessageNode (`emit_output`) | Serialises `postId` + `changes` as a Jinja2-templated JSON agent message in task history | `cinatra/oas.json` (`$referenced_components.emit_output`) |
| EndNode (`end`) | Exposes `postId` + `changes` as structured outputs for downstream WayFlow nodes | `cinatra/oas.json` (`$referenced_components.end`) |
| SKILL.md | LLM behavioural ruleset injected as system context; enforces demote-then-edit pattern and forbidden primitives | `skills/wordpress-agent/SKILL.md` |
| AGENTS.md | Human + agent reference: role definition, I/O contracts, timeout values, local dev setup | `AGENTS.md` |
| extension-kind-gate | Zero-dependency CI gate: validates OAS parses and scans for retired primitives in prompt strings | `extension-kind-gate.mjs` |

## Pattern Overview

**Overall:** WayFlow declarative `node`-type leaf agent — a linear four-node flow that delegates all intelligence to an LLM bridge.

**Key Characteristics:**
- No runtime TypeScript source (this is a source-mirror extraction; the monorepo owns compilation). `tsconfig.json` targets a `src/` that does not yet exist in this repo.
- All agent logic is declared in `cinatra/oas.json` (agentspec v26.1.0). Behaviour is driven by the LLM via SKILL.md.
- A2A input/output contracts are JSON-stringified objects passed as user messages and read from `task.history`.

## Layers

**Flow Declaration Layer:**
- Purpose: Machine-readable graph definition consumed by the WayFlow runtime
- Location: `cinatra/oas.json`
- Contains: StartNode, ApiNode, OutputMessageNode, EndNode, control-flow edges, data-flow edges
- Depends on: WayFlow runtime, Cinatra LLM bridge (`{{CINATRA_BASE_URL}}/api/llm-bridge`)
- Used by: WayFlow engine, Cinatra marketplace at install/publish time

**Skill/Prompt Layer:**
- Purpose: LLM behavioural ruleset — enforces demote-then-edit pattern, allowed/forbidden primitives
- Location: `skills/wordpress-agent/SKILL.md`
- Contains: Step-by-step editing procedure, forbidden primitive list, diff output schema
- Depends on: Nothing (plain Markdown injected as system context)
- Used by: The `edit` ApiNode's system prompt

**CI / Validation Layer:**
- Purpose: Pre-publish sanity gate run unauthenticated in extracted-repo CI
- Location: `extension-kind-gate.mjs`
- Contains: OAS JSON parse check + banned-primitive scan against prompt strings
- Depends on: Node builtins only (zero external dependencies by design)
- Used by: `.github/workflows/ci.yml` (`kind-gates` job)

## Data Flow

### Primary Request Path

1. Caller sends A2A dispatch to `/api/agents/wordpress-content-editor/stream` or invokes `wordpress_content_editor_run` — JSON-stringified `{instanceId, postId, postType, postStatus, instructions}` arrives as a `user` message (`AGENTS.md`)
2. WayFlow `start` node exposes the five fields (`cinatra/oas.json` → `$referenced_components.start`)
3. Data-flow edges route all five fields to the `edit` ApiNode inputs (`cinatra/oas.json` → `data_flow_connections`)
4. `edit` POSTs to `{{CINATRA_BASE_URL}}/api/llm-bridge`; the LLM executes `wordpress_post_get` → optional `wordpress_post_update(status:"draft")` → `wordpress_post_update` and returns `{postId, changes[]}` (`cinatra/oas.json` → `$referenced_components.edit`)
5. `changes` + `postId` flow to both `emit_output` (written to `task.history` as a JSON message) and `end` (structured outputs) (`cinatra/oas.json` → `data_flow_connections`)
6. Caller reads result from `task.history` (not `task.artifacts` — WayFlow artifacts not implemented) (`AGENTS.md`)

### Demote-Then-Edit Sub-Flow (inside `edit` node)

1. `wordpress_post_get` — reads current content including `content` field (required for before/after diff)
2. If `postStatus === "publish"` → `wordpress_post_update(status: "draft")` — demotes live post
3. `wordpress_post_update` — applies field changes (`title`, `content`, `excerpt`, `status`, `meta`)
4. LLM returns `{postId, changes[{field, before, after}]}` as JSON

**State Management:**
- Stateless flow; no persistent state within the agent. WordPress itself holds post state.

## Key Abstractions

**WayFlow Flow (agentspec 26.1.0):**
- Purpose: Declarative directed graph of typed nodes connected by control-flow and data-flow edges
- Examples: `cinatra/oas.json`
- Pattern: `component_type` discriminated objects under `$referenced_components`; edges declared separately in `control_flow_connections` and `data_flow_connections`

**ApiNode (`edit`):**
- Purpose: Generic HTTP-call node; here used to invoke the Cinatra LLM bridge
- Template variables: `{{ instanceId }}`, `{{ postId }}`, `{{ postType }}`, `{{ postStatus }}`, `{{ instructions }}` interpolated into the `user` prompt string
- LLM preference: `preferredProvider: "openai"`, `preferredModel: "gpt-5.5"`

**SKILL.md behavioural contract:**
- Injected as the `system` message in the `edit` ApiNode
- Enforces forbidden primitives: `wordpress_post_create_draft_revision` and `wordpress_post_create_draft` must never be called
- Dictates exact step sequence and output JSON schema

## Entry Points

**A2A SSE gateway:**
- Location: `AGENTS.md` (documents URL `/api/agents/wordpress-content-editor/stream` in the host)
- Triggers: External callers dispatching to the agent slug
- Timeout: 600,000 ms

**MCP primitive:**
- Location: `AGENTS.md` (documents `wordpress_content_editor_run` in Cinatra `/chat`)
- Timeout: 300,000 ms

**Local dev:**
- Default URL: `http://localhost:3021`
- Start: `docker compose --profile wordpress up -d`
- Override: `WP_CONTENT_EDITOR_A2A_URL` in `.env.local`

## Architectural Constraints

- **No src/ at present:** `tsconfig.json` declares `rootDir: "src"` and `outDir: "dist"` but no `src/` directory exists — this is a source-mirror repo; TypeScript compilation is owned by the Cinatra monorepo.
- **Global state:** None. The flow is stateless; all state lives in WordPress.
- **Circular imports:** Not applicable (no runtime source).
- **Forbidden primitives:** `wordpress_post_create_draft_revision` and `wordpress_post_create_draft` — enforced by SKILL.md and independently audited by `extension-kind-gate.mjs` on every CI run.
- **Output channel:** Results go to `task.history`, not `task.artifacts` (`AGENTS.md`).
- **Optional peer deps:** `@cinatra-ai/*` packages are optional peer dependencies provided by the monorepo workspace; this repo is not standalone-installable.

## Anti-Patterns

### Calling wordpress_post_create_draft_revision

**What happens:** LLM attempts to create a proper draft revision before editing.
**Why it's wrong:** No such WordPress REST API endpoint exists; the call will fail at runtime.
**Do this instead:** Follow the demote-then-edit pattern: `wordpress_post_get` → `wordpress_post_update(status:"draft")` if published → `wordpress_post_update` with changes. Documented in `AGENTS.md` and enforced by `skills/wordpress-agent/SKILL.md`.

### Reading from task.artifacts

**What happens:** Caller reads the structured output from `task.artifacts`.
**Why it's wrong:** WayFlow `task.artifacts` is not implemented; the data will be absent.
**Do this instead:** Read from `task.history` — the `emit_output` OutputMessageNode writes the JSON result there (`AGENTS.md`).

## Error Handling

**Strategy:** Delegated to WayFlow runtime and the LLM bridge. No custom error handling is declared in the flow spec.

**Patterns:**
- Timeout failures surface as A2A errors after 300s (MCP) or 600s (SSE gateway)
- Demote step is a WordPress REST call — transient failures would leave the post in draft; callers should handle this case

## Cross-Cutting Concerns

**Logging:** Handled by WayFlow runtime; no agent-level logging declarations.
**Validation:** Input fields are untyped strings in the flow spec; `postId` is coerced to integer by the WordPress MCP primitives (`z.coerce.number().int().positive()`).
**Authentication:** WordPress instance identified by `instanceId`; authentication to the MCP server is managed by the Cinatra platform, not this agent.

---

*Architecture analysis: 2026-06-09*
