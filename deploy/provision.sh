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
    echo "Creating .env from template..."
    cp deploy/.env.template .env
    echo ""
    echo "IMPORTANT: Edit /opt/sruth/.env with real secrets before continuing."
    echo "  nano /opt/sruth/.env"
    echo ""
    echo "Then re-run this script."
    exit 0
fi

# Launch
echo "Building and starting services..."
docker compose -f docker-compose.prod.yml up -d --build

# Wait for API to be healthy
echo "Waiting for API to be healthy..."
for i in $(seq 1 30); do
    if docker compose -f docker-compose.prod.yml exec -T api wget -q -O- http://localhost:3000/health > /dev/null 2>&1; then
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
docker compose -f docker-compose.prod.yml exec -T api npx prisma db push --config prisma/prisma.config.ts --accept-data-loss

echo ""
echo "=== Done ==="
echo "Site: https://sruth.live"
echo "API:  https://api.sruth.live"
echo "RTMP: rtmp://sruth.live:1935/live/<key>"
echo "SRT:  srt://sruth.live:9999?streamid=live/<key>"
