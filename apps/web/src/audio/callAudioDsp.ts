/**
 * Call audio DSP, shared by the AudioWorklet processors (callAudio.worklet.ts) and the specs.
 * Nothing here touches the DOM: it runs on the audio rendering thread.
 *
 * The wire format to and from the API is mono PCM16 at 16 kHz.
 */
export const WIRE_RATE = 16000;
/** Waxum/whatsapp-rust accepts exactly 960 mono samples (60 ms) per microphone frame. */
export const MIC_FRAME_SAMPLES = 960;

/** Windowed-sinc (Blackman) low-pass FIR, unity gain at DC. */
export class FirLowpass {
  private readonly taps: Float32Array;
  private readonly history: Float32Array;
  private position = 0;

  constructor(sampleRate: number, cutoffHz: number, tapCount: number) {
    const count = tapCount % 2 === 0 ? tapCount + 1 : tapCount;
    const taps = new Float32Array(count);
    const middle = (count - 1) / 2;
    const normalized = cutoffHz / sampleRate;
    let sum = 0;
    for (let i = 0; i < count; i++) {
      const offset = i - middle;
      const sinc = offset === 0 ? 2 * normalized : Math.sin(2 * Math.PI * normalized * offset) / (Math.PI * offset);
      const window = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (count - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (count - 1));
      taps[i] = sinc * window;
      sum += taps[i];
    }
    for (let i = 0; i < count; i++) taps[i] /= sum;
    this.taps = taps;
    this.history = new Float32Array(count);
  }

  next(sample: number) {
    const { taps, history } = this;
    const length = taps.length;
    history[this.position] = sample;
    let acc = 0;
    let index = this.position;
    for (let i = 0; i < length; i++) {
      acc += taps[i] * history[index];
      index = index === 0 ? length - 1 : index - 1;
    }
    this.position = this.position + 1 === length ? 0 : this.position + 1;
    return acc;
  }
}

/** About 21 taps per 16 kHz of input keeps the transition band near 1 kHz at any device rate. */
function tapsFor(sampleRate: number) {
  return Math.max(15, Math.round((sampleRate / WIRE_RATE) * 21));
}

