import { WhisperSegment } from './call-transcript';

const GROQ_TRANSCRIPTIONS_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const REQUEST_TIMEOUT_MS = 120_000;

export class GroqRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) { super(`Groq rate limit, retry in ${retryAfterSeconds}s`); }
}

/** Whisper on Groq (OpenAI-compatible). Free plan: 20 req/min, 2h of audio/hour, 8h/day, 25 MB per file. */
export async function transcribeWithGroq(audio: Buffer, fileName: string): Promise<WhisperSegment[]> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not configured');
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/ogg' }), fileName);
  form.append('model', process.env.GROQ_TRANSCRIPTION_MODEL || 'whisper-large-v3');
  form.append('language', 'pt');
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  if (process.env.GROQ_TRANSCRIPTION_PROMPT) form.append('prompt', process.env.GROQ_TRANSCRIPTION_PROMPT);
  const response = await fetch(GROQ_TRANSCRIPTIONS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 429) throw new GroqRateLimitError(Math.max(1, Math.ceil(Number(response.headers.get('retry-after')) || 60)));
  if (!response.ok) throw new Error(`Groq HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const body = await response.json() as { segments?: WhisperSegment[] };
  return body.segments ?? [];
}
