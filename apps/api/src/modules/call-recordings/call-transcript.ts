import { RECORDING_SAMPLE_RATE } from './call-recorder';

const FRAME_SAMPLES = 480; // 30 ms
// About -44 dBFS: the browser mic and WhatsApp both suppress noise, so the floor between words is well below this.
const SPEECH_RMS = 200;
const PAD_SAMPLES = Math.round(0.3 * RECORDING_SAMPLE_RATE);
const MERGE_GAP_SAMPLES = Math.round(1.5 * RECORDING_SAMPLE_RATE);
const JOIN_SILENCE_SAMPLES = Math.round(0.5 * RECORDING_SAMPLE_RATE);
// Whisper invents text over silence ("Legendas pela comunidade Amara.org"); drop segments it marks as non-speech.
const MAX_NO_SPEECH_PROB = 0.6;

export type Speaker = 'agent' | 'lead';
export type SpeechRegion = { start: number; end: number };
export type CondensedAudio = { pcm: Buffer; map: { from: number; to: number; offset: number }[] };
export type WhisperSegment = { start: number; end: number; text: string; no_speech_prob?: number };
export type TranscriptSegment = { speaker: Speaker; start: number; end: number; text: string };

/** Sample ranges of one leg (PCM16 LE mono 16 kHz) that contain speech, padded and merged. */
export function speechRegions(pcm: Buffer): SpeechRegion[] {
  const total = Math.floor(pcm.length / 2);
  const regions: SpeechRegion[] = [];
  for (let frame = 0; frame < total; frame += FRAME_SAMPLES) {
    const end = Math.min(total, frame + FRAME_SAMPLES);
    let energy = 0;
    for (let index = frame; index < end; index += 1) energy += pcm.readInt16LE(index * 2) ** 2;
    if (Math.sqrt(energy / (end - frame)) < SPEECH_RMS) continue;
    const start = Math.max(0, frame - PAD_SAMPLES);
    const padded = Math.min(total, end + PAD_SAMPLES);
    const last = regions[regions.length - 1];
    if (last && start - last.end <= MERGE_GAP_SAMPLES) last.end = padded;
    else regions.push({ start, end: padded });
  }
  return regions;
}

/**
 * Joins the speech regions with short silences between them, so Whisper is billed only for
 * speech, and keeps the map back to the call's timeline (in seconds).
 */
export function condense(pcm: Buffer, regions: SpeechRegion[]): CondensedAudio {
  const parts: Buffer[] = [];
  const map: CondensedAudio['map'] = [];
  const silence = Buffer.alloc(JOIN_SILENCE_SAMPLES * 2);
  let position = 0;
  for (const region of regions) {
    if (parts.length) { parts.push(silence); position += JOIN_SILENCE_SAMPLES; }
    const length = region.end - region.start;
    parts.push(pcm.subarray(region.start * 2, region.end * 2));
    map.push({ from: position / RECORDING_SAMPLE_RATE, to: (position + length) / RECORDING_SAMPLE_RATE, offset: (region.start - position) / RECORDING_SAMPLE_RATE });
    position += length;
  }
  return { pcm: Buffer.concat(parts), map };
}

/** Converts a time in the condensed audio back to the call's timeline. */
export function originalTime(map: CondensedAudio['map'], seconds: number) {
  const entry = map.find((item) => seconds < item.to) ?? map[map.length - 1];
  return entry ? Math.round((Math.max(seconds, entry.from) + entry.offset) * 100) / 100 : seconds;
}

export function legSegments(speaker: Speaker, segments: WhisperSegment[], map: CondensedAudio['map']): TranscriptSegment[] {
  return segments
    .filter((segment) => (segment.no_speech_prob ?? 0) <= MAX_NO_SPEECH_PROB && segment.text.trim())
    .map((segment) => ({ speaker, start: originalTime(map, segment.start), end: originalTime(map, segment.end), text: segment.text.trim() }));
}

export const mergeLegs = (...legs: TranscriptSegment[][]) => legs.flat().sort((a, b) => a.start - b.start);

const SPEAKER_LABEL: Record<Speaker, string> = { agent: 'Vendedor', lead: 'Lead' };
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export const transcriptText = (segments: TranscriptSegment[]) =>
  segments.map((segment) => `[${clock(segment.start)}] ${SPEAKER_LABEL[segment.speaker]}: ${segment.text}`).join('\n');
