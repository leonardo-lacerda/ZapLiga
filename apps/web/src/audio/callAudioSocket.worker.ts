/**
 * Call audio transport, off the page's main thread.
 *
 * The page re-renders on every dialer log line and every operations event of the whole team. When
 * the call audio rode the page's control socket, each of those renders held the customer's frames
 * and the SDR's microphone frames back, and they then arrived in a burst: the SDR heard a gap and
 * so did the customer. This worker owns a socket that carries only the call audio and talks to the
 * playout and capture worklets through their own MessagePorts, so audio never waits on the page.
 *
 * In: { type: 'open', url, playout: MessagePort, capture: MessagePort }, { type: 'capture', port }.
 * Out: { type: 'inbound', frames, peak } about every 250 ms; { type: 'mic', frame } while the socket
 * is not open, for the page to send on the control socket instead; { type: 'closed', code }.
 */
const REPORT_INTERVAL_MS = 250;

const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
};

let socket: WebSocket | undefined;
let playout: MessagePort | undefined;
let inboundFrames = 0;
let peak = 0;

function frameFromMicrophone(event: MessageEvent) {
  if (!(event.data instanceof ArrayBuffer)) return;
  if (socket?.readyState === WebSocket.OPEN) socket.send(event.data);
  else scope.postMessage({ type: 'mic', frame: event.data }, [event.data]);
}

function frameFromServer(data: ArrayBuffer) {
  if (data.byteLength < 2) return;
  const samples = new Int16Array(data, 0, data.byteLength >> 1);
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] < 0 ? -samples[i] : samples[i];
    if (value > peak) peak = value;
  }
  inboundFrames += 1;
  playout?.postMessage(data, [data]);
}

setInterval(() => {
  if (inboundFrames === 0) return;
  scope.postMessage({ type: 'inbound', frames: inboundFrames, peak });
  inboundFrames = 0;
  peak = 0;
}, REPORT_INTERVAL_MS);

scope.onmessage = (event: MessageEvent) => {
  const message = event.data;
  if (message?.type === 'capture') {
    (message.port as MessagePort).onmessage = frameFromMicrophone;
    return;
  }
  if (message?.type !== 'open' || socket) return;
  playout = message.playout as MessagePort;
  (message.capture as MessagePort).onmessage = frameFromMicrophone;
  socket = new WebSocket(String(message.url));
  socket.binaryType = 'arraybuffer';
  socket.onmessage = (incoming) => { if (incoming.data instanceof ArrayBuffer) frameFromServer(incoming.data); };
  socket.onclose = (closed) => scope.postMessage({ type: 'closed', code: closed.code });
};
export {};
