---
name: dep-check
description: Check all workspace packages for outdated dependencies, deprecation warnings, and version inconsistencies. Use when user wants to audit dependencies, check for updates, or verify a clean install.
---

# Dependency Health Check

Audit all workspace packages for outdated dependencies, deprecation warnings, and cross-package version inconsistencies.

## Steps

### 1. Discover all package.json files

Find every `package.json` in the monorepo (excluding `node_modules`). Read each one to build a picture of all dependencies and their version ranges.

### 2. Check for outdated packages

Run `pnpm outdated --recursive` to find packages where a newer version exists within or beyond the specified range.

### 3. Check for version inconsistencies

Compare the same dependency across different workspace packages. Flag cases where the version range differs (e.g., `vite: "^6.0.0"` in one package but `"^8.0.3"` in another). Shared devDependencies like `typescript`, `vitest`, `@types/node` should use the same range everywhere.

### 4. Clean install warning check

Run `pnpm install` and review the output for:
- **Deprecation warnings** (`WARN deprecated`) — packages that ship their own types or have been superseded
- **Peer dependency warnings** — mismatched or missing peer deps
- **Other warnings** — any `WARN` lines in the install output

### 5. Report findings

Present a summary table:

| Category | Package | Location | Issue | Suggested Fix |
|----------|---------|----------|-------|---------------|
| Outdated | vite | services/ingest | ^6.0.0 (latest 8.x) | Bump to ^8.0.3 |
| Inconsistent | typescript | root vs apps/api | ^5.0 vs ^6.0 | Align to ^6.0 |
| Deprecated | @types/foo | apps/api | ships own types | Remove |
| Warning | ... | ... | ... | ... |

If everything is clean, say so.

### 6. Fix (if requested)

If the user asks to fix issues:
- Edit the relevant `package.json` files
- Run `pnpm install` to update the lockfile
- Re-run `pnpm outdated --recursive` to confirm resolution