function toPcm16(sample: number) {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

/**
 * Microphone: device rate -> 16 kHz PCM16 frames of MIC_FRAME_SAMPLES.
 *
 * Low-passes at 7 kHz before resampling. Dropping straight to 16 kHz without it folds everything
 * between 8 and 24 kHz (mic hiss, sibilants, keyboard, fans) back into the voice band, which the
 * customer hears as a metallic hiss.
 */
export class MicDownsampler {
  private readonly filter?: FirLowpass;
  private readonly step: number;
  /** Position of the next output sample, in input samples relative to `previous`. */
  private cursor = 0;
  private previous = 0;
  private frame = new Int16Array(MIC_FRAME_SAMPLES);
  private filled = 0;

  constructor(inputRate: number, private readonly onFrame: (frame: Int16Array) => void) {
    this.step = inputRate / WIRE_RATE;
    if (inputRate !== WIRE_RATE) this.filter = new FirLowpass(inputRate, 7000, tapsFor(inputRate));
  }

  /** Muted input still advances the clock, so the stream to the customer stays real time. */
  process(input: Float32Array, muted: boolean) {
    for (let i = 0; i < input.length; i++) {
      const raw = muted ? 0 : input[i];
      const current = this.filter ? this.filter.next(raw) : raw;
      // Emit every output instant that falls between the previous and the current input sample.
      while (this.cursor <= 1) {
        this.emit(this.previous + (current - this.previous) * this.cursor);
        this.cursor += this.step;
      }
      this.cursor -= 1;
      this.previous = current;
    }
  }

  private emit(sample: number) {
    this.frame[this.filled++] = toPcm16(sample);
    if (this.filled < MIC_FRAME_SAMPLES) return;
    this.onFrame(this.frame);
    this.frame = new Int16Array(MIC_FRAME_SAMPLES);
    this.filled = 0;
  }
}

export type PlayoutStats = {
  /** 16 kHz samples handed to the buffer. */
  received: number;
  /** 16 kHz samples consumed (played or skipped while catching up). */
  played: number;
  /** 16 kHz samples thrown away because the buffer overflowed its ceiling. */
  skipped: number;
  /** Times the buffer ran dry mid-call and playout had to wait for the cushion again. */
  underruns: number;
  /** 16 kHz samples waiting right now. */
  depth: number;
};

export type PlayoutOptions = {
  /** Cushion to build before playing, at the start and after every underrun. */
  targetSeconds: number;
  /** Above target plus this, play up to 4% faster until the excess is gone. */
  slackSeconds: number;
  /** Hard ceiling: beyond it, jump back to the target (a burst that would otherwise lag the call). */
  maxSeconds: number;
  /** Fade length at every stop and start, so a gap is a dip instead of a click. */
  fadeSeconds: number;
};

/**
 * Customer audio: 16 kHz PCM16 in, device-rate float out, on the audio thread.
 *
 * Replaces scheduling one AudioBufferSourceNode per 20 ms frame. That design restarted with only
 * 40 ms of cushion after each underrun, so the next late packet caused another gap, and when the
 * late packets landed together it dropped 80 ms or more of speech at a hard splice. Here the
 * cushion is rebuilt to the target after a gap, both edges of a gap are faded, and an excess
 * backlog is drained by playing slightly faster instead of cutting words.
 */
export class Playout {
  private readonly buffer: Float32Array;
  private readonly capacity: number;
  private readonly step: number;
  private readonly target: number;
  private readonly slack: number;
  private readonly max: number;
  private readonly fadeStep: number;
  private readonly fadeWire: number;
  private readonly smoother: FirLowpass;
  private written = 0;
  private readPosition = 0;
  private priming = true;
  private gain = 0;
  private readonly stats: PlayoutStats = { received: 0, played: 0, skipped: 0, underruns: 0, depth: 0 };

  constructor(outputRate: number, options: PlayoutOptions = { targetSeconds: 0.1, slackSeconds: 0.06, maxSeconds: 0.5, fadeSeconds: 0.004 }) {
    this.step = WIRE_RATE / outputRate;
    this.target = Math.round(options.targetSeconds * WIRE_RATE);
    this.slack = Math.round(options.slackSeconds * WIRE_RATE);
    this.max = Math.round(options.maxSeconds * WIRE_RATE);
    this.fadeWire = Math.max(2, Math.round(options.fadeSeconds * WIRE_RATE));
    this.fadeStep = 1 / Math.max(1, options.fadeSeconds * outputRate);
    this.capacity = this.max * 2 + WIRE_RATE;
    this.buffer = new Float32Array(this.capacity);
    // Linear interpolation from 16 kHz leaves images above 8 kHz; filter them out of the output.
    this.smoother = new FirLowpass(outputRate, 7500, tapsFor(outputRate));
  }

  private get available() {
    return this.written - this.readPosition;
  }

  push(pcm: Int16Array) {
    for (let i = 0; i < pcm.length; i++) {
      this.buffer[(this.written + i) % this.capacity] = pcm[i] / 0x8000;
    }
    this.written += pcm.length;
    this.stats.received += pcm.length;
    if (this.available > this.max) {
      const jump = this.available - this.target;
      this.readPosition += jump;
      this.stats.skipped += Math.floor(jump);
      this.gain = 0;
    }
  }

  render(out: Float32Array) {
    for (let i = 0; i < out.length; i++) {
      let sample = 0;
      if (this.priming && this.available >= this.target) this.priming = false;
      if (!this.priming) {
        if (this.available < 2) {
          this.priming = true;
          this.stats.underruns += 1;
          this.gain = 0;
        } else {
          const wanted = this.available > this.fadeWire + 1 ? 1 : 0;
          this.gain = wanted > this.gain ? Math.min(1, this.gain + this.fadeStep) : Math.max(0, this.gain - this.fadeStep);
          const index = Math.floor(this.readPosition);
          const fraction = this.readPosition - index;
          const current = this.buffer[index % this.capacity];
          const next = this.buffer[(index + 1) % this.capacity];
          sample = (current + (next - current) * fraction) * this.gain;
          const excess = this.available - this.target - this.slack;
          const rate = excess > 0 ? 1 + Math.min(0.04, (excess / this.slack) * 0.04) : 1;
          const advance = this.step * rate;
          this.readPosition += advance;
          this.stats.played += advance;
        }
      }
      out[i] = this.smoother.next(sample);
    }
  }

  snapshot(): PlayoutStats {
    return { ...this.stats, played: Math.floor(this.stats.played), depth: Math.max(0, Math.floor(this.available)) };
  }
}
