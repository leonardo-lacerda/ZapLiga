import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { connect, StringCodec } from 'nats';

const port = Number(process.env.PORT ?? 3451);
const sessions = new Map();
const json = (response, status, payload) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(payload)); };
const readBody = async (request) => { const chunks = []; for await (const chunk of request) chunks.push(chunk); try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; } };

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/' || url.pathname === '/livez') return json(response, 200, { ok: true, service: 'fake-waxum' });
  if (request.method === 'POST' && url.pathname === '/api/v1/sessions') {
    const body = await readBody(request); const id = `fake-${randomUUID()}`;
    const session = { id, name: String(body.name ?? 'CI'), status: 'connected', phone_number: '5511999999999' };
    sessions.set(id, session); return json(response, 201, { session });
  }
  const match = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)(.*)$/);
  if (!match) return json(response, 404, { error: 'not_found' });
  const id = decodeURIComponent(match[1]); const suffix = match[2];
  if (!sessions.has(id)) return json(response, 404, { error: 'session_not_found' });
  if (request.method === 'DELETE' && suffix === '') { sessions.delete(id); return json(response, 200, { ok: true }); }
  if (request.method === 'GET' && suffix === '/status') return json(response, 200, { status: 'connected', connected: true, phone_number: sessions.get(id).phone_number, session: sessions.get(id) });
  if (request.method === 'GET' && suffix === '/qr') return json(response, 200, { status: 'connected', qr_codes: [], phone_number: sessions.get(id).phone_number });
  if (request.method === 'POST' && suffix === '/connect') return json(response, 200, { status: 'connected' });
  if (request.method === 'POST' && suffix === '/contacts/check') {
    const body = await readBody(request); const phone = String(body.phones?.[0] ?? '').replace(/\D/g, '');
    return json(response, 200, { results: [{ phone, jid: `${phone}@s.whatsapp.net`, is_registered: true }] });
  }
  if (request.method === 'GET' && suffix.includes('/contacts/') && suffix.endsWith('/lid')) {
    const jid = decodeURIComponent(suffix.slice('/contacts/'.length, -'/lid'.length));
    return json(response, 200, { lid: `10000000000000@lid`, jid });
  }
  if (request.method === 'POST' && suffix === '/calls/terminate') return json(response, 200, { ok: true });
  return json(response, 404, { error: 'not_found' });
});

const websocketServer = new WebSocketServer({ noServer: true });
let nats;
const codec = StringCodec();
const getNats = async () => { nats ??= connect({ servers: process.env.NATS_URL ?? 'nats://nats:4222', name: 'fake-waxum' }); return nats; };
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const match = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/calls\/media\/ws$/);
  if (!match || !sessions.has(decodeURIComponent(match[1]))) return socket.destroy();
  websocketServer.handleUpgrade(request, socket, head, (ws) => websocketServer.emit('connection', ws, request, decodeURIComponent(match[1])));
});
websocketServer.on('connection', (socket, _request, sessionId) => {
  const callId = `call-${randomUUID()}`;
  socket.send(JSON.stringify({ type: 'call_started', call_id: callId }));
  setTimeout(async () => {
    if (socket.readyState !== 1) return;
    const connection = await getNats();
    connection.publish(`wa.events.${sessionId}.incoming_call`, codec.encode(JSON.stringify({ event: 'incoming_call', data: { call_id: callId, action: 'Accept' } })));
    const frame = Buffer.alloc(640);
    socket.send(frame);
    setTimeout(() => { if (socket.readyState === 1) socket.send(frame); }, 350);
  }, 350);
});

server.listen(port, '0.0.0.0', () => process.stdout.write(`fake-waxum listening on ${port}\n`));
const shutdown = async () => { websocketServer.close(); server.close(); if (nats) await (await nats).drain(); };
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
