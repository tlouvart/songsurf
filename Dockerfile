# syntax=docker/dockerfile:1

# --- build the client ---------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- runtime: API + static files, no dev tooling ------------------------------
FROM node:24-slim
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0 NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app
# FFmpeg decodes songs for the server's analysis.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY scripts ./scripts
# The server replays runs with the game's own simulation and track generator.
COPY src ./src
COPY deploy/entrypoint.sh /usr/local/bin/songsurf-entrypoint
# The database, audio cache and yt-dlp binary live in /app/.cache (a volume), owned by the app user.
RUN mkdir -p .cache && chown node:node .cache && chmod 0755 /usr/local/bin/songsurf-entrypoint
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["songsurf-entrypoint"]
CMD ["node", "--import", "tsx", "server/index.ts"]
