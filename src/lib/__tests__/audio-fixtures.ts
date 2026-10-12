/** Test helpers: generates real PCM WAV files so the analysis pipeline is exercised on genuine audio. */

export function makeWav(opts: {
  seconds: number;
  sampleRate?: number;
  channels?: number;
  /** Hz of a sine tone; 0 = digital silence. */
  frequency?: number;
  /** Optional per-sample amplitude envelope 0..1 over [0,1] of the clip. */
  envelope?: (t: number) => number;
}): Uint8Array {
  const sampleRate = opts.sampleRate ?? 16000;
  const channels = opts.channels ?? 1;
  const frames = Math.round(opts.seconds * sampleRate);
  const dataBytes = frames * channels * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, dataBytes, true);
  const freq = opts.frequency ?? 440;
  for (let i = 0; i < frames; i++) {
    const t = i / frames;
    const amp = freq === 0 ? 0 : (opts.envelope?.(t) ?? 1) * 0.8;
    const sample = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * amp * 32767);
    for (let c = 0; c < channels; c++) v.setInt16(44 + (i * channels + c) * 2, sample, true);
  }
  return new Uint8Array(buf);
}
