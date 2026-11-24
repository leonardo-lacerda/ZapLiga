import { MIC_FRAME_SAMPLES, MicDownsampler, Playout, WIRE_RATE } from './callAudioDsp';

const DEVICE_RATE = 48000;

function sine(frequency: number, rate: number, samples: number, amplitude = 0.5, phase = 0) {
  return Float32Array.from({ length: samples }, (_, i) => amplitude * Math.sin((2 * Math.PI * frequency * (i + phase)) / rate));
}

function rms(values: ArrayLike<number>, from = 0) {
  let sum = 0;
  for (let i = from; i < values.length; i++) sum += values[i] * values[i];
  return Math.sqrt(sum / (values.length - from));
}

function captureAll(rate: number, input: Float32Array, muted = false) {
  const frames: Int16Array[] = [];
  const downsampler = new MicDownsampler(rate, (frame) => frames.push(frame));
  for (let i = 0; i < input.length; i += 128) downsampler.process(input.subarray(i, i + 128), muted);
  const samples = new Int16Array(frames.length * MIC_FRAME_SAMPLES);
  frames.forEach((frame, index) => samples.set(frame, index * MIC_FRAME_SAMPLES));
  return { frames, samples: Float32Array.from(samples, (value) => value / 0x8000) };
}

function wireFrame(start: number, frequency = 440) {
  return Int16Array.from({ length: 320 }, (_, i) => Math.round(0.5 * 0x7fff * Math.sin((2 * Math.PI * frequency * (start + i)) / WIRE_RATE)));
}

describe('MicDownsampler', () => {
  it('produces 960-sample frames in real time, muted or not', () => {
    expect(captureAll(DEVICE_RATE, new Float32Array(DEVICE_RATE)).frames.length).toBe(16);
    expect(captureAll(44100, new Float32Array(44100), true).frames.length).toBe(16);
    expect(captureAll(DEVICE_RATE, sine(1000, DEVICE_RATE, DEVICE_RATE)).frames.every((frame) => frame.length === MIC_FRAME_SAMPLES)).toBe(true);
  });

  it('keeps the voice band', () => {
    const { samples } = captureAll(DEVICE_RATE, sine(1000, DEVICE_RATE, DEVICE_RATE));
    expect(rms(samples, 1000)).toBeGreaterThan(0.5 / Math.SQRT2 * 0.95);
  });

  it('removes what would fold back into the voice band as hiss', () => {
    // 12 kHz at 48 kHz decimated to 16 kHz without a filter lands at 4 kHz at full level.
    for (const rate of [DEVICE_RATE, 44100]) {
      const { samples } = captureAll(rate, sine(12000, rate, rate));
      expect(rms(samples, 1000)).toBeLessThan(0.5 / Math.SQRT2 * 0.02);
    }
  });
});

describe('Playout', () => {
  function run(schedule: Array<'frame' | 'gap'>, playout = new Playout(DEVICE_RATE)) {
    const output: number[] = [];
    const block = new Float32Array(128);
    let written = 0;
    let rendered = 0;
    schedule.forEach((step, index) => {
      if (step === 'frame') { playout.push(wireFrame(written)); written += 320; }
      // Each step is 20 ms of wall clock: render the output that came due in it.
      const due = (index + 1) * DEVICE_RATE * 0.02;
      while (rendered < due) { playout.render(block); output.push(...block); rendered += 128; }
    });
    return { playout, output: Float32Array.from(output) };
  }

  function largestJump(output: Float32Array) {
    let jump = 0;
    for (let i = 1; i < output.length; i++) jump = Math.max(jump, Math.abs(output[i] - output[i - 1]));
    return jump;
  }

  it('plays a steady stream without gaps', () => {
    const { playout } = run(Array(250).fill('frame'));
    expect(playout.snapshot().underruns).toBe(0);
    expect(playout.snapshot().skipped).toBe(0);
  });

  it('rides out a late packet that used to cause a gap', () => {
    // 60 ms without audio and then the late frames together: the 100 ms cushion absorbs it.
    const schedule: Array<'frame' | 'gap'> = [...Array(50).fill('frame'), 'gap', 'gap', 'gap', 'frame', 'frame', 'frame', 'frame', ...Array(50).fill('frame')];
    const { playout } = run(schedule);
    expect(playout.snapshot().underruns).toBe(0);
    expect(playout.snapshot().skipped).toBe(0);
  });

  it('fades out and back in around a long gap instead of clicking', () => {
    const schedule: Array<'frame' | 'gap'> = [...Array(50).fill('frame'), ...Array(15).fill('gap'), ...Array(50).fill('frame')];
    const { playout, output } = run(schedule);
    expect(playout.snapshot().underruns).toBe(1);
    // A 440 Hz sine at 0.5 moves at most ~0.03 per 48 kHz sample; a hard cut would jump ~0.5.
    expect(largestJump(output)).toBeLessThan(0.06);
  });

  it('bounds the delay after a burst', () => {
    const playout = new Playout(DEVICE_RATE);
    for (let i = 0; i < 100; i++) playout.push(wireFrame(i * 320));
    expect(playout.snapshot().depth).toBeLessThanOrEqual(0.5 * WIRE_RATE);
    expect(playout.snapshot().skipped).toBeGreaterThan(0);
  });

  it('drains a backlog by playing slightly faster', () => {
    const playout = new Playout(DEVICE_RATE);
    for (let i = 0; i < 15; i++) playout.push(wireFrame(i * 320)); // 300 ms queued
    const schedule: Array<'frame' | 'gap'> = Array(400).fill('frame');
    run(schedule, playout);
    expect(playout.snapshot().depth).toBeLessThan(0.18 * WIRE_RATE);
    expect(playout.snapshot().skipped).toBe(0);
  });
});
