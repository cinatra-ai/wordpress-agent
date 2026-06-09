# Codebase Concerns

**Analysis Date:** 2026-06-09

## Tech Debt

**No `src/` directory — content-only extension with no TypeScript source:**
- Issue: `tsconfig.json` declares `"rootDir": "src"` and `"include": ["src/**/*.ts", "src/**/*.tsx"]` but no `src/` directory exists. The tsconfig is a vestige from extraction scaffolding that was never populated. CI correctly detects no tracked `.ts` files and skips typecheck, but the orphan tsconfig creates confusion about whether this is a code-bearing or content-only extension.
- Files: `tsconfig.json`
- Impact: Any future contributor adding TypeScript to `src/` will find a tsconfig already present but misconfigured for the empty state; the `outDir: dist` / `declarationMap: true` / `sourceMap: true` options imply a build step that does not exist.
- Fix approach: Either remove `tsconfig.json` entirely (this is a content-only agent) or add a `# content-only` comment to the tsconfig and a `package.json` `scripts.typecheck` that exits 0 immediately so CI path is explicit rather than inferred from the git-ls-files heuristic.

**Hardcoded model reference in `cinatra/oas.json`:**
- Issue: The `edit` ApiNode in `cinatra/oas.json` (line 249) hard-codes `"preferredModel": "gpt-5.5"`. This couples the agent's LLM routing to a specific model identifier. If the model is deprecated or renamed at the provider the agent silently falls back to whatever default the llm-bridge resolves, with no CI gate catching the stale name.
- Files: `cinatra/oas.json`
- Impact: Silent routing failures or unexpected model substitution. No test validates the model actually resolves.
- Fix approach: Reference a versioned model alias defined at the platform level rather than a concrete model string, or add the model name to the `BANNED_PRIMITIVES`-style scan in `extension-kind-gate.mjs` so stale model names are caught in CI.

**`wordpress_post_update_meta` marked legacy but still listed as a supported primitive:**
- Issue: `AGENTS.md` documents `wordpress_post_update_meta` as "legacy; use `wordpress_post_update` for new work" but the primitive remains in the official MCP primitive table without a deprecation signal in `cinatra/oas.json`.
- Files: `AGENTS.md`
- Impact: LLM may choose `wordpress_post_update_meta` over the preferred `wordpress_post_update` path, defeating the intention. No enforcement mechanism exists.
- Fix approach: Remove `wordpress_post_update_meta` from the SKILL.md primitive table or add a `BANNED_PRIMITIVES` entry in `extension-kind-gate.mjs` that fails if `wordpress_post_update_meta` appears in LLM-visible OAS strings.

**No lockfile committed:**
- Issue: `package.json` declares no runtime dependencies, and CI installs with `--no-frozen-lockfile` because no `pnpm-lock.yaml` is committed. For a content-only extension this is low risk today, but `extension-kind-gate.mjs` has no dependencies listed yet is a shipped script.
- Files: `package.json`, `.github/workflows/ci.yml` (line 81)
- Impact: If future dependencies are added they will resolve to unpinned latest versions on each CI run.
- Fix approach: Commit a `pnpm-lock.yaml` once any non-zero dependency is introduced.

**`.npmrc` contains registry configuration that may embed a credential token:**
- Issue: `.npmrc` is committed (25 bytes, last modified Jun 8). Its contents were not read (forbidden-file rule), but `.npmrc` files frequently contain `//registry.npmjs.org/:_authToken=` or `//registry.cinatra.ai/:_authToken=` entries. A committed `.npmrc` with an auth token is a secret-leak vector.
- Files: `.npmrc`
- Impact: Token exposure in the public OSS-extracted repo.
- Fix approach: Verify `.npmrc` contains ONLY a `@cinatra-ai:registry=` registry-pointer line (no token). Auth tokens must be injected via `NODE_AUTH_TOKEN` in CI environment, not committed to the file.

## Known Bugs

**Demote-then-edit has no rollback on edit failure:**
- Symptoms: If step 2 (`wordpress_post_update(status: "draft")`) succeeds but step 3 (the field-update call) fails, the post is left permanently demoted to draft with no automatic promotion back to `publish`.
- Files: `AGENTS.md` (draft-revision workflow section), `skills/wordpress-agent/SKILL.md`
- Trigger: Any MCP transport error, timeout, or malformed field value on the second `wordpress_post_update` call after a successful demote.
- Workaround: Manual re-publish by a site admin. No automated recovery or compensating transaction is defined.

