# Technology Stack

**Analysis Date:** 2026-06-09

## Languages

**Primary:**
- JavaScript (ESM) — runtime gate script (`extension-kind-gate.mjs`)
- JSON — agent flow spec (`cinatra/oas.json`)

**Secondary:**
- TypeScript (ES2023 target) — `tsconfig.json` declares config for `src/` (no TypeScript source files currently exist; config is pre-provisioned for future additions)

## Runtime

**Environment:**
- Node.js 24 (per `.github/workflows/ci.yml` `node-version: "24"`)

**Package Manager:**
- pnpm via corepack (`corepack enable` + `corepack pnpm`)
- Lockfile: not committed (CI uses `--no-frozen-lockfile`)

## Frameworks

**Core:**
- Cinatra Agent Flow (agentspec 26.1.0) — declarative JSON flow definition in `cinatra/oas.json`; component types: StartNode, ApiNode, OutputMessageNode, EndNode

**Testing:**
- Not configured — no test script in `package.json`, no test framework installed

**Build/Dev:**
- No build step — content-only agent extension (no TypeScript sources to compile today)
- `extension-kind-gate.mjs` — self-contained zero-dependency CI validation gate (plain Node builtins only)

## Key Dependencies

**Critical:**
- None declared in `package.json` `dependencies` or `devDependencies` — this is a source-mirror extension; host-internal `@cinatra-ai/*` packages are provided by the Cinatra monorepo workspace, not installed standalone

**Infrastructure:**
- `@cinatra-ai/wordpress-agent` v0.1.0 — the package identity itself (`package.json`)
- `cinatra-ai/.github` reusable workflow — `reusable-extension-release.yml@main` called by `.github/workflows/release.yml`

## Configuration

**Environment:**
- No `.env` file present
- LLM call target uses `{{CINATRA_BASE_URL}}` template variable resolved at runtime by the Cinatra platform (`cinatra/oas.json` `url` field)
- `CINATRA_MARKETPLACE_VENDOR_TOKEN` org secret required for release publishing (consumed by reusable workflow)

**Build:**
- `tsconfig.json` — ES2023 target, ESNext modules, bundler resolution, `src/**/*.ts` input, `dist/` output, strict mode with `noImplicitAny: false`
- `.npmrc` — `auto-install-peers=false`

## Platform Requirements

**Development:**
- Node.js 24+, corepack/pnpm
- This is a source-mirror repo; full typecheck and tests run only inside the Cinatra monorepo where `@cinatra-ai/*` peers resolve

**Production:**
- Cinatra Marketplace (`registry.cinatra.ai`) — published via GitHub Release tag matching `v<version>`
- Release submission flow: `extension-submit-for-review` → marketplace approval saga (no direct Verdaccio publish)
- Provenance attestation via GitHub OIDC (`id-token: write`, `attestations: write`)

---

*Stack analysis: 2026-06-09*
