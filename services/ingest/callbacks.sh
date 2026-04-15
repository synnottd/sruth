#!/usr/bin/env sh
set -e

ACTION="$1"
MTX_PATH_ARG="$2"

: "${API_HOST:?API_HOST must be set}"
: "${INTERNAL_SECRET:?INTERNAL_SECRET must be set}"

case "$ACTION" in
  on-publish)
    # Extract stream key from path (e.g. "live/abc-123" -> "abc-123")
    STREAM_KEY=$(echo "$MTX_PATH_ARG" | sed 's|^live/||')

    # Source IP: use override if set (for Docker networking), else empty
    SOURCE_IP="${INGEST_IP_OVERRIDE:-}"

    echo "[callbacks] on-publish path=$MTX_PATH_ARG key=$STREAM_KEY addr=$SOURCE_IP"

    # POST form-encoded data matching the nginx-rtmp callback format
    HTTP_CODE=$(curl -s -o /dev/stderr -w "%{http_code}" \
      -X POST \
      -H "X-Internal-Secret: ${INTERNAL_SECRET}" \
      -d "app=live&name=${STREAM_KEY}&addr=${SOURCE_IP}" \
      "http://${API_HOST}/internal/stream/on-publish")

    if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
      echo "[callbacks] on-publish REJECTED (HTTP $HTTP_CODE)"
      exit 1
    fi

    echo "[callbacks] on-publish ACCEPTED (HTTP $HTTP_CODE)"
    ;;
  *)
    echo "[callbacks] unknown action: $ACTION"
    exit 1
    ;;
esac
