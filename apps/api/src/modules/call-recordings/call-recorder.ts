import { WriteStream, createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';

export const RECORDING_SAMPLE_RATE = 16_000;
const SAMPLES_PER_MS = RECORDING_SAMPLE_RATE / 1000;
// Network jitter below this is ignored; a longer gap in a leg's frames is
// written as silence so both legs stay aligned to the call's wall clock.
const MAX_JITTER_SAMPLES = 200 * SAMPLES_PER_MS;
const SILENCE_CHUNK = Buffer.alloc(RECORDING_SAMPLE_RATE * 2);

export type RecordingLeg = 'agent' | 'lead';

class LegTrack {
  samples = 0;
  private readonly stream: WriteStream;

  constructor(readonly path: string) { this.stream = createWriteStream(path); }

  write(pcm: Buffer) {
    this.stream.write(pcm);
    this.samples += Math.floor(pcm.length / 2);
  }

  writeSilence(samples: number) {
    let remaining = samples;
    while (remaining > 0) {
      const chunk = Math.min(remaining, SILENCE_CHUNK.length / 2);
      this.write(SILENCE_CHUNK.subarray(0, chunk * 2));
      remaining -= chunk;
    }
  }

  async close() {
    this.stream.end();
    await finished(this.stream);
  }
}

/**
 * Spools both legs of a call (PCM16 LE mono 16 kHz) to disk from the moment it is answered.
 * Frames carry no timestamps, so each leg is placed by arrival time relative to the start.
 */
export class CallRecorder {
  private readonly tracks: Record<RecordingLeg, LegTrack>;
  private closed = false;

  constructor(spoolPathPrefix: string, private readonly startedAt = Date.now()) {
    this.tracks = { agent: new LegTrack(`${spoolPathPrefix}.agent.pcm`), lead: new LegTrack(`${spoolPathPrefix}.lead.pcm`) };
  }

  append(leg: RecordingLeg, pcm: Buffer, now = Date.now()) {
    if (this.closed) return;
    const track = this.tracks[leg];
    const frameStart = Math.floor((now - this.startedAt) * SAMPLES_PER_MS) - Math.floor(pcm.length / 2);
    const gap = frameStart - track.samples;
    if (gap > MAX_JITTER_SAMPLES) track.writeSilence(gap);
    track.write(pcm);
  }

  /** Stops recording, pads both legs to the same length and returns the duration in seconds. */
  async close() {
    this.closed = true;
    const length = Math.max(this.tracks.agent.samples, this.tracks.lead.samples);
    for (const track of Object.values(this.tracks)) {
      track.writeSilence(length - track.samples);
      await track.close();
    }
    return Math.round(length / RECORDING_SAMPLE_RATE);
  }
}
