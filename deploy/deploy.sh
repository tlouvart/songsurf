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

# Upload into a fresh directory next to the live one (deleted files don't linger).
git archive HEAD | ssh "$HOST" "set -e; rm -rf $DIR.new && mkdir -p $DIR.new && tar -x -C $DIR.new \
  && if [ -f $DIR/deploy/.env ]; then cp -p $DIR/deploy/.env $DIR.new/deploy/.env; fi && echo $REV > $DIR.new/REVISION"

# The swap and rebuild run detached on the server: if this connection drops mid-way, the
# server still finishes (a half-done "compose up" would leave the site down). If the build
# fails, the running containers keep serving.
ssh "$HOST" "setsid nohup sh -c 'set -e; rm -rf $DIR.old; if [ -d $DIR ]; then mv $DIR $DIR.old; fi; mv $DIR.new $DIR; \
  cd $DIR/deploy && docker compose up -d --build && docker image prune -f >/dev/null && docker builder prune -f --filter until=24h >/dev/null; \
  echo DEPLOY_OK' > deploy-songsurf.log 2>&1 < /dev/null &"

echo "building $REV on the server…"
for _ in $(seq 1 120); do
  sleep 5
  if ssh "$HOST" "grep -q DEPLOY_OK deploy-songsurf.log"; then echo "deployed $REV"; exit 0; fi
  if ssh "$HOST" "! pgrep -f 'docker compose up' >/dev/null && ! grep -q DEPLOY_OK deploy-songsurf.log"; then
    ssh "$HOST" "tail -20 deploy-songsurf.log"; echo "deploy failed (the previous version keeps running)"; exit 1
  fi
done
echo "still building after 10 min, check ~/deploy-songsurf.log on the server"; exit 1
