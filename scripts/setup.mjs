// Downloads the latest standalone yt-dlp into .cache/bin so the SongSurf server can fetch
// YouTube audio without any global install. Re-run it whenever YouTube downloads start failing.
import { chmodSync, createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const assets = { linux: 'yt-dlp_linux', darwin: 'yt-dlp_macos', win32: 'yt-dlp.exe' };
const asset = assets[process.platform];
if (!asset) {
  console.error(`No prebuilt yt-dlp for ${process.platform}; install it yourself (https://github.com/yt-dlp/yt-dlp).`);
  process.exit(1);
}
const arch = process.platform === 'linux' && process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : asset;
const dir = join(process.cwd(), '.cache', 'bin');
const target = join(dir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
mkdirSync(dir, { recursive: true });

const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${arch}`;
console.log(`Downloading ${url}`);
const res = await fetch(url);
if (!res.ok || !res.body) {
  console.error(`Download failed: HTTP ${res.status}`);
  process.exit(1);
}
await pipeline(Readable.fromWeb(res.body), createWriteStream(target));
chmodSync(target, 0o755);
console.log(`yt-dlp installed at ${target}`);
