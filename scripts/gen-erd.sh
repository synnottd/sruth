#!/usr/bin/env bash
# Regenerate docs/erd.md from the Prisma schema.
#
# The ERD generator is deliberately not declared in schema.prisma — its binary
# (prisma-erd-generator) is dev-only tooling and shouldn't be required during
# service Docker builds. Instead, this script builds a temporary schema that
# appends the generator block and runs `prisma generate` against it.
#
# Run locally after editing the Prisma schema, then commit the updated
# docs/erd.md alongside the schema change.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
SRC="$ROOT/packages/shared/prisma/schema.prisma"
OUT="$ROOT/docs/erd.md"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Strip the client generator — we only want the ERD generator to run against
# the tmp schema. Leaving `generator client` in would make Prisma try to
# resolve @prisma/client relative to the tmp directory and fail.
sed '/^generator client {/,/^}$/d' "$SRC" > "$TMP/schema.prisma"
cat >> "$TMP/schema.prisma" <<EOF

generator erd {
  provider     = "prisma-erd-generator"
  output       = "$OUT"
  theme        = "neutral"
  disableEmoji = true
}
EOF

cd "$ROOT/packages/shared"
pnpm exec prisma generate --schema "$TMP/schema.prisma"
