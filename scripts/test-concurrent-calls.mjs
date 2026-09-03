import 'dotenv/config';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { connect, StringCodec } from 'nats';

const argv = process.argv.slice(2);
const valueAfter = (name) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
const has = (name) => argv.includes(name);
const usage = `
Teste local de duas chamadas na mesma sessão Waxum

Preparar e validar a linha, sem ligar:
  npm run test:concurrent-calls -- --line-label "Linha teste" --numbers 5511... 5521... --prepare-only

Disparar as duas chamadas reais simultaneamente:
  npm run test:concurrent-calls -- --line-label "Linha teste" --numbers 5511... 5521... --confirm-two-real-calls

Opções:
  --session-id <id>             usa uma sessão Waxum diretamente
  --line-label <nome>           encontra a sessão no banco local
  --numbers <numero1> <numero2> exatamente dois números WhatsApp distintos
  --duration-seconds <5..120>   encerra as duas tentativas após este tempo (padrão: 30)
  --prepare-only                valida linha/LIDs sem iniciar chamadas
  --confirm-two-real-calls      confirmação obrigatória para efetuar as chamadas
  --allow-remote                permite WAXUM_URL que não seja localhost (bloqueado por padrão)
`;

if (has('--help') || has('-h')) { console.log(usage.trim()); process.exit(0); }

const fail = (message) => { throw new Error(message); };
const digits = (value) => String(value ?? '').replace(/\D/g, '');
const numberIndex = argv.indexOf('--numbers');
const phones = numberIndex >= 0 ? [digits(argv[numberIndex + 1]), digits(argv[numberIndex + 2])] : [];
if (phones.length !== 2 || phones.some((phone) => phone.length < 10 || phone.length > 15)) fail('Informe exatamente dois números válidos após --numbers.');
if (phones[0] === phones[1]) fail('Os dois destinatários precisam ser diferentes.');

const waxumUrl = (process.env.WAXUM_URL ?? 'http://127.0.0.1:3451').replace(/\/$/, '');
const parsedWaxumUrl = new URL(waxumUrl);
if (!has('--allow-remote') && !['localhost', '127.0.0.1', '::1'].includes(parsedWaxumUrl.hostname)) {
  fail(`WAXUM_URL remoto bloqueado (${parsedWaxumUrl.hostname}). Este ensaio é local; use --allow-remote somente de forma intencional.`);
}
const apiKey = process.env.WAXUM_API_KEY ?? 'zapcall-local-waxum-token';
const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
const durationSeconds = Number(valueAfter('--duration-seconds') ?? 30);
if (!Number.isFinite(durationSeconds) || durationSeconds < 5 || durationSeconds > 120) fail('--duration-seconds deve estar entre 5 e 120.');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Waxum's audio endpoint accepts raw little-endian PCM16, mono, 16 kHz.
// Keep a real media cadence in this diagnostic: an idle WebSocket is not
// equivalent to the browser AudioBridge, which emits 960 samples every 60 ms.
const MEDIA_FRAME = Buffer.alloc(960 * 2);
const MEDIA_INTERVAL_MS = 60;

