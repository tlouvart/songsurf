import { analyzeAudio } from './analyze.ts';

self.onmessage = (e: MessageEvent<{ samples: Float32Array; sampleRate: number }>) => {
  const { samples, sampleRate } = e.data;
  const result = analyzeAudio(samples, sampleRate, (p) => self.postMessage({ type: 'progress', value: p }));
  const transfer = [result.loudness, result.intensity, result.low, result.mid, result.high, result.centroid].map(
    (a) => a.buffer,
  );
  (self as unknown as Worker).postMessage({ type: 'done', result }, transfer);
};
