/** Waveform peaks and tempo detection. The DSP part works on plain Float32Arrays (testable in Node). */

export interface AudioAnalysis {
  duration: number;
  sampleRate: number;
  mono: Float32Array;
  /** Max |amplitude| per bucket, `peaksPerSecond` buckets per second. */
  peaks: Float32Array;
  peaksPerSecond: number;
}

export const PEAKS_PER_SECOND = 200;

export function mixToMono(buffer: AudioBuffer): Float32Array {
  const out = new Float32Array(buffer.length);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) out[i] += data[i] / buffer.numberOfChannels;
  }
  return out;
}

export function computePeaks(mono: Float32Array, sampleRate: number, peaksPerSecond = PEAKS_PER_SECOND): Float32Array {
  const bucket = sampleRate / peaksPerSecond;
  const n = Math.ceil(mono.length / bucket);
  const peaks = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    const end = Math.min(mono.length, Math.floor((i + 1) * bucket));
    for (let j = Math.floor(i * bucket); j < end; j++) {
      const v = Math.abs(mono[j]);
      if (v > m) m = v;
    }
    peaks[i] = m;
  }
  return peaks;
}

export async function analyzeAudio(data: ArrayBuffer): Promise<AudioAnalysis> {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  try {
    const buffer = await ctx.decodeAudioData(data);
    const mono = mixToMono(buffer);
    return { duration: buffer.duration, sampleRate: buffer.sampleRate, mono, peaks: computePeaks(mono, buffer.sampleRate), peaksPerSecond: PEAKS_PER_SECOND };
  } finally {
    void ctx.close();
  }
}

export interface TempoEstimate {
  bpm: number;
  /** Seconds (relative to the analysed signal) of a beat. */
  offset: number;
  /** Peak-to-mean ratio of the tempo score; < ~1.5 means "guess". */
  confidence: number;
}

/**
 * Onset envelope (half-wave rectified log-energy flux, 10 ms hop) -> autocorrelation with a mild
 * log-normal prior around 120 BPM against octave errors -> comb filter for the phase.
 */
export function detectTempo(mono: Float32Array, sampleRate: number, minBpm = 70, maxBpm = 180): TempoEstimate | null {
  const factor = Math.max(1, Math.floor(sampleRate / 11025));
  const sr = sampleRate / factor;
  const hop = Math.max(1, Math.round(sr * 0.01));
  const hopSec = hop / sr;
  const n = Math.floor(mono.length / factor);
  const frames = Math.floor(n / hop) - 1;
  if (frames < 400) return null;

  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let k = 0; k < hop * 2 && (f * hop + k) * factor < mono.length; k++) {
      const v = mono[(f * hop + k) * factor];
      e += v * v;
    }
    energy[f] = Math.log(1 + 1000 * e);
  }
  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) onset[f] = Math.max(0, energy[f] - energy[f - 1]);
  // remove slow trends (moving average over ~0.5 s)
  const w = Math.round(0.25 / hopSec);
  let acc = 0;
  const avg = new Float32Array(frames);
  for (let f = 0; f < frames + w; f++) {
    if (f < frames) acc += onset[f];
    if (f - 2 * w - 1 >= 0) acc -= onset[f - 2 * w - 1];
    const c = f - w;
    if (c >= 0 && c < frames) avg[c] = acc / (2 * w + 1);
  }
  for (let f = 0; f < frames; f++) onset[f] = Math.max(0, onset[f] - avg[f]);
  // Hits are ~1 hop wide; widen them so periods between two hop multiples still correlate.
  const smooth = new Float32Array(frames);
  for (let f = 2; f < frames - 2; f++) {
    smooth[f] = (onset[f - 2] + 2 * onset[f - 1] + 3 * onset[f] + 2 * onset[f + 1] + onset[f + 2]) / 9;
  }

  const acf = (lag: number) => {
    let s = 0;
    for (let f = 0; f + lag < frames; f++) s += smooth[f] * smooth[f + lag];
    return s / (frames - lag);
  };
  const minLag = Math.floor(60 / maxBpm / hopSec);
  const maxLag = Math.ceil(60 / minBpm / hopSec);
  const scores: number[] = [];
  let bestLag = minLag;
  let best = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 / (lag * hopSec);
    const prior = Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);
    const s = (acf(lag) + 0.5 * acf(2 * lag)) * prior;
    scores.push(s);
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  // A pulse train is also periodic at twice its period. If the half lag is about as strong,
  // the faster tempo is the real one (e.g. 174 BPM would otherwise come out as 87).
  const acfNear = (lag: number) => Math.max(acf(lag - 1), acf(lag), acf(lag + 1));
  while (60 / ((bestLag / 2) * hopSec) <= maxBpm + 1 && acfNear(Math.round(bestLag / 2)) >= 0.8 * acfNear(bestLag)) {
    bestLag = Math.round(bestLag / 2);
  }
  // The ACF only resolves whole hops (~1 BPM at 140). Refine tempo and phase together with a comb
  // filter over the interpolated envelope: ±2 % around the coarse tempo in 0.01 BPM steps.
  const at = (x: number) => {
    const i0 = Math.floor(x);
    const fr = x - i0;
    return i0 + 1 < frames ? smooth[i0] * (1 - fr) + smooth[i0 + 1] * fr : 0;
  };
  const coarse = 60 / (bestLag * hopSec);
  let bpm = coarse;
  let phase = 0;
  let bestComb = -Infinity;
  for (let cand = Math.round(coarse * 98) / 100; cand <= coarse * 1.02; cand += 0.01) {
    const period = 60 / cand / hopSec;
    for (let ph = 0; ph < period; ph += 0.5) {
      let s = 0;
      for (let t = ph; t < frames - 1; t += period) s += at(t);
      if (s > bestComb) {
        bestComb = s;
        bpm = cand;
        phase = ph;
      }
    }
  }
  bpm = Math.abs(bpm - Math.round(bpm)) < 0.05 ? Math.round(bpm) : Math.round(bpm * 100) / 100;

  const mean = scores.reduce((x, y) => x + y, 0) / scores.length;
  // Energy frame f covers samples [f*hop, (f+2)*hop), so a hit first shows up ~1.5 hops early.
  const beat = 60 / bpm;
  const offset = ((((phase + 1.5) * hopSec) % beat) + beat) % beat;
  return { bpm, offset, confidence: mean > 0 ? best / mean : 0 };
}
