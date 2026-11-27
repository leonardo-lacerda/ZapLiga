/**
 * AudioWorklet processors for calls. They run on the browser's audio thread, so a busy page (a
 * React re-render, a slow request handler) can no longer starve the microphone or the playout the
 * way the old main-thread ScriptProcessor did.
 *
 * Loaded by AudioBridge with `audioWorklet.addModule`. Messages:
 * - zapliga-playout: in, ArrayBuffer of 16 kHz PCM16, or { type: 'source', port } whose messages are
 *   such buffers (the audio worker's port, which bypasses the page); out, { type: 'stats', ...PlayoutStats }
 *   about once a second.
 * - zapliga-capture: in, { type: 'mute', muted }, or { type: 'sink', port } to send the frames there (the
 *   audio worker) instead of to the page; out, ArrayBuffer frames of 960 16 kHz PCM16 samples.
 */
import { MicDownsampler, Playout } from './callAudioDsp';

declare const sampleRate: number;
declare function registerProcessor(name: string, processor: new () => WorkletProcessor): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
type WorkletProcessor = AudioWorkletProcessor & {
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
};

const STATS_INTERVAL_BLOCKS = Math.round(sampleRate / 128);

class PlayoutProcessor extends AudioWorkletProcessor {
  private readonly playout = new Playout(sampleRate);
  private blocks = 0;

  constructor() {
    super();
    const push = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) this.playout.push(new Int16Array(event.data));
    };
    this.port.onmessage = (event: MessageEvent) => {
      if (event.data?.type === 'source') (event.data.port as MessagePort).onmessage = push;
      else push(event);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const channels = outputs[0];
    if (channels?.[0]) {
      this.playout.render(channels[0]);
      for (let channel = 1; channel < channels.length; channel++) channels[channel].set(channels[0]);
    }
    this.blocks += 1;
    if (this.blocks >= STATS_INTERVAL_BLOCKS) {
      this.blocks = 0;
      this.port.postMessage({ type: 'stats', ...this.playout.snapshot() });
    }
    return true;
  }
}

class CaptureProcessor extends AudioWorkletProcessor {
  private muted = false;
  private sink?: MessagePort;
  private readonly downsampler = new MicDownsampler(sampleRate, (frame) => {
    (this.sink ?? this.port).postMessage(frame.buffer, [frame.buffer]);
  });
  private readonly silence = new Float32Array(128);

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      if (event.data?.type === 'mute') this.muted = Boolean(event.data.muted);
      if (event.data?.type === 'sink') this.sink = event.data.port as MessagePort;
    };
  }

  process(inputs: Float32Array[][]) {
    // A track that is disabled or not yet delivering gives no channels: keep the clock running.
    this.downsampler.process(inputs[0]?.[0] ?? this.silence, this.muted);
    return true;
  }
}

registerProcessor('zapliga-playout', PlayoutProcessor);
registerProcessor('zapliga-capture', CaptureProcessor);