**`postId` type coercion not surfaced in OAS inputs:**
- Symptoms: `cinatra/oas.json` declares `postId` as `type: string` with no format constraint. AGENTS.md notes the MCP primitives use `z.coerce.number().int().positive()` to convert it. A caller passing a non-numeric string (e.g. `"latest"`) will produce a runtime coercion error inside the MCP layer, not a validation error at the OAS boundary.
- Files: `cinatra/oas.json` (inputs array), `AGENTS.md`
- Trigger: Caller passes a non-numeric postId string.
- Workaround: None — the error surfaces deep in the MCP layer.

**`emit_output` node message template uses `changes | tojson` but `changes` is typed as `array` with untyped items:**
- Symptoms: `cinatra/oas.json` line 317 renders `{{ changes | tojson }}` in the output message template. If the `edit` ApiNode returns a `changes` value that is already a JSON string rather than an array object, double-serialization produces `"[{\"field\":...}]"` (a JSON string) instead of `[{"field":...}]` (an array), corrupting the A2A output contract.
- Files: `cinatra/oas.json` (`emit_output` node, line 317)
- Trigger: LLM returns changes as a pre-serialized JSON string inside its response body.

## Security Considerations

**`requiresApproval: false` on a write-class operation:**
- Risk: The `edit` ApiNode in `cinatra/oas.json` is declared `riskClass: "write"` but `requiresApproval: false`. This means the agent can demote a live published WordPress post to draft and modify its content without any human-in-the-loop approval gate.
- Files: `cinatra/oas.json` (metadata block, line 291-296)
- Current mitigation: None at the agent level; approval must be enforced by the calling workflow.
- Recommendations: Consider changing `requiresApproval: true` for `postStatus === "publish"` flows, or document clearly in SKILL.md that the calling workflow is expected to provide approval gating before invoking this agent on published content.

**`.npmrc` committed to the repository:**
- Risk: If the file contains a registry auth token it is publicly readable in the OSS-extracted repo.
- Files: `.npmrc`
- Current mitigation: Unknown — file contents not read per security policy.
- Recommendations: Audit `.npmrc` to confirm it contains only `@cinatra-ai:registry=https://...` with no token value. Rotate any token found there.

**No input sanitization on `instructions` field:**
- Risk: The `instructions` field is interpolated directly into the `user` prompt template in `cinatra/oas.json` (line 246) via `{{ instructions }}`. A malicious caller could inject prompt content that overrides the system prompt or exfiltrates post content.
- Files: `cinatra/oas.json` (edit node `user` field)
- Current mitigation: Relies on the llm-bridge layer's prompt handling; no explicit sanitization at the OAS level.
- Recommendations: Document that `instructions` is caller-controlled and must be treated as untrusted; add server-side length/character limits at the llm-bridge level.

## Performance Bottlenecks

**Sequential demote + edit calls with no batching:**
- Problem: The demote-then-edit workflow always executes two sequential WordPress REST calls before any content change lands. For high-latency WordPress instances (remote/slow hosting) this adds measurable round-trip overhead before the actual edit.
- Files: `AGENTS.md`, `skills/wordpress-agent/SKILL.md`
- Cause: WordPress REST API design requires separate status-update and field-update calls; no native "edit-in-draft-atomically" endpoint exists.
- Improvement path: If the post is already in `draft` status, skip the demote call. SKILL.md step 1 reads `postStatus` from the caller input, so the agent can branch on it before calling `wordpress_post_get`. Currently the full 4-step flow runs regardless.

**5-minute MCP timeout with no partial-progress signaling:**
- Problem: `wordpress_content_editor_run` uses `timeoutMs: 300_000`. If the LLM takes 4 minutes and the edit fails, the caller receives no feedback until the full timeout expires.
- Files: `AGENTS.md` (Timeout section)
- Cause: Blocking A2A dispatch; no streaming partial result.
- Improvement path: Route through the SSE gateway (`/api/agents/wordpress-content-editor/stream`) which supports streaming, rather than the blocking MCP primitive, for long-running edits.

## Fragile Areas

**SKILL.md prompt instructions as the sole behavioral contract:**
- Files: `skills/wordpress-agent/SKILL.md`
- Why fragile: The entire demote-then-edit sequence, output JSON schema, and forbidden-primitive list are enforced only through LLM-visible natural language in SKILL.md. There is no programmatic validation of the LLM's output structure before it is emitted as the A2A result. An LLM model update or prompt drift can silently break the contract.
- Safe modification: Any change to the output JSON shape in SKILL.md must also update `cinatra/oas.json` outputs and the `emit_output` message template simultaneously. These three locations are not programmatically linked.
- Test coverage: No automated tests validate the prompt → output contract end-to-end.

