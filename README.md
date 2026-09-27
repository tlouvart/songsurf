# SongSurf

[songsurf.io](https://songsurf.io)

Paste a YouTube link (or drop an audio file) and SongSurf builds a neon rollercoaster from the music, then you ride it.

It's a web take on the Audiosurf idea. The track is generated from the song itself: calm passages climb, loud ones dive, turns and twists follow the phrasing, and the biggest drops throw in a loop. The blocks you catch are the music's hits.

## Play

```bash
npm install
npm run setup     # downloads the latest yt-dlp into .cache/bin (needed for YouTube links)
npm run dev       # API on :8787, game on http://localhost:5173
```

No YouTube? **Ride the demo track** (a synthesized song) or drop any audio file on the page.

Production: `npm run build && npm start` serves the game and the API from one port (`PORT`, default 8787).

### Controls

| | |
|---|---|
| `←` `→` / `A` `D` | switch lane (hold to keep moving) |
| `1`–`5` | jump straight to a lane |
| mouse / touch | steer (softly snaps to lanes) |
| `Space` | Overdrive (when charged) |
| `Esc` | pause |

### Scoring

- Catch blocks: hotter colours are worth more.
- Consecutive catches raise your multiplier (×1 → ×8, +1 every 10).
- A missed block halves your combo. A **grey** block resets it and costs points.
- **Gems** charge **Overdrive**: 8 s of double points and a magnet for neighbouring lanes.
- **Long blocks** leave a glowing trail (sometimes sliding over a lane): catch the head, stay on the trail for points, finish it for a bonus. Leaving it costs nothing.
- **Streams** are fast chains of small diamonds on rolls and runs in the music: catch them all for a bonus. Missing one never breaks your combo.

### Credits and hangar

Every game pays **credits (◈)**: about 1 ◈ per 40 points of score (capped at 2,500 per song), plus a placement bonus for each lobby round (150 / 100 / 60 / 30). Everyone starts with 1,500 ◈.

Spend them in the **hangar**: 7 hulls, 7 wing sets, 6 engine layouts, 5 fins and 5 cockpits, 7 finishes (from matte to chrome, carbon, pearl and holo), 10 textures (stripes, chevrons, hex, tiger, circuit, flames…) and 8 trails. Items have a price and a rarity; a few of each are free. Try anything on before buying it; a ship can only be saved with items you own.

Colours are free and unlimited: six zones (body, wings & fins, trim, texture, neon, engine glow) each take any colour, and the texture scale is adjustable. Ships are procedural (`src/ship/`), saved on your profile, and shown to the other pilots in your lobbies (click a ship to inspect it).

### Solo, ranked and casual

- **Solo** trains on anything: a YouTube link, the demo, an audio file, or any song from your history. The HUD shows your pace against your own best on that song.
- **Ranked** and **Casual** put you in a lobby of up to 8 pilots (one lobby at a time). Ranked matchmaking picks the open lobby whose average Elo is closest to yours, within a window that widens the longer that lobby has waited.
- **Play with friends**: casual lobbies have a 5-letter code; while you're in one, the address bar is its invite link (`/?lobby=CODE`). Join by code from the home screen. Ranked lobbies are matchmade only.
- In a lobby:
  1. While pilots join, everyone submits one song and chats. The match starts when 8 are in, or after 2 minutes with at least 2.
  2. A match is **3 rounds**. Each round, 3 unplayed submissions go to a vote, then everyone rides the winner **at the same moment** (server-synced start), with a live scoreboard.
  3. Placements score 10 / 8 / 6 / 5 / 4 / 3 / 2 / 1 points. Leaving (or staying disconnected for more than 15 s) ranks you **last** for the match.
  4. Ranked matches move your **Elo** (pairwise, chess-style). Casual matches are just for fun: no rating changes.
- **Ranked unlocks** after 3 games (solo runs or casual matches).
- **Leaderboard** (🏆): the top 100 pilots by Elo with their ships, wins and matches; your own rank is pinned below. Click anyone to see their public profile: ship, stats, most-played songs and socials.
- **Profile** (click your name): rename yourself, stats and rank, social links (Twitch, YouTube, X, Discord), your most-played songs and full history, all replayable in one click.
- **Settings** (⚙): music and effects volume, block hit sounds on/off, screen effects (shake, zoom, blur) on/off, FPS counter, graphics quality (high / medium / low).
- **Friends**: add pilots by name, see who is online and in which lobby, and join them.

Identity is a pilot name plus a secret token kept in the browser: no password yet.

## How it works

```
YouTube URL ──► server (yt-dlp) ──► audio file ──► browser
                                                   │
         Web Worker: STFT → onsets, beats, drops, intensity curve
                                                   │
      deterministic generator (seeded by song id) ─► track + blocks
                                                   │
           race sim (song time) ──► Three.js renderer + HUD
```

| Path | What |
|---|---|
| `src/audio/analyze.ts` | FFT features, spectral-flux onsets, tempo + DP beat tracking, drops, intensity |
| `src/track/track.ts` | track generation: speed, turns, twist, loops/rolls as quaternion frames; block placement |
| `src/game/sim.ts` | catch & combo rules, keyed on song time |
| `src/game/ghosts.ts` | run recording (personal bests, pace line), per-song leaderboard client |
| `src/net/*` | shared WebSocket protocol, realtime client with clock sync, REST helpers |
| `src/ship/*` | ship catalog (shared with the server), procedural ship builder, 3D viewer and thumbnails |
| `src/ui/*` | HUD, main menu (profile, friends, history, ranking), hangar, lobby screen |
| `src/render/*` | track mesh, blocks, ship, environment, particles, post-processing |
| `server/lobby.ts` | lobbies: phases, votes, synced starts, placements, Elo (leaving ranks you last) |
| `server/db.ts` | SQLite (Node's built-in `node:sqlite`, `.cache/songsurf.db`): pilots, friends, games |
| `server/` | YouTube lookup/download with caching, per-song boards, static hosting |

Handy for development: `?seek=<seconds>` starts a song mid-way (runs are then not recorded). `window.songsurf` exposes the stage, session and lobby in the console, and `songsurf.finishRace()` crosses the line early. `SONGSURF_LOBBY_WAIT_MS` shortens the lobby wait, `SONGSURF_DB` picks another database file, and `SONGSURF_API` points a second Vite dev server at another API port.

## Self-hosting

A production image serves the built client and the API from one Node process:

```sh
cd deploy
cp .env.example .env        # optional overrides (public origin, cache size, bind address)
docker compose up -d --build
```

The container runs as a non-root user on a read-only filesystem with all capabilities dropped. The database, the audio cache and yt-dlp (which updates itself daily) live in the `songsurf-data` volume. By default it only listens on the Docker bridge (`172.17.0.1:3400`); put a TLS reverse proxy in front. `deploy/nginx-songsurf.conf` is the one used for songsurf.io, behind Cloudflare, and only accepts Cloudflare's addresses.

Server settings (environment): `PORT`, `HOST`, `PUBLIC_ORIGIN` (the only origin allowed to open lobby sockets), `TRUST_PROXY=1` (take the client address from `CF-Connecting-IP` / `X-Real-IP`, only behind a proxy you control), `AUDIO_CACHE_MB` (audio cache budget, 3000 by default), `YTDLP_PATH`.

The server rate-limits per client address (API calls, sign-ups, YouTube lookups, recorded runs, socket connections and messages), caps concurrent yt-dlp jobs, and sends a strict content security policy.

## Notes

- Downloading from YouTube relies on [yt-dlp](https://github.com/yt-dlp/yt-dlp). If downloads start failing with HTTP 403, run `npm run setup` again to get the newest version. Respect the terms of the content you play.
- Scores are reported by the players' browsers and trusted as-is: fine among friends, not yet a cheat-proof public ladder.
- Node 24+ is required.

## License

MIT
