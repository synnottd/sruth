#!/usr/bin/env bash
set -euo pipefail

echo "=== Sruth VM Provisioner ==="

# Install Docker if not present
if ! command -v docker &> /dev/null; then
    echo "Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker
else
    echo "Docker already installed"
fi

# Enable IPv6 + ip6tables NAT so published ports preserve real client v6
# source addresses. Without this, v6 traffic falls back to docker-proxy and
# arrives at the container as the bridge gateway IP — any IP allowlist breaks.
DAEMON_JSON=/etc/docker/daemon.json
DESIRED_DAEMON_JSON='{
  "ipv6": true,
  "ip6tables": true,
  "userland-proxy": false
}'
if [ ! -f "$DAEMON_JSON" ] || [ "$(cat "$DAEMON_JSON")" != "$DESIRED_DAEMON_JSON" ]; then
    echo "Updating $DAEMON_JSON for IPv6 support (will restart Docker)..."
    mkdir -p /etc/docker
    printf '%s\n' "$DESIRED_DAEMON_JSON" > "$DAEMON_JSON"
    systemctl restart docker
fi

# Firewall
echo "Configuring firewall..."
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 1935/tcp
ufw allow 9999/udp
ufw --force enable

# Check repo
if [ ! -f /opt/sruth/docker-compose.prod.yml ]; then
    echo "ERROR: Clone the repo to /opt/sruth first"
    echo "  git clone <repo-url> /opt/sruth"
    exit 1
fi

cd /opt/sruth

# .env setup
if [ ! -f .env ]; then
    echo "Generating .env with random secrets..."
    deploy/gen-env.sh
    echo ""
    echo "Save the printed secrets to your password manager, then re-run this script."
    exit 0
fi

# Launch
#
# `--force-recreate` guards against a subtle trap: when the network config
# changes (e.g. adding an IPv6 subnet), compose recreates `sruth_default`
# but leaves containers whose own config didn't change attached to the old,
# now-deleted network — they end up orphaned and unreachable by service name.
# Recreating every container on each provision keeps them all on the current
# network.
echo "Building and starting services..."
docker compose -f docker-compose.prod.yml up -d --build --force-recreate --remove-orphans

# Wait for API to be healthy
echo "Waiting for API to be healthy..."
for i in $(seq 1 30); do
    if docker compose -f docker-compose.prod.yml exec -T api wget -q -O- http://127.0.0.1:3000/health > /dev/null 2>&1; then
        echo "API is healthy"
        break
    fi
    if [ "$i" -eq 30 ]; then
        echo "WARNING: API did not become healthy in time"
    fi
    sleep 2
done

# Backup database before schema push
#
# `prisma db push --accept-data-loss` will happily drop columns/tables if the
# schema diverges from what's live. Take a pg_dump first so we can recover if
# a deploy surprises us. Retention keeps the last 7 dumps on disk.
#
# This is pre-alpha mitigation only — backups on the same VM as the DB are
# lost if the VM dies. See issue #56 for the durable backup plan.
BACKUP_DIR=/opt/sruth/backups
mkdir -p "$BACKUP_DIR"

# $POSTGRES_USER / $POSTGRES_DB are injected by the Postgres image from .env,
# so we reference them inside the container rather than sourcing .env here.
if docker compose -f docker-compose.prod.yml exec -T postgres \
        sh -c 'pg_isready -U "$POSTGRES_USER"' > /dev/null 2>&1; then
    BACKUP_FILE="$BACKUP_DIR/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ).sql"
    echo "Backing up database to $BACKUP_FILE..."
    docker compose -f docker-compose.prod.yml exec -T postgres \
        sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$BACKUP_FILE"
    # Keep the 7 most recent dumps.
    ls -1t "$BACKUP_DIR"/pre-deploy-*.sql 2>/dev/null | tail -n +8 | xargs -r rm --
else
    echo "Postgres not ready — skipping pre-deploy backup (first deploy?)"
fi

# Push schema
echo "Pushing database schema..."
docker compose -f docker-compose.prod.yml exec -T -w /app/apps/api api npx prisma db push --config prisma/prisma.config.ts --accept-data-loss

# Enforce one active StreamSession per user at the DB layer. Prisma can't
# express a partial unique index in its schema (and we don't use migrations),
# so apply it as raw SQL after `db push`. The `on-publish` handler relies on
# this to resolve concurrent publishes via a P2002 — without it, two racing
# publishes can both create LIVE sessions for the same user.
echo "Ensuring partial unique index on StreamSession(userId) for active sessions..."
docker compose -f docker-compose.prod.yml exec -T postgres \
    sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' <<'SQL'
CREATE UNIQUE INDEX IF NOT EXISTS "StreamSession_userId_active_key"
ON "StreamSession"("userId")
WHERE status IN ('STARTING', 'LIVE');
SQL

echo ""
echo "=== Done ==="
echo "Site: https://sruth.live"
echo "API:  https://api.sruth.live"
echo "RTMP: rtmp://sruth.live:1935/live/<key>"
echo "SRT:  srt://sruth.live:9999?streamid=live/<key>"
