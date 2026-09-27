#!/bin/sh
set -e
cd /data
if [ ! -f wgcf-profile.conf ]; then
  wgcf register --accept-tos
  wgcf generate
fi
chmod 600 wgcf-account.toml wgcf-profile.conf
cat > wireproxy.conf <<CONF
WGConfig = /data/wgcf-profile.conf

[Socks5]
BindAddress = 0.0.0.0:40000
CONF
exec wireproxy -s -c wireproxy.conf
