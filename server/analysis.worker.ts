import { execFileSync } from 'node:child_process';
import { parentPort, workerData } from 'node:worker_threads';
import { analyzeAudio } from '../src/audio/analyze.ts';
import { decodeAnalysis, encodeAnalysis } from '../src/audio/codec.ts';
import { synthesize } from '../src/audio/demoSong.ts';
import { generateTrack } from '../src/track/track.ts';

/**
 * One song, off the main thread: decode (ffmpeg) → analyse → build the track. The track is
 * built from the encoded analysis, exactly what the browsers receive, so both sides agree.
 */

const { key, file } = workerData as { key: string; file: string | null };
const RATE = 22050;

let samples: Float32Array;
let rate: number;
if (key.startsWith('demo:')) {
  const demo = synthesize();
  samples = new Float32Array(demo.left.length);
  for (let i = 0; i < samples.length; i++) samples[i] = (demo.left[i] + demo.right[i]) / 2;
  rate = demo.rate;
} else {
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-i', file!, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], {
    maxBuffer: 16 * 60 * RATE * 4,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  samples = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + (pcm.length & ~3)));
  rate = RATE;
}

const encoded = encodeAnalysis(analyzeAudio(samples, rate, () => {}));
const track = generateTrack(decodeAnalysis(encoded), key);
parentPort!.postMessage({ encoded, core: { duration: track.duration, blocks: track.blocks, streams: track.streams } });
