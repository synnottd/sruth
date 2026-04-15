FROM bluenviron/mediamtx:1.17.1-ffmpeg
RUN apk add --no-cache curl
COPY mediamtx.yml /mediamtx.yml
COPY callbacks.sh /callbacks.sh
RUN chmod +x /callbacks.sh
EXPOSE 1935 9999/udp 9997
