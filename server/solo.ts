import type { WebSocket } from 'ws';
import { Pacer, RunVerifier, type InputChunk } from '../src/game/replay.ts';
import { STEP } from '../src/game/sim.ts';
import type { ServerMsg, SoloMsg } from '../src/net/protocol.ts';
import { creditsForScore } from '../src/ship/catalog.ts';
import { TRACK_VERSION } from '../src/track/track.ts';
import * as db from './db.ts';
import { addVerifiedRun } from './runs.ts';
import { DEMO_KEY, isSongKey, songData } from './tracks.ts';
import { getInfo } from './youtube.ts';

/**
 * Verified solo runs. The browser streams its inputs while it plays; the server replays them
 * on its own copy of the track, checks they keep pace with the music in real time, and at the
 * end records the score it computed, never one the browser reports.
 */

const MAX_PAUSES = 5;
const MAX_QUEUE = 2000;

interface SoloRun {
  key: string;
  startedAt: number;
  pacer: Pacer;
  verifier: RunVerifier | null;
  queue: InputChunk[];
  error: string | null;
  ready: Promise<void>;
  finished: boolean;
}

const runs = new Map<number, SoloRun>();
// Runs nobody finished (closed tab, crash) are forgotten after a while.
setInterval(() => {
  for (const [id, r] of runs) if (Date.now() - r.startedAt > 30 * 60_000) runs.delete(id);
}, 60_000).unref();

const send = (ws: WebSocket, msg: ServerMsg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));

function feed(run: SoloRun, chunk: unknown) {
  if (run.error || run.finished) return;
  const c = chunk as InputChunk;
  if (!c || !Number.isInteger(c.upTo)) {
    run.error = 'bad input';
    return;
  }
  run.error = run.pacer.check(Date.now(), c.upTo * STEP);
  if (run.error) return;
  if (!run.verifier) {
    if (run.queue.length >= MAX_QUEUE) run.error = 'too many inputs';
    else run.queue.push(c);
    return;
  }
  run.error = run.verifier.feed(c);
}

export async function onSolo(ws: WebSocket, player: db.Player, msg: SoloMsg) {
  const now = Date.now();
  if (msg.action === 'start') {
    const t = Number(msg.t);
    if (!isSongKey(String(msg.key)) || !Number.isFinite(t) || t < -6 || t > 0.5) return;
    const key = msg.key;
    const run: SoloRun = {
      key, startedAt: now, pacer: new Pacer(now - t * 1000), verifier: null, queue: [], error: null, finished: false,
      ready: Promise.resolve(),
    };
    run.ready = songData(key).then(
      (d) => {
        run.verifier = new RunVerifier(d.core);
        for (const c of run.queue.splice(0)) if (!run.error) run.error = run.verifier.feed(c);
      },
      () => {
        run.error = 'song unavailable';
      },
    );
    runs.set(player.id, run);
    return;
  }
  const run = runs.get(player.id);
  if (!run) return;
  switch (msg.action) {
    case 'input':
      return feed(run, msg.chunk);
    case 'pause':
      if (msg.chunk) feed(run, msg.chunk);
      run.pacer.pause(now);
      return;
    case 'resume':
      run.pacer.resume(now);
      return;
    case 'abort':
      runs.delete(player.id);
      return;
    case 'finish': {
      if (msg.chunk) feed(run, msg.chunk);
      run.finished = true;
      runs.delete(player.id);
      await run.ready;
      const v = run.verifier;
      const reason =
        run.error ?? (!v ? 'song unavailable' : !v.complete ? 'run not finished' : run.pacer.pauses > MAX_PAUSES ? 'too many pauses' : null);
      if (reason || !v) return send(ws, { type: 'soloResult', verified: false, reason: reason ?? 'not verified' });

      const score = v.score;
      const info = run.key === DEMO_KEY ? { title: 'Neon Drive', uploader: 'SongSurf synth' } : await getInfo(run.key.slice(3)).catch(() => null);
      db.recordGame({
        player_id: player.id, mode: 'solo', song_key: run.key, song_title: info?.title ?? '', song_artist: info?.uploader ?? '', score,
      });
      const earned = creditsForScore(score);
      db.addCredits(player.id, earned);
      const fresh = db.byId(player.id)!;
      const board = addVerifiedRun({ songId: `${run.key}#t${TRACK_VERSION}`, name: fresh.name, score, x: v.ghostX, s: v.ghostS });
      return send(ws, { type: 'soloResult', verified: true, score, earned, player: fresh, rank: board.rank, board: board.board });
    }
  }
}
