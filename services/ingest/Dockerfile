FROM tiangolo/nginx-rtmp

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl gettext-base \
    && rm -rf /var/lib/apt/lists/*

COPY nginx.conf.template /etc/nginx/nginx.conf.template
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

HEALTHCHECK --interval=5s --timeout=3s --retries=12 \
    CMD curl -sf http://localhost:8080/health || exit 1

EXPOSE 1935 8080

ENTRYPOINT ["/docker-entrypoint.sh"]
