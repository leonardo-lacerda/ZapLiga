import { StringCodec } from 'nats';
import { WaxumClient } from './waxum.client';

const codec = StringCodec();
const event = (callId: string, action: string) => ({ data: codec.encode(JSON.stringify({ event: 'incoming_call', data: { call_id: callId, action } })) });

const clientWith = (messages: Array<{ data: Uint8Array }>) => {
  const client = new WaxumClient({} as any);
  const subscription = { unsubscribe: jest.fn(), async *[Symbol.asyncIterator]() { yield* messages; } };
  jest.spyOn(client as any, 'getNatsConnection').mockResolvedValue({ subscribe: jest.fn().mockReturnValue(subscription) });
  return client;
};

describe('WaxumClient.waitForOutgoingAnswer', () => {
  it('reports the ringing phone on PreAccept and resolves on Accept', async () => {
    const onRinging = jest.fn();
    const client = clientWith([
      event('other', 'PreAccept { call_id: "other" }'),
      event('wa-1', 'PreAccept { call_id: "wa-1", audio: [] }'),
      event('wa-1', 'Accept { call_id: "wa-1", audio: [] }'),
    ]);
    await expect(client.waitForOutgoingAnswer('session', 'wa-1', new AbortController().signal, onRinging)).resolves.toBe(true);
    expect(onRinging).toHaveBeenCalledTimes(1);
  });

  it('does not treat PreAccept as an answer', async () => {
    const onRinging = jest.fn();
    const client = clientWith([event('wa-1', 'PreAccept { call_id: "wa-1" }')]);
    await expect(client.waitForOutgoingAnswer('session', 'wa-1', new AbortController().signal, onRinging)).resolves.toBe(false);
    expect(onRinging).toHaveBeenCalledTimes(1);
  });
});