**`emit_output` node is a data-flow passthrough that duplicates the `end` node wiring:**
- Files: `cinatra/oas.json` (data_flow_connections, lines 192-208)
- Why fragile: Both `edit_to_end_postId`/`edit_to_end_changes` and `edit_to_emit_output_postId`/`edit_to_emit_output_changes` edges carry the same data. If the `edit` node output field names are ever renamed, four data-flow edges must be updated rather than two.
- Safe modification: Treat `emit_output` and `end` as separate concerns; update all four edges when renaming `edit` outputs.

**`extension-kind-gate.mjs` BPMN validator is not applicable to this agent but ships in the repo:**
- Files: `extension-kind-gate.mjs` (lines 162-346)
- Why fragile: The workflow-gate code path (`validateWorkflow`, `validateBpmnSanity`, `validateWorkflowPackageShape`) is dead code for an `agent`-kind extension. It is present because `extension-kind-gate.mjs` is a shared file extracted verbatim. Dead code in a validation gate risks divergence from the monorepo's authoritative version if edited locally.
- Safe modification: Never edit `extension-kind-gate.mjs` directly in this repo — it must stay in sync with the extraction script's canonical version.

## Scaling Limits

**Single WordPress instance per agent invocation:**
- Current capacity: One `instanceId` per call; each invocation targets exactly one WordPress MCP server instance.
- Limit: No fan-out or batch-edit across multiple posts or instances in a single invocation.
- Scaling path: Caller must issue multiple parallel A2A dispatches for multi-post or multi-site scenarios; not a concern at the agent level but callers should be aware.

## Dependencies at Risk

**`package.json` declares no dependencies (zero dependency surface):**
- Risk: Positive from a supply-chain perspective. No third-party packages to audit.
- Impact: Not applicable.
- Migration plan: Not applicable.

**Reusable release workflow depends on `cinatra-ai/.github` central repo:**
- Risk: `release.yml` calls `cinatra-ai/.github/.github/workflows/reusable-extension-release.yml@main` pinned to `@main` (floating ref). A breaking change to the reusable workflow can silently break release for this repo.
- Files: `.github/workflows/release.yml` (line 29)
- Impact: Release pipeline failure with no local indication of the root cause.
- Migration plan: Pin to a SHA or a released tag of the reusable workflow rather than `@main`.

## Missing Critical Features

**No error output contract:**
- Problem: The A2A output contract (`AGENTS.md`) defines only the success case (`postId` + `changes`). There is no defined error envelope (e.g. `{ "error": "...", "postId": "42" }`) for partial failures (demote succeeded, edit failed) or full failures (post not found).
- Blocks: Callers cannot distinguish "agent returned empty changes" from "agent failed mid-edit and left the post in draft" without inspecting `task.history` raw content.

**No `instanceId` output in A2A response:**
- Problem: The A2A output contract returns `postId` and `changes` but omits `instanceId`. A caller managing multiple WordPress instances cannot correlate the response back to the originating instance without tracking it externally.
- Files: `cinatra/oas.json` (outputs), `AGENTS.md` (A2A output contract)

## Test Coverage Gaps

**No tests of any kind:**
- What's not tested: The entire agent — demote-then-edit flow, output JSON structure, forbidden-primitive enforcement at runtime, timeout behavior, error handling.
- Files: All — there is no `*.test.*` or `*.spec.*` file in the repository.
- Risk: Behavioral regressions in SKILL.md prompt changes, OAS template changes, or MCP primitive renames will not be caught before deployment.
- Priority: High — the demote step modifies live published content; a silent regression could unpublish production posts without applying the intended edit.

**`extension-kind-gate.mjs` functions are exportable but have no test suite:**
- What's not tested: `validateAgent`, `validateBpmnSanity`, `validateWorkflowPackageShape`, `parseArgs` are exported pure functions with no accompanying test file.
- Files: `extension-kind-gate.mjs`
- Risk: Edge cases in the BPMN XML parser (malformed namespace declarations, self-closing root elements, CDATA stripping) are untested. The regex-based tag-balance walk is non-trivial.
- Priority: Medium — the gate runs in CI, but failures here mean invalid extensions pass undetected.

---

*Concerns audit: 2026-06-09*
