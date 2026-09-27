#!/bin/sh
# Ship the committed tree to the server and rebuild the container.
# Usage: deploy/deploy.sh [ssh-target]   (default: $SONGSURF_HOST)
# Only committed files are sent; the server keeps its own deploy/.env and data volume.
set -eu
HOST="${1:-${SONGSURF_HOST:?set SONGSURF_HOST or pass user@host}}"
DIR="${SONGSURF_DIR:-songsurf}"
cd "$(git rev-parse --show-toplevel)"
[ -z "$(git status --porcelain)" ] || echo "note: uncommitted changes are not deployed"
REV=$(git rev-parse --short HEAD)
git archive HEAD | ssh "$HOST" "mkdir -p $DIR && tar -x -C $DIR && echo $REV > $DIR/REVISION && cd $DIR/deploy \
  && docker compose up -d --build && docker image prune -f >/dev/null && docker builder prune -f --filter until=24h >/dev/null"
echo "deployed $REV"
