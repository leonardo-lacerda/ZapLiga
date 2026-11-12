import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CallRecorder } from './call-recorder';
import { recordingRelativePath, recordingRetryDelaySeconds } from './call-recordings.service';

// 20 ms of PCM16 at 16 kHz.
const frame = (value: number) => {
  const buffer = Buffer.alloc(640);
  for (let offset = 0; offset < buffer.length; offset += 2) buffer.writeInt16LE(value, offset);
  return buffer;
};

describe('CallRecorder', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'recorder-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps both legs aligned to the call clock and pads them to the same length', async () => {
    const recorder = new CallRecorder(join(dir, 'call'), 0);
    recorder.append('lead', frame(100), 20);
    recorder.append('lead', frame(100), 40);
    // The agent only starts talking one second in: the gap becomes silence.
    recorder.append('agent', frame(200), 1020);

    expect(await recorder.close()).toBe(1);
    const lead = readFileSync(join(dir, 'call.lead.pcm'));
    const agent = readFileSync(join(dir, 'call.agent.pcm'));
    expect(lead.length).toBe(agent.length);
    expect(agent.readInt16LE(0)).toBe(0);
    expect(agent.readInt16LE(16_000 * 2)).toBe(200);
    expect(lead.readInt16LE(0)).toBe(100);
    expect(lead.readInt16LE(lead.length - 2)).toBe(0);
  });

  it('ignores jitter shorter than 200 ms and frames after close', async () => {
    const recorder = new CallRecorder(join(dir, 'call'), 0);
    recorder.append('lead', frame(100), 150);
    await recorder.close();
    recorder.append('lead', frame(100), 300);
    expect(readFileSync(join(dir, 'call.lead.pcm')).length).toBe(640);
  });
});

describe('call recording storage', () => {
  it('groups objects by tenant and month', () => {
    expect(recordingRelativePath('t1', 'c1', new Date('2026-11-12T10:00:00Z'))).toBe('t1/2026-11/c1.ogg');
  });

  it('backs off up to one hour', () => {
    expect(recordingRetryDelaySeconds(1)).toBe(60);
    expect(recordingRetryDelaySeconds(3)).toBe(240);
    expect(recordingRetryDelaySeconds(10)).toBe(3600);
  });
});
