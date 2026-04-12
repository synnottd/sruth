#!/usr/bin/env bash
set -e
: "${API_HOST:?API_HOST must be set}"
: "${INTERNAL_SECRET:?INTERNAL_SECRET must be set}"
envsubst '${API_HOST} ${INTERNAL_SECRET}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf
exec nginx -g 'daemon off;'
