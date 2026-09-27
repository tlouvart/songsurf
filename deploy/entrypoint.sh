#!/bin/sh
set -e
# yt-dlp lives in the data volume so it can update itself without rebuilding the image.
if [ ! -x .cache/bin/yt-dlp ]; then node scripts/setup.mjs; fi
exec "$@"
