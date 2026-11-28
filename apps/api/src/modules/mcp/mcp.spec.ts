import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ConflictException } from '@nestjs/common';
import { McpKeysService, type McpKey } from './mcp-keys.service';
import { buildServer } from './mcp.tools';

const KEY: McpKey = { id: 'key-1', tenant_id: 'tenant-1', user_id: 'user-1', name: 'Claude do Leo', api_key_prefix: 'zpl_mcp_abc', scopes: ['mcp:read', 'mcp:operate'], status: 'active', last_used_at: null, created_at: new Date(), revoked_at: null };

const element = (index: number, text: string, bounds: [number, number, number, number], extra: Record<string, unknown> = {}) =>
  ({ index, class: 'Button', text, desc: '', id: `id${index}`, clickable: true, scrollable: false, editable: false, bounds, blocked: false, ...extra });

const makeDeps = () => {
  const provisioning = {
    listPhones: jest.fn(async () => ({ items: [
      { id: 'p1', name: 'WhatsApp 2', status: 'on', android: '12', proxy: null, apps: { whatsapp: true, business: false }, busyJobId: null },
      { id: 'p2', name: 'WhatsApp 3', status: 'off', android: '12', proxy: null, apps: { whatsapp: true, business: true }, busyJobId: null },
    ] })),
    listEgress: jest.fn(async () => ({ configured: true, items: [
      { node: 'pc-2', label: 'Pc da Ana', pcName: 'ana', online: true, publicIps: [], userId: 'u2', userName: 'Ana', isMine: false },
      { node: 'pc-1', label: 'Pc do Leo', pcName: 'leo', online: true, publicIps: [], userId: 'user-1', userName: 'Leo', isMine: true },
    ] })),
    listJobs: jest.fn(async () => ({ items: [] })),
    getJob: jest.fn(async (_t: string, _u: string, id: string) => ({ id, mode: 'control', status: 'waiting_input', step: 'controlling', awaiting: 'manual', history: [] })),
    screenElements: jest.fn(async () => ({ width: 1080, height: 2400, elements: [
      element(0, 'Reenviar SMS', [0, 900, 540, 1000], { blocked: true }),
      element(1, 'Agora não', [540, 900, 1080, 1000]),
    ] })),
    liveScreen: jest.fn(async () => Buffer.from('jpeg-bytes')),
    manualAction: jest.fn(async () => ({ ok: true })),
    createJob: jest.fn(async (_t: string, _u: string, input: any) => ({ id: 'job-9', mode: input.mode, status: 'running', step: 'queued', history: [] })),
    submitSms: jest.fn(async () => { throw new ConflictException({ code: 'not_awaiting', message: 'O cadastro não está esperando o código agora.' }); }),
    resumeRobot: jest.fn(async (_t: string, _u: string, id: string) => ({ id, mode: 'control', status: 'done', step: 'control_ended', history: [] })),
    stats: jest.fn(async () => ({ days: 30, total: 0 })),
    deletePhone: jest.fn(),
  };
  const numbers = { list: jest.fn(async () => ({ total: 1, items: [{ id: 'n1', label: 'Linha 1', phone: '5511999', status: 'connected', waxum_session_id: 'secret-session' }] })), reconnect: jest.fn() };
  const audit = { record: jest.fn(async () => undefined) };
  return { provisioning, numbers, audit };
};

