# YouTube refuses most datacenter IPs ("Sign in to confirm you're not a bot"). This sidecar
# gives yt-dlp, and only yt-dlp, a way out through Cloudflare WARP: a userspace WireGuard
# tunnel exposed as a SOCKS5 proxy on the stack's private network. No host changes, no
# privileges. The WARP account is created on first start and kept in the /data volume.
FROM alpine:3.22
ARG WGCF=https://github.com/ViRb3/wgcf/releases/download/v2.3.0/wgcf_2.3.0_linux_amd64
ARG WGCF_SHA256=01614e38c0eb5f3405232e71cfaf02d64d4809e4988ad8f5a8071af16d193405
ARG WIREPROXY=https://github.com/windtf/wireproxy/releases/download/v1.1.3/wireproxy_linux_amd64.tar.gz
ARG WIREPROXY_SHA256=e88c1d090740373fc606c1bafd81d9a5eadc642cce5667616e20e9d7a444f51c
RUN apk add --no-cache ca-certificates \
 && wget -qO /usr/local/bin/wgcf "$WGCF" && echo "$WGCF_SHA256  /usr/local/bin/wgcf" | sha256sum -c - \
 && wget -qO /tmp/wp.tgz "$WIREPROXY" && echo "$WIREPROXY_SHA256  /tmp/wp.tgz" | sha256sum -c - \
 && tar -xzf /tmp/wp.tgz -C /usr/local/bin wireproxy && rm /tmp/wp.tgz \
 && chmod 0755 /usr/local/bin/wgcf /usr/local/bin/wireproxy \
 && adduser -D -H -u 10001 warp && mkdir /data && chown warp /data
COPY entrypoint.sh /usr/local/bin/warp-entrypoint
USER warp
WORKDIR /data
ENTRYPOINT ["/bin/sh", "/usr/local/bin/warp-entrypoint"]
