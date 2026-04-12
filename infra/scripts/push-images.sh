#!/usr/bin/env bash
set -euo pipefail

# Build, tag, and push all 4 service images to ECR.
# Usage:
#   ./infra/scripts/push-images.sh              # tag = git short SHA
#   ./infra/scripts/push-images.sh my-tag       # tag = "my-tag"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REGION="us-east-1"
ACCOUNT="512795167257"
REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
TAG="${1:-$(git -C "$REPO_ROOT" rev-parse --short HEAD)}"

# Map: ECR repo name -> Docker build context (relative to repo root) and Dockerfile path
declare -A CONTEXTS=(
  [api]="."
  [web]="."
  [ingest]="services/ingest"
  [worker]="."
)

declare -A DOCKERFILES=(
  [api]="apps/api/Dockerfile"
  [web]="apps/web/Dockerfile"
  [ingest]="services/ingest/Dockerfile"
  [worker]="services/worker/Dockerfile"
)

echo "==> Authenticating with ECR (${REGISTRY})"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

for SERVICE in api web ingest worker; do
  IMAGE="${REGISTRY}/omega-stream/${SERVICE}:${TAG}"
  CONTEXT="${REPO_ROOT}/${CONTEXTS[$SERVICE]}"
  DOCKERFILE="${REPO_ROOT}/${DOCKERFILES[$SERVICE]}"

  if [[ ! -f "$DOCKERFILE" ]]; then
    echo "==> SKIP ${SERVICE} (no Dockerfile at ${DOCKERFILES[$SERVICE]})"
    continue
  fi

  echo "==> Building ${SERVICE} -> ${IMAGE}"
  docker build \
    --platform linux/amd64 \
    -f "$DOCKERFILE" \
    -t "$IMAGE" \
    "$CONTEXT"

  echo "==> Pushing ${SERVICE}"
  docker push "$IMAGE"

  # Also tag as "latest"
  docker tag "$IMAGE" "${REGISTRY}/omega-stream/${SERVICE}:latest"
  docker push "${REGISTRY}/omega-stream/${SERVICE}:latest"
done

echo ""
echo "Done. All images pushed with tag: ${TAG}"
echo "Deploy with: npx cdk deploy OmegaStreamService -c imageTag=${TAG}"
