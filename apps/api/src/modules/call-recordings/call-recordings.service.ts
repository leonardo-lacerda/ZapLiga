import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseService } from '../../database/database.service';
import { Sentry } from '../../infrastructure/sentry/sentry';
import { CrmEventsService } from '../crm-events/crm-events.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { CallRecorder, RECORDING_SAMPLE_RATE } from './call-recorder';
import { Speaker, condense, legSegments, mergeLegs, speechRegions, transcriptText } from './call-transcript';
import { GroqRateLimitError, transcribeWithGroq } from './groq-transcription.client';

const execFileAsync = promisify(execFile);
const MAX_ATTEMPTS = 10;
const LEASE_SECONDS = 600;
const MAX_DECODED_BYTES = 512 * 1024 * 1024;
const PCM_ARGS = ['-f', 's16le', '-ar', String(RECORDING_SAMPLE_RATE), '-ac', '1'];
// Left channel = SDR, right channel = lead.
const CHANNELS: Record<Speaker, string> = { agent: 'c0', lead: 'c1' };

/** Backoff between attempts: 1, 2, 4 ... capped at 60 minutes. */
export const recordingRetryDelaySeconds = (attempt: number) => Math.min(3600, 60 * 2 ** Math.max(0, attempt - 1));

export const recordingRelativePath = (tenantId: string, callId: string, createdAt: Date) =>
  join(tenantId, createdAt.toISOString().slice(0, 7), `${callId}.ogg`);

type RecordingRow = { call_id: string; tenant_id: string; status: string; duration_seconds: number; file_path: string | null; attempts: number; created_at: Date };

/**
 * Records answered calls of tenants with `call_recording` on and transcribes them with Whisper on Groq.
 * Both legs are spooled during the call; afterwards a worker merges them into a stereo Ogg/Opus
 * (left = SDR, right = lead) kept on the local recordings volume, then transcribes each leg.
 */