async function request(path, init = {}) {
  const response = await fetch(`${waxumUrl}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  let body = text;
  try { body = text ? JSON.parse(text) : {}; } catch { /* response is plain text */ }
  if (!response.ok) fail(`Waxum ${response.status} em ${path}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  return body;
}

async function findSession() {
  const explicit = valueAfter('--session-id');
  if (explicit) return { sessionId: explicit, label: '(session-id explícito)' };

  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://zapcall:zapcall@127.0.0.1:5432/zapcall', max: 1 });
  try {
    const label = valueAfter('--line-label');
    const result = label
      ? await pool.query(`SELECT label, phone, waxum_session_id FROM whatsapp_numbers WHERE lower(label) = lower($1) AND status <> 'removed' ORDER BY created_at DESC`, [label])
      : await pool.query(`SELECT label, phone, waxum_session_id FROM whatsapp_numbers WHERE status IN ('connected','online','ready','authenticated') ORDER BY created_at DESC`);
    if (result.rows.length === 0) fail(label ? `Linha local não encontrada: ${label}` : 'Nenhuma linha conectada encontrada no banco local.');
    if (result.rows.length > 1) fail(`Mais de uma linha corresponde ao filtro. Use --line-label. Encontradas: ${result.rows.map((row) => row.label).join(', ')}`);
    return { sessionId: result.rows[0].waxum_session_id, label: result.rows[0].label, configuredPhone: digits(result.rows[0].phone) };
  } finally {
    await pool.end();
  }
}

async function resolveRecipients(sessionId) {
  const checked = await request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/contacts/check`, {
    method: 'POST', body: JSON.stringify({ phones }),
  });
  const rows = Array.isArray(checked.results) ? checked.results : [];
  return Promise.all(phones.map(async (phone, index) => {
    const contact = rows.find((row) => digits(row.phone) === phone) ?? rows.find((row) => digits(row.jid?.split('@')[0]) === phone) ?? rows[index];
    if (!contact?.jid || !contact.is_registered) fail(`${phone} não foi confirmado como conta WhatsApp.`);
    let lid;
    for (let attempt = 0; attempt < 3 && !lid; attempt += 1) {
      if (attempt > 0) await delay(400);
      try {
        const stored = await request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/contacts/${encodeURIComponent(contact.jid)}/lid`);
        lid = stored?.lid;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
    if (!lid) fail(`LID indisponível para ${phone}.`);
    const recipient = String(lid).includes('@lid') ? String(lid) : `${lid}@lid`;
    return { phone, jid: contact.jid, recipient };
  }));
}

const session = await findSession();
const status = await request(`/api/v1/sessions/${encodeURIComponent(session.sessionId)}/status`);
if (!(status.connected || ['connected', 'online', 'ready', 'authenticated', 'logged_in'].includes(String(status.status).toLowerCase()) || status.is_logged_in === true)) fail(`A linha ${session.label} não está conectada no Waxum.`);
const ownPhone = digits(status.phone_number ?? status.session?.phone_number ?? session.configuredPhone);
if (phones.includes(ownPhone)) fail('Um destinatário é o próprio número da linha; escolha dois números externos.');

console.log(`Linha: ${session.label} (${ownPhone || 'telefone não informado'})`);
console.log(`Sessão: ${session.sessionId}`);
console.log('Preparando os dois destinatários antes da barreira de disparo...');
const recipients = await resolveRecipients(session.sessionId);
for (const recipient of recipients) console.log(`  ${recipient.phone} -> ${recipient.recipient}`);

