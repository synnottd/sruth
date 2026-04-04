#!/usr/bin/env bash
set -e
envsubst '${API_HOST}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf
exec nginx -g 'daemon off;'
