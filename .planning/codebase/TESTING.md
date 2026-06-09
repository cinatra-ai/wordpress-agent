# Testing Patterns

**Analysis Date:** 2026-06-09

## Test Framework

**Runner:** Not detected — no `jest.config.*`, `vitest.config.*`, or test runner in `package.json`.

**Assertion Library:** Not detected.

**Run Commands:**
```bash
# No test script present in package.json.
# CI step runs: corepack pnpm test --if-present
# --if-present means the step exits 0 silently when no test script is defined.
```

## Test File Organization

No test files exist in this repository. The repo is a content-only Cinatra extension — it
ships `cinatra/oas.json` (agent OAS surface), `skills/wordpress-agent/SKILL.md`, and the
self-contained gate script `extension-kind-gate.mjs`. No `src/` TypeScript tree exists.

## What Is Validated (CI Equivalent of Tests)

The repo relies on two CI jobs in lieu of a traditional test suite:

### `build` job (`.github/workflows/ci.yml`)

1. **Dependency shape check** — inline Node script verifies no `@cinatra-ai/*` packages
   leaked into `dependencies`/`devDependencies`, and that first-party peers declare
   `peerDependenciesMeta.optional: true`.
2. **Typecheck** — skipped for this repo (classified as a source mirror with host-internal
   peers). The monorepo runs typecheck for its compiled TypeScript sources.
3. **Test** — `corepack pnpm test --if-present` exits 0 (no `test` script defined).
4. **Pack dry-run** — `npm pack --dry-run` validates the publish payload shape.

### `kind-gates` job (`.github/workflows/ci.yml`)

- Runs `node extension-kind-gate.mjs --package-root .`
- For `kind: "agent"`: parses `cinatra/oas.json` and scans all LLM-visible fields
  (`system`, `user`, `description`) for retired CRM primitives and banned typehints.
- Exits 1 if any violation is found, 0 on pass.

### `release` job (`.github/workflows/release.yml`)

- Delegates to `cinatra-ai/.github/.github/workflows/reusable-extension-release.yml@main`
- Not a testing stage; handles marketplace submission.

## `extension-kind-gate.mjs` — Internal Structure

The gate exports pure validator functions that are testable in isolation:

| Export | Input | Output | What it checks |
|--------|-------|--------|----------------|
| `parseArgs(argv)` | `string[]` | `{ packageRoot }` | CLI arg parsing |
| `validateAgent(packageRoot)` | directory path | `string[]` errors | OAS banned-primitives scan |
| `validateWorkflowPackageShape(pkg)` | parsed `package.json` | `string[]` errors | workflow package.json shape |
| `validateBpmnSanity(xml)` | XML string | `string[]` errors | BPMN well-formedness + shape |
| `findWorkflowSidecars(packageRoot)` | directory path | `string[]` paths | BPMN sidecar discovery |
| `validateWorkflow(packageRoot)` | directory path | `string[]` errors | full workflow extension check |
| `runGate(packageRoot)` | directory path | `{ kind, errors }` | dispatches by `cinatra.kind` |

These exports are designed for unit testing (pure in/out, no global state) but no test suite
exists in this repo. Unit tests for the gate live in the cinatra monorepo, which owns the
authoritative `scripts/audit/oas-banned-primitives-gate.mjs` that this file mirrors.

## Coverage

**Requirements:** None enforced — no coverage configuration present.

## Mocking

Not applicable — no test framework present.

## Fixtures and Factories

Not applicable — no test files present.

## Test Types

**Unit Tests:** Not present in this repo.

**Integration Tests:** Not present in this repo.

**E2E Tests:** Not present in this repo.

## Adding Tests (Guidance)

If tests are added to this repo in future:

- The gate script exports pure functions from `extension-kind-gate.mjs` — unit tests should
  import named exports directly (e.g. `import { validateBpmnSanity } from "./extension-kind-gate.mjs"`)
- Use a framework compatible with native ESM (Vitest preferred; Jest requires `--experimental-vm-modules`)
- Add `"test": "vitest run"` (or equivalent) to `package.json` `scripts`
- Test files should follow `*.test.mjs` or `*.test.ts` naming alongside the source
- The CI `Test` step already calls `pnpm test --if-present` — adding a `test` script is
  sufficient for CI pickup without workflow changes

---

*Testing analysis: 2026-06-09*