if (has('--prepare-only')) {
  console.log('Preparação concluída. Nenhuma chamada foi iniciada.');
  // Let Node close its HTTP/DB handles naturally. Calling process.exit() here
  // can tear down libuv handles while they are still closing on Windows.
  process.exitCode = 0;
} else {
if (!has('--confirm-two-real-calls')) fail(`As chamadas NÃO foram iniciadas. Revise os dados e repita com --confirm-two-real-calls.\n\n${usage.trim()}`);

const events = [];
let nats;
let subscription;
try {
  nats = await connect({ servers: process.env.NATS_URL ?? 'nats://127.0.0.1:4222', name: 'zapliga-concurrent-call-test', timeout: 3000 });
  subscription = nats.subscribe(`wa.events.${session.sessionId}.incoming_call`);
  const codec = StringCodec();
  void (async () => {
    for await (const message of subscription) {
      try { events.push({ at: new Date().toISOString(), ...JSON.parse(codec.decode(message.data)) }); } catch { /* ignore malformed diagnostic event */ }
    }
  })();
} catch (error) {
  console.warn(`NATS de diagnóstico indisponível; o teste continuará pelos WebSockets: ${String(error)}`);
}

const startedAt = Date.now();
function beginCall(target) {
  const state = { phone: target.phone, recipient: target.recipient, requestedAt: Date.now(), openedAt: null, callStartedAt: null, callId: null, binaryFrames: 0, nonZeroFrames: 0, uplinkFrames: 0, closedAt: null, closeCode: null, error: null };
  const wsUrl = `${waxumUrl.replace(/^http/, 'ws')}/api/v1/sessions/${encodeURIComponent(session.sessionId)}/calls/media/ws?to=${encodeURIComponent(target.recipient)}&kind=audio`;
  const socket = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${apiKey}` } });
  let uplinkTimer;
  const sendMediaFrame = () => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(MEDIA_FRAME);
    state.uplinkFrames += 1;
  };
  const startUplink = () => {
    if (uplinkTimer) return;
    sendMediaFrame();
    uplinkTimer = setInterval(sendMediaFrame, MEDIA_INTERVAL_MS);
  };
  let settle;
  const ready = new Promise((resolve) => { settle = resolve; });
  const timer = setTimeout(() => settle(), 12_000);
  socket.on('open', () => { state.openedAt = Date.now(); });
  socket.on('message', (data, binary) => {
    if (binary) {
      const frame = Buffer.from(data);
      state.binaryFrames += 1;
      if (frame.some((byte) => byte !== 0)) state.nonZeroFrames += 1;
      return;
    }
    try {
      const payload = JSON.parse(data.toString());
      if (payload.type === 'call_started' && payload.call_id) {
        state.callId = payload.call_id;
        state.callStartedAt = Date.now();
        startUplink();
        clearTimeout(timer); settle();
      }
    } catch { /* retain raw transport evidence only */ }
  });
  socket.on('error', (error) => { state.error = String(error.message ?? error); clearTimeout(timer); settle(); });
  socket.on('close', (code) => { if (uplinkTimer) clearInterval(uplinkTimer); state.closedAt = Date.now(); state.closeCode = code; clearTimeout(timer); settle(); });
  return { state, socket, ready };
}

console.log(`Disparando as duas chamadas na mesma barreira: ${new Date(startedAt).toISOString()}`);
const attempts = recipients.map(beginCall);
let terminating = false;
const terminateAll = async () => {
  if (terminating) return;
  terminating = true;
  await Promise.all(attempts.map(async ({ state, socket }) => {
    if (state.callId) {
      try {
        await request(`/api/v1/sessions/${encodeURIComponent(session.sessionId)}/calls/terminate`, {
          method: 'POST', body: JSON.stringify({ peer: state.recipient, call_id: state.callId, reason: 'concurrent_test_finished' }),
        });
      } catch (error) { state.error ??= `terminate: ${String(error)}`; }
    }
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
  }));
  subscription?.unsubscribe();
  await nats?.drain().catch(() => undefined);
};
const interrupted = async () => {
  console.warn('\nInterrompido; encerrando explicitamente as duas tentativas...');
  await terminateAll();
  process.exit(130);
};
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);
await Promise.all(attempts.map((attempt) => attempt.ready));
console.log(`Mantendo as tentativas por ${durationSeconds}s para observar toque, eventos e mídia...`);
await delay(durationSeconds * 1000);
await terminateAll();
process.removeListener('SIGINT', interrupted);
process.removeListener('SIGTERM', interrupted);

const states = attempts.map(({ state }) => ({
  ...state,
  requestedOffsetMs: state.requestedAt - startedAt,
  openedOffsetMs: state.openedAt == null ? null : state.openedAt - startedAt,
  callStartedOffsetMs: state.callStartedAt == null ? null : state.callStartedAt - startedAt,
}));
const bothStarted = states.every((state) => Boolean(state.callId));
const overlapEvidence = bothStarted && Math.abs(states[0].callStartedAt - states[1].callStartedAt) < durationSeconds * 1000;
const report = { bothStarted, overlapEvidence, session: { label: session.label, id: session.sessionId, phone: ownPhone }, calls: states, natsEvents: events };
console.log('\nRESULTADO DO TESTE');
console.log(JSON.stringify(report, null, 2));
console.log(bothStarted
  ? 'As duas tentativas receberam call_id enquanto coexistiam. Confira toque/atendimento e eventos acima para confirmar o comportamento ponta a ponta.'
  : 'O Waxum/WhatsApp não iniciou as duas tentativas. O relatório mostra qual chamada foi recusada ou encerrada.');
process.exitCode = bothStarted ? 0 : 2;
}
