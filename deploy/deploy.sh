#!/bin/sh
# Ship the committed tree to the server and rebuild the container.
# Usage: deploy/deploy.sh [ssh-target]   (default: $SONGSURF_HOST)
# Only committed files are sent; the server keeps its own deploy/.env and data volumes.
set -eu
HOST="${1:-${SONGSURF_HOST:?set SONGSURF_HOST or pass user@host}}"
DIR="${SONGSURF_DIR:-songsurf}"
cd "$(git rev-parse --show-toplevel)"
[ -z "$(git status --porcelain)" ] || echo "note: uncommitted changes are not deployed"
REV=$(git rev-parse --short HEAD)
# Unpack into a fresh directory (so deleted files don't linger), keep the server's deploy/.env,
# then swap it in and rebuild. If the build fails, the running containers keep serving.
git archive HEAD | ssh "$HOST" "set -e; rm -rf $DIR.new && mkdir -p $DIR.new && tar -x -C $DIR.new \
  && if [ -f $DIR/deploy/.env ]; then cp -p $DIR/deploy/.env $DIR.new/deploy/.env; fi \
  && echo $REV > $DIR.new/REVISION && rm -rf $DIR.old && if [ -d $DIR ]; then mv $DIR $DIR.old; fi && mv $DIR.new $DIR \
  && cd $DIR/deploy && docker compose up -d --build && docker image prune -f >/dev/null && docker builder prune -f --filter until=24h >/dev/null"
echo "deployed $REV"
