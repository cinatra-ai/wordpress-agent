# Coding Conventions

**Analysis Date:** 2026-06-09

## Overview

This is a content-only Cinatra extension repo — it ships no TypeScript `src/` tree. The
single non-trivial file is `extension-kind-gate.mjs`, a self-contained ESM Node script.
Conventions here are drawn from that file plus the `package.json`, `tsconfig.json`, and CI
workflow.

## Naming Patterns

**Files:**
- `extension-kind-gate.mjs` — kebab-case, `.mjs` extension signals native ESM
- `cinatra/oas.json` — lowercase sidecar directory `cinatra/`, manifest files in lowercase
- `skills/<slug>/SKILL.md` — SCREAMING_SNAKE for documentation artifacts inside skill directories
- `.github/workflows/ci.yml`, `release.yml` — lowercase kebab-case workflow files

**Functions:**
- camelCase for all exported and internal functions: `parseArgs`, `validateAgent`, `validateWorkflow`, `validateWorkflowPackageShape`, `validateBpmnSanity`, `findWorkflowSidecars`, `runGate`, `walkLlmStrings`, `scanOasString`, `wordBoundary`

**Variables:**
- camelCase local variables: `packageRoot`, `oasPath`, `allSidecars`, `bpmnPrefixes`
- SCREAMING_SNAKE_CASE for module-level constants: `LLM_VISIBLE_FIELDS`, `BANNED_PRIMITIVES`, `BANNED_TYPEHINTS`, `BPMN_MODEL_NS`, `WORKFLOW_PACKAGE_NAME_RE`, `PRIMITIVE_PATTERNS`, `OBJECTS_LIST_CRM_RE`

**Types/Regex:**
- Constants for compiled `RegExp` objects use SCREAMING_SNAKE_CASE with `_RE` suffix: `WORKFLOW_PACKAGE_NAME_RE`, `OBJECTS_LIST_CRM_RE`, `OBJECTS_LIST_CRM_RE`

## Module Format

- Native ESM (`"type": "module"` in `package.json`)
- Only Node built-ins imported: `node:fs`, `node:path` — zero third-party runtime dependencies
- Named exports + a guarded `main()` invocation for direct CLI use:
  ```js
  const invokedDirectly =
    process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
  if (invokedDirectly) { main(); }
  ```
  (`extension-kind-gate.mjs` lines 381–390)

## Function Design

**Size:** Functions are focused and single-concern. The largest (`validateBpmnSanity`) is ~80 lines and handles one document shape. Helpers are extracted when reused (`walkLlmStrings`, `scanOasString`, `wordBoundary`).

**Parameters:** Simple scalar or object params. No destructured defaults; explicit guards like `(pkg && pkg.cinatra) || {}`.

**Return Values:** Validation functions return `string[]` (list of error messages). Gate dispatch returns `{ kind, errors }`. Pure functions are clearly documented: `/** Pure: returns string[] errors. */`

**Pure function preference:** Validator functions (`validateAgent`, `validateWorkflowPackageShape`, `validateBpmnSanity`) take data as arguments and return results — no side effects. Only `runGate`, `findWorkflowSidecars`, and `validateWorkflow` perform I/O.

## Error Handling

**Patterns:**
- I/O wrapped in `try/catch`; errors normalised with `err instanceof Error ? err.message : String(err)` throughout
- Errors accumulated into a `string[]` array and returned — no exceptions thrown out of validators
- Early return on fatal conditions (e.g. unparseable JSON stops further scanning immediately)
- `process.exit(1)` only in `main()`, never inside library functions

**Example:**
```js
try {
  parsed = JSON.parse(readFileSync(oasPath, "utf8"));
} catch (err) {
  errors.push(`cinatra/oas.json failed to parse: ${err instanceof Error ? err.message : String(err)}`);
  return errors;
}
```
(`extension-kind-gate.mjs` lines 140–144)

## Comments

**Block comments:** Section headers use `// ----------` separator lines with a one-line description. Used to visually separate arg parsing, agent gate, workflow gate, and dispatch sections in `extension-kind-gate.mjs`.

**JSDoc:** Single-line `/** … */` on exported functions explaining purpose and purity contract. No full `@param`/`@returns` annotations.

**Inline:** Sparse but present for non-obvious logic (namespace prefix resolution, tag-balance walk rationale).

**Warnings in CI YAML:** CI steps carry multi-line `#` comment blocks explaining the rationale for skip conditions, with explicit references to the monorepo files being mirrored.

## TypeScript Config (`tsconfig.json`)

- `"strict": true` with `"noImplicitAny": false` — strict mode minus the implicit-any rule
- `"verbatimModuleSyntax": true` — requires `import type` for type-only imports
- `"isolatedModules": true` — safe for bundlers/transpilers
- `module: "ESNext"`, `moduleResolution: "bundler"` — modern ESM
- `rootDir: "src"`, `outDir: "dist"` — standard layout for any future TypeScript sources
- Config applies to `src/**/*.ts` and `src/**/*.tsx`; no `src/` currently exists

## Import Organization

No multi-import files to establish strict ordering. `extension-kind-gate.mjs` groups all imports at the top:
1. Node built-ins with `node:` prefix: `node:fs`, `node:path`

## Linting/Formatting

Not detected — no `.eslintrc*`, `biome.json`, or `.prettierrc*` files present. Code style is
consistent (2-space indent, double-quotes for strings, trailing commas) suggesting informal
convention or editor defaults.

## Logging

- `console.log` for success output (single `✓` prefix line)
- `console.error` for failure output (`✗` prefix + bulleted list via `•` character)
- No structured logging library; output format is human-readable CI output

## Package Manifest Conventions (`package.json`)

- `"cinatra"` key declares extension metadata: `apiVersion`, `kind`, `dependencies`
- No `scripts` key — the repo has no build/test/typecheck scripts (content-only extension)
- No `dependencies` or `devDependencies` — intentional; first-party `@cinatra-ai/*` deps are
  `peerDependencies` with `peerDependenciesMeta.optional: true` when present

---

*Convention analysis: 2026-06-09*