@Injectable()
export class CallRecordingsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CallRecordingsService.name);
  private readonly dir = process.env.CALL_RECORDING_DIR || '/var/lib/zapliga/recordings';
  private readonly spoolDir = join(this.dir, 'spool');
  private readonly minTranscriptSeconds = Number(process.env.CALL_TRANSCRIPTION_MIN_SECONDS ?? 15);
  private timer?: NodeJS.Timeout;
  private processing = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly featureFlags: FeatureFlagsService,
    @Optional() private readonly crmEvents?: CrmEventsService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.processDue(), 10_000);
    this.timer.unref?.();
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  enabled(tenantId: string) { return this.featureFlags.enabled(tenantId, 'call_recording'); }

  start(callId: string) {
    mkdirSync(this.spoolDir, { recursive: true });
    return new CallRecorder(join(this.spoolDir, callId));
  }

  async complete(callId: string, tenantId: string, recorder: CallRecorder) {
    const durationSeconds = await recorder.close();
    await this.db.query(`INSERT INTO call_recordings (call_id, tenant_id, duration_seconds) VALUES ($1, $2, $3) ON CONFLICT (call_id) DO NOTHING`,
      [callId, tenantId, durationSeconds]);
  }

  /** Absolute path of a stored recording, or null when the call has none (yet). */
  async filePath(tenantId: string, callId: string) {
    const row = (await this.db.query(`SELECT file_path FROM call_recordings WHERE tenant_id = $1 AND call_id = $2 AND status = 'stored'`, [tenantId, callId])).rows[0];
    return row ? join(this.dir, row.file_path) : null;
  }

  async processDue() {
    if (this.processing) return;
    this.processing = true;
    try {
      for (let row = await this.claim(); row; row = await this.claim()) await this.process(row);
    } catch (error) {
      this.logger.error(`Call recording worker failed: ${String(error instanceof Error ? error.message : error)}`);
    } finally {
      this.processing = false;
    }
  }

  private async claim(): Promise<RecordingRow | undefined> {
    const result = await this.db.query(`UPDATE call_recordings SET locked_until = now() + ($1::int * interval '1 second')
      WHERE call_id = (
        SELECT call_id FROM call_recordings
        WHERE (status = 'pending' OR (status = 'stored' AND transcript_status = 'pending'))
          AND next_attempt_at <= now() AND (locked_until IS NULL OR locked_until < now())
        ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING call_id, tenant_id, status, duration_seconds, file_path, attempts, created_at`, [LEASE_SECONDS]);
    return result.rows[0];
  }

  private async process(row: RecordingRow) {
    try {
      if (row.status === 'pending') await this.store(row);
      else await this.transcribe(row);
    } catch (error) {
      if (error instanceof GroqRateLimitError) {
        // Quota, not a failure: wait as long as Groq asks without spending an attempt.
        await this.db.query(`UPDATE call_recordings SET locked_until = NULL, next_attempt_at = now() + ($2::int * interval '1 second'), updated_at = now() WHERE call_id = $1`,
          [row.call_id, error.retryAfterSeconds]);
        return;
      }
      const attempt = Number(row.attempts) + 1;
      const message = String(error instanceof Error ? error.message : error).slice(0, 500);
      this.logger.warn(`Recording ${row.call_id} (${row.status}) failed, attempt ${attempt}: ${message}`);
      if (attempt >= MAX_ATTEMPTS) Sentry.captureException(error);
      const failedColumn = row.status === 'pending' ? 'status' : 'transcript_status';
      await this.db.query(`UPDATE call_recordings SET attempts = $2::int, last_error = $3, locked_until = NULL,
        ${failedColumn} = CASE WHEN $2::int >= $4::int THEN 'failed' ELSE ${failedColumn} END,
        next_attempt_at = now() + ($5::int * interval '1 second'), updated_at = now() WHERE call_id = $1`,
      [row.call_id, attempt, message, MAX_ATTEMPTS, recordingRetryDelaySeconds(attempt)]);
    }
  }

  private async store(row: RecordingRow) {
    const spool = join(this.spoolDir, row.call_id);
    const relativePath = recordingRelativePath(row.tenant_id, row.call_id, new Date(row.created_at));
    const output = join(this.dir, relativePath);
    await mkdir(dirname(output), { recursive: true });
    await execFileAsync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y',
      ...PCM_ARGS, '-i', `${spool}.agent.pcm`, ...PCM_ARGS, '-i', `${spool}.lead.pcm`,
      '-filter_complex', '[0:a][1:a]amerge=inputs=2[a]', '-map', '[a]',
      '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', output]);
    const { size } = await stat(output);
    const transcriptStatus = row.duration_seconds >= this.minTranscriptSeconds ? 'pending' : 'skipped';
    await this.db.query(`UPDATE call_recordings SET status = 'stored', file_path = $2, size_bytes = $3, stored_at = now(), transcript_status = $4,
      attempts = 0, last_error = NULL, locked_until = NULL, next_attempt_at = now(), updated_at = now() WHERE call_id = $1`,
    [row.call_id, relativePath, size, transcriptStatus]);
    await Promise.all([`${spool}.agent.pcm`, `${spool}.lead.pcm`].map((path) => rm(path, { force: true })));
  }

  private async transcribe(row: RecordingRow) {
    const source = join(this.dir, row.file_path!);
    const legs = [];
    for (const speaker of Object.keys(CHANNELS) as Speaker[]) legs.push(await this.transcribeLeg(row.call_id, source, speaker));
    const segments = mergeLegs(...legs);
    const transcript = { language: 'pt', segments, text: transcriptText(segments) };
    await this.db.query(`UPDATE call_recordings SET transcript_status = 'done', transcript = $2::jsonb, transcribed_at = now(),
      attempts = 0, last_error = NULL, locked_until = NULL, updated_at = now() WHERE call_id = $1`, [row.call_id, JSON.stringify(transcript)]);
    await this.crmEvents?.recordCall(row.tenant_id, row.call_id, 'call.transcribed', {
      recording: { duration_seconds: row.duration_seconds, audio_path: `/api/v1/integrations/calls/${row.call_id}/recording` },
      transcript,
    });
  }

  /** Sends only the speech of one leg to Whisper and maps the segments back to the call's timeline. */
  private async transcribeLeg(callId: string, source: string, speaker: Speaker) {
    const { stdout } = await execFileAsync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', source,
      '-af', `pan=mono|c0=${CHANNELS[speaker]}`, ...PCM_ARGS, '-'], { encoding: 'buffer', maxBuffer: MAX_DECODED_BYTES });
    const regions = speechRegions(stdout);
    if (!regions.length) return [];
    const condensed = condense(stdout, regions);
    const base = join(this.spoolDir, `${callId}.${speaker}.speech`);
    await mkdir(this.spoolDir, { recursive: true });
    try {
      await writeFile(`${base}.pcm`, condensed.pcm);
      await execFileAsync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', ...PCM_ARGS, '-i', `${base}.pcm`, '-c:a', 'libopus', '-b:a', '24k', '-application', 'voip', `${base}.ogg`]);
      const segments = await transcribeWithGroq(await readFile(`${base}.ogg`), `${callId}-${speaker}.ogg`);
      return legSegments(speaker, segments, condensed.map);
    } finally {
      await Promise.all([`${base}.pcm`, `${base}.ogg`].map((path) => rm(path, { force: true })));
    }
  }
}