/** A real HTTP MCP endpoint (stateless, like McpController) and the SDK's own client. */
async function connect(key: McpKey, deps: ReturnType<typeof makeDeps>) {
  const http: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const server = buildServer(deps as any, key);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(request, response, JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`)));
  return { client, close: async () => { await client.close(); await new Promise((resolve) => http.close(resolve)); } };
}

const textOf = (result: any) => result.content.find((item: any) => item.type === 'text').text as string;

describe('MCP do ZapLiga', () => {
  it('lists only the tools the key scopes allow', async () => {
    const deps = makeDeps();
    const readOnly = await connect({ ...KEY, scopes: ['mcp:read'] }, deps);
    const readTools = (await readOnly.client.listTools()).tools.map((tool) => tool.name);
    await readOnly.close();
    expect(readTools).toEqual(expect.arrayContaining(['list_phones', 'screen_elements', 'view_screen', 'list_numbers', 'line_monitor_now', 'line_period', 'line_learnings']));
    expect(readTools).not.toContain('tap');

    const operate = await connect(KEY, deps);
    const tools = (await operate.client.listTools()).tools.map((tool) => tool.name);
    await operate.close();
    expect(tools).toEqual(expect.arrayContaining(['open_phone', 'tap', 'send_sms_code', 'link_to_zapliga']));
    expect(tools).not.toContain('delete_phone');

    const destructive = await connect({ ...KEY, scopes: ['mcp:read', 'mcp:operate', 'mcp:destructive'] }, deps);
    expect((await destructive.client.listTools()).tools.map((tool) => tool.name)).toContain('delete_phone');
    await destructive.close();
  });

  it('shows the cost of powered-on phones and never leaks line internals', async () => {
    const deps = makeDeps();
    const { client, close } = await connect(KEY, deps);
    const phones = JSON.parse(textOf(await client.callTool({ name: 'list_phones', arguments: {} })));
    expect(phones).toMatchObject({ poweredOn: 1, costPerHourUsd: 0.42 });
    const numbers = textOf(await client.callTool({ name: 'list_numbers', arguments: {} }));
    expect(numbers).toContain('Linha 1');
    expect(numbers).not.toContain('secret-session');
    await close();
  });

  it('opens a phone through the user own online PC and audits the operation', async () => {
    const deps = makeDeps();
    const { client, close } = await connect(KEY, deps);
    const result = await client.callTool({ name: 'open_phone', arguments: { phone_id: 'p2' } });
    expect(JSON.parse(textOf(result))).toMatchObject({ id: 'job-9', mode: 'control' });
    expect(deps.provisioning.createJob).toHaveBeenCalledWith('tenant-1', 'user-1', { egressNode: 'pc-1', geelarkPhoneId: 'p2', mode: 'control' });
    expect(deps.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'mcp.open_phone', actorUserId: 'user-1', entityId: 'key-1' }));
    await close();
  });

  it('taps an element by number and refuses a blocked one', async () => {
    const deps = makeDeps();
    const { client, close } = await connect(KEY, deps);
    await client.callTool({ name: 'tap', arguments: { job_id: 'job-9', element: 1 } });
    const [, , , action] = deps.provisioning.manualAction.mock.calls[0] as any[];
    expect(action.type).toBe('tap');
    expect(action.x).toBeCloseTo(810 / 1079, 3);
    expect(action.y).toBeCloseTo(950 / 2399, 3);

    const refused = await client.callTool({ name: 'tap', arguments: { job_id: 'job-9', element: 0 } }) as any;
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/Toque recusado: "Reenviar SMS"/);
    const byPoint = await client.callTool({ name: 'tap', arguments: { job_id: 'job-9', x: 0.2, y: 0.4 } }) as any;
    expect(byPoint.isError).toBe(true);
    expect(deps.provisioning.manualAction).toHaveBeenCalledTimes(1);
    await close();
  });

  it('returns the screen as an image and API errors as readable tool errors', async () => {
    const deps = makeDeps();
    const { client, close } = await connect(KEY, deps);
    const screen = await client.callTool({ name: 'view_screen', arguments: { job_id: 'job-9' } }) as any;
    expect(screen.content[0]).toEqual({ type: 'image', data: Buffer.from('jpeg-bytes').toString('base64'), mimeType: 'image/jpeg' });
    expect(deps.provisioning.liveScreen).toHaveBeenCalledWith('tenant-1', 'job-9', 540);

    const sms = await client.callTool({ name: 'send_sms_code', arguments: { job_id: 'job-9', code: '123456' } }) as any;
    expect(sms.isError).toBe(true);
    expect(textOf(sms)).toBe('O cadastro não está esperando o código agora.');
    expect(deps.audit.record).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'mcp.send_sms_code' }));
    await close();
  });

  it('ends a control session by handing the phone back, which powers it off', async () => {
    const deps = makeDeps();
    const { client, close } = await connect(KEY, deps);
    const ended = JSON.parse(textOf(await client.callTool({ name: 'end_session', arguments: { job_id: 'job-9' } })));
    expect(ended).toMatchObject({ status: 'done', step: 'control_ended' });
    await close();
  });

  it('only deletes a phone with its exact name', async () => {
    const deps = makeDeps();
    const { client, close } = await connect({ ...KEY, scopes: ['mcp:read', 'mcp:operate', 'mcp:destructive'] }, deps);
    const wrong = await client.callTool({ name: 'delete_phone', arguments: { phone_id: 'p2', confirm_name: 'WhatsApp 2' } }) as any;
    expect(wrong.isError).toBe(true);
    expect(deps.provisioning.deletePhone).not.toHaveBeenCalled();
    await close();
  });
});

describe('McpKeysService', () => {
  const makeService = () => {
    const rows: any[] = [];
    const db = { query: jest.fn(async (sql: string, params: any[] = []) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (text.startsWith('INSERT INTO mcp_keys')) {
        const [id, tenant_id, user_id, name, api_key_prefix, api_key_hash, scopes] = params;
        const row = { id, tenant_id, user_id, name, api_key_prefix, api_key_hash, scopes, status: 'active', created_at: new Date(), last_used_at: null, revoked_at: null };
        rows.push(row);
        return { rows: [row] };
      }
      if (text.startsWith('SELECT k.* FROM mcp_keys k')) return { rows: rows.filter((row) => row.api_key_hash === params[0] && row.status === 'active') };
      if (text.startsWith("UPDATE mcp_keys SET status = 'revoked'")) {
        const row = rows.find((item) => item.tenant_id === params[0] && item.id === params[1]);
        if (row) row.status = 'revoked';
        return { rows: row ? [row] : [] };
      }
      throw new Error(`unexpected SQL: ${text.slice(0, 60)}`);
    }) };
    const audit = { record: jest.fn(async () => undefined) };
    return { service: new McpKeysService(db as any, { client: {} } as any, audit as any), audit };
  };

  it('shows the key once, stores only its hash, and stops authenticating it once revoked', async () => {
    const { service, audit } = makeService();
    const created = await service.create('tenant-1', 'user-1', { name: 'Claude do Leo' });
    expect(created.apiKey).toMatch(/^zpl_mcp_/);
    expect(created.scopes).toEqual(['mcp:read', 'mcp:operate']);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(created.apiKey);
    expect((await service.authenticate(created.apiKey))?.user_id).toBe('user-1');
    expect(await service.authenticate('zpl_crm_other')).toBeNull();
    await service.revoke('tenant-1', 'user-1', created.id);
    expect(await service.authenticate(created.apiKey)).toBeNull();
  });

  it('refuses unknown scopes and keys without read', async () => {
    const { service } = makeService();
    await expect(service.create('tenant-1', 'user-1', { name: 'x1', scopes: ['mcp:root'] })).rejects.toThrow('Escopo inválido');
    await expect(service.create('tenant-1', 'user-1', { name: 'x1', scopes: ['mcp:operate'] })).rejects.toThrow('mcp:read');
  });
});
