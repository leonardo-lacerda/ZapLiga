import { condense, legSegments, mergeLegs, originalTime, speechRegions, transcriptText } from './call-transcript';

const SECOND = 16_000;
// PCM16 with `seconds` of a loud square wave or silence.
const audio = (...parts: [number, boolean][]) => Buffer.concat(parts.map(([seconds, loud]) => {
  const buffer = Buffer.alloc(Math.round(seconds * SECOND) * 2);
  if (loud) for (let index = 0; index < buffer.length / 2; index += 1) buffer.writeInt16LE(index % 32 < 16 ? 3000 : -3000, index * 2);
  return buffer;
}));

describe('call transcript', () => {
  it('finds speech, merges short pauses and drops long silences', () => {
    const pcm = audio([2, false], [1, true], [0.5, false], [1, true], [5, false], [1, true], [1, false]);
    const regions = speechRegions(pcm);
    expect(regions).toHaveLength(2);
    expect(regions[0].start / SECOND).toBeCloseTo(1.7, 1);
    expect(regions[0].end / SECOND).toBeCloseTo(4.8, 1);
    expect(regions[1].start / SECOND).toBeCloseTo(9.2, 1);
  });

  it('maps times of the condensed audio back to the call timeline', () => {
    const pcm = audio([10, false], [2, true], [20, false], [3, true], [5, false]);
    const condensed = condense(pcm, speechRegions(pcm));
    // 2.6 s of speech, 0.5 s join silence, then the second region.
    expect(condensed.pcm.length / 2 / SECOND).toBeCloseTo(2.6 + 0.5 + 3.6, 1);
    expect(originalTime(condensed.map, 0)).toBeCloseTo(9.7, 1);
    expect(originalTime(condensed.map, 3.2)).toBeCloseTo(31.8, 1);
  });

  it('drops non-speech segments and orders both legs as a dialogue', () => {
    const map = [{ from: 0, to: 100, offset: 0 }];
    const agent = legSegments('agent', [{ start: 0, end: 2, text: ' Oi, tudo bem? ' }, { start: 5, end: 6, text: 'Legendas pela comunidade Amara.org', no_speech_prob: 0.9 }], map);
    const lead = legSegments('lead', [{ start: 2.5, end: 3, text: 'Tudo, e você?' }], map);
    const segments = mergeLegs(agent, lead);
    expect(transcriptText(segments)).toBe('[0:00] Vendedor: Oi, tudo bem?\n[0:02] Lead: Tudo, e você?');
  });
});
