#!/usr/bin/env bash
set -euo pipefail

# Generate /opt/sruth/.env with strong random secrets and print them to stdout
# once so they can be copied to a password manager. Refuses to overwrite an
# existing .env — rotating secrets out from under a live DB would break auth
# silently. Run exactly once per VM lifecycle.

ENV_FILE=${ENV_FILE:-/opt/sruth/.env}

if [ -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE already exists. Move it aside before regenerating." >&2
  exit 1
fi

POSTGRES_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -hex 32)
INTERNAL_SECRET=$(openssl rand -hex 32)

umask 077
cat > "$ENV_FILE" <<EOF
# Generated $(date -u +%Y-%m-%dT%H:%M:%SZ) — do not commit.
POSTGRES_USER=sruth
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=sruth
DATABASE_URL=postgresql://sruth:${POSTGRES_PASSWORD}@postgres:5432/sruth
JWT_SECRET=${JWT_SECRET}
INTERNAL_SECRET=${INTERNAL_SECRET}
CORS_ORIGIN=https://sruth.live
# Parent domain for auth cookies so both sruth.live (middleware) and
# api.sruth.live (JWT verify) receive them.
COOKIE_DOMAIN=sruth.live
# Shown to users in the stream-setup UI as their OBS push target.
INGEST_URL_BASE=rtmp://sruth.live:1935/live
# Inlined into the web client bundle at build time — must be set before
# \`docker compose build\`. If you change this you must rebuild the web image.
NEXT_PUBLIC_API_URL=https://api.sruth.live
EOF

chmod 600 "$ENV_FILE"

cat <<NOTE

=== Generated secrets — save to your password manager now ===

POSTGRES_PASSWORD:
$POSTGRES_PASSWORD

JWT_SECRET:
$JWT_SECRET

INTERNAL_SECRET:
$INTERNAL_SECRET

Written to: $ENV_FILE (mode 600)

When done, clear scrollback: clear && printf '\\033[3J'
(or just close this SSH session)
===
NOTE
