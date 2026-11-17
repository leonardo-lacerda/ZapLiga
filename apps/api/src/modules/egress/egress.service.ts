import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { MAIN_WAXUM_NODE, waxumNodes } from '../../infrastructure/waxum/waxum.client';
import { AuditService } from '../audit/audit.service';
import { decryptSecret, encryptSecret } from '../lead-ingestion/lead-ingestion.crypto';

// Internet exit through an attendant's PC (docs/saida-pelo-pc-do-atendente.md).
// The API holds a Tailscale OAuth client: it creates the join keys for the PCs
// and for the VPS slots, and finds each PC's Tailscale IP by its hostname.

// Overridable so a local stack can point at a stand-in.
const TAILSCALE_API = process.env.TAILSCALE_API_URL ?? 'https://api.tailscale.com/api/v2';
export const EDGE_TAG = 'tag:zapliga-edge';
export const PC_TAG = 'tag:atendente-pc';
const PC_KEY_SECONDS = 24 * 3600;
const EDGE_KEY_SECONDS = 3600;
// The slot watcher reports every 10 s; past this the slot itself is down.
const REPORT_STALE_SECONDS = 60;
// How often a PC that is not answering gets its Tailscale IP looked up again
// (it changes when Tailscale is reinstalled on the PC).
const IP_REFRESH_MS = 60_000;

// Pasted once into the Tailscale admin (Access controls). The slots may only use
// the PCs as an exit to the internet: the PC does not reach the VPS, and the VPS
// does not reach the attendant's home network.
export const TAILSCALE_POLICY = {
  // The edge tag owns both tags: Tailscale refused keys for a credential's own tags unless a tag it holds owns them.
  tagOwners: { [EDGE_TAG]: ['autogroup:admin', EDGE_TAG], [PC_TAG]: ['autogroup:admin', EDGE_TAG] },
  grants: [{ src: [EDGE_TAG], dst: ['autogroup:internet'], ip: ['*'] }],
  autoApprovers: { exitNode: [PC_TAG] },
};

type Device = { id: string; hostname: string; name: string; addresses: string[] };

@Injectable()
export class EgressService {
  private token?: { value: string; expiresAt: number };
  // A slot asks for a key on every check until its login goes through; hand out the same one.
  private readonly edgeKeys = new Map<string, { key: string; expiresAt: number }>();
  private readonly ipRefreshedAt = new Map<string, number>();

  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  private slots() { return [...waxumNodes().keys()].filter((node) => node !== MAIN_WAXUM_NODE); }

  async settings() {
    const result = await this.db.query('SELECT tailscale_client_id FROM egress_settings');
    return { configured: Boolean(result.rows[0]), clientId: result.rows[0]?.tailscale_client_id ?? null, slots: this.slots().length, policy: TAILSCALE_POLICY };
  }

  async saveSettings(actorUserId: string, clientId: string, clientSecret: string) {
    // Checked before saving: the token proves the client, the key proves its scope and tags.
    this.token = undefined;
    const token = await this.requestToken(clientId, clientSecret);
    await this.call('/tailnet/-/devices', {}, token);
    await this.db.query(`
      INSERT INTO egress_settings (id, tailscale_client_id, tailscale_client_secret) VALUES (true, $1, $2)
      ON CONFLICT (id) DO UPDATE SET tailscale_client_id = EXCLUDED.tailscale_client_id, tailscale_client_secret = EXCLUDED.tailscale_client_secret, updated_at = now()
    `, [clientId, encryptSecret(clientSecret)]);
    this.token = undefined;
    await this.audit.record({ actorUserId, action: 'egress.tailscale_connected', entityType: 'egress_settings', entityId: 'tailscale', metadata: { clientId } });
    return this.settings();
  }

  async listPcs() {
    const result = await this.db.query(`
      SELECT p.*,
        EXTRACT(EPOCH FROM (now() - p.route_reported_at))::int AS report_age_seconds,
        (SELECT count(*)::int FROM whatsapp_numbers n WHERE n.waxum_node = p.slot AND n.status <> 'removed') AS number_count
      FROM egress_pcs p ORDER BY p.created_at
    `);
    if (result.rows.some((pc) => !pc.tailscale_ip)) {
      // Waiting for the install: look the new PCs up now so the page shows them.
      const devices = await this.devices();
      for (const pc of result.rows.filter((row) => !row.tailscale_ip)) Object.assign(pc, await this.saveDevice(pc, devices));
    }
    return { items: result.rows.map(({ tailscale_device_id: _device, ...pc }) => ({ ...pc, status: this.status(pc) })), slots: this.slots().length };
  }

  private status(pc: any) {
    if (!pc.tailscale_ip) return 'waiting_install';
    if (pc.route_reported_at === null || Number(pc.report_age_seconds) > REPORT_STALE_SECONDS) return 'slot_down';
    return pc.route === 'pc' ? 'online' : 'pc_offline';
  }

  async addPc(actorUserId: string, name: string) {
    const used = new Set((await this.db.query('SELECT slot FROM egress_pcs')).rows.map((row) => row.slot));
    const slot = this.slots().find((candidate) => !used.has(candidate));
    if (!slot) throw new BadRequestException(`As ${this.slots().length} vagas de PC estão em uso. Remova um PC para adicionar outro.`);
    const id = randomUUID();
    const hostname = `zapliga-pc-${id.slice(0, 8)}`;
    // The key first: if Tailscale refuses it, no PC is left behind.
    const commands = await this.installCommands({ name, tailscale_hostname: hostname });
    const result = await this.db.query('INSERT INTO egress_pcs (id, name, slot, tailscale_hostname) VALUES ($1, $2, $3, $4) RETURNING *', [id, name, slot, hostname]);
    await this.audit.record({ actorUserId, action: 'egress.pc_added', entityType: 'egress_pc', entityId: id, metadata: { name, slot } });
    return { pc: result.rows[0], ...commands };
  }

  async installCommand(id: string) {
    return this.installCommands(await this.findPc(id));
  }

  // A fresh single-use key on every call, valid for a day.
  private async installCommands(pc: any) {
    const key = await this.createKey(PC_TAG, PC_KEY_SECONDS, `PC ${pc.name}`);
    const up = `up --reset --force-reauth --advertise-exit-node --hostname=${pc.tailscale_hostname} --auth-key=${key}`;
    return {
      // Wrapped in `powershell -Command` so it also runs when pasted into cmd.exe.
      windows: `powershell -NoProfile -Command "winget install -e --id Tailscale.Tailscale --silent --accept-source-agreements --accept-package-agreements; Start-Sleep 5; & (Join-Path $env:ProgramFiles 'Tailscale\\tailscale.exe') ${up} --unattended; powercfg /change standby-timeout-ac 0"`,
      linux: `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale ${up}`,
      expiresInHours: PC_KEY_SECONDS / 3600,
    };
  }

  async updatePc(actorUserId: string, id: string, changes: { name?: string; fallback?: 'offline' | 'vps' }) {
    const pc = await this.findPc(id);
    const result = await this.db.query('UPDATE egress_pcs SET name = COALESCE($2, name), fallback = COALESCE($3, fallback) WHERE id = $1 RETURNING *', [id, changes.name ?? null, changes.fallback ?? null]);
    await this.audit.record({ actorUserId, action: 'egress.pc_updated', entityType: 'egress_pc', entityId: id, metadata: { from: { name: pc.name, fallback: pc.fallback }, to: changes } });
    return result.rows[0];
  }

  async removePc(actorUserId: string, id: string) {
    const pc = await this.findPc(id);
    const numbers = await this.db.query("SELECT count(*)::int AS total FROM whatsapp_numbers WHERE waxum_node = $1 AND status <> 'removed'", [pc.slot]);
    if (numbers.rows[0].total > 0) throw new BadRequestException(`${numbers.rows[0].total} número(s) ainda saem por este PC. Troque a saída deles antes de remover.`);
    if (pc.tailscale_device_id) await this.call(`/device/${pc.tailscale_device_id}`, { method: 'DELETE' }).catch((error) => {
      if ((error as { status?: number }).status !== 404) throw error;
    });
    await this.db.query('DELETE FROM egress_pcs WHERE id = $1', [id]);
    this.edgeKeys.delete(pc.slot);
    await this.audit.record({ actorUserId, action: 'egress.pc_removed', entityType: 'egress_pc', entityId: id, metadata: { name: pc.name, slot: pc.slot } });
    return { removed: true };
  }

  // The exits a line can be moved to: the VPS plus every slot with a PC.
  async nodes() {
    const pcs = await this.db.query(`SELECT slot, name, route = 'pc' AND route_reported_at > now() - make_interval(secs => $1) AS online FROM egress_pcs ORDER BY created_at`, [REPORT_STALE_SECONDS]);
    return { items: [{ node: MAIN_WAXUM_NODE, label: 'VPS', online: true }, ...pcs.rows.map((pc) => ({ node: pc.slot, label: pc.name, online: pc.online }))] };
  }

  /**
   * Polled every 10 s by the watcher of each slot (infra/egress/edge-entrypoint.sh),
   * which reports the route it is on. Answers `key=value` lines so the shell
   * needs no JSON parser; no PC on the slot means empty values.
   */
  async slotConfig(slot: string, route: string, loggedIn: boolean) {
    if (!this.slots().includes(slot)) throw new NotFoundException(`Vaga ${slot} não existe`);
    const result = await this.db.query('UPDATE egress_pcs SET route = $2, route_reported_at = now() WHERE slot = $1 RETURNING *', [slot, route]);
    let pc = result.rows[0];
    // Waiting for the install, or not answering: the PC may have (re)joined with a new IP.
    if (pc && (!pc.tailscale_ip || (route !== 'pc' && Date.now() - (this.ipRefreshedAt.get(pc.id) ?? 0) > IP_REFRESH_MS))) {
      this.ipRefreshedAt.set(pc.id, Date.now());
      pc = { ...pc, ...(await this.saveDevice(pc, await this.devices())) };
    }
    if (!pc?.tailscale_ip) return 'exit_node=\nfallback=\nauth_key=\n';
    const authKey = loggedIn ? '' : await this.edgeKey(slot);
    return `exit_node=${pc.tailscale_ip}\nfallback=${pc.fallback}\nauth_key=${authKey}\n`;
  }

  private async edgeKey(slot: string) {
    const cached = this.edgeKeys.get(slot);
    if (cached && cached.expiresAt > Date.now()) return cached.key;
    const key = await this.createKey(EDGE_TAG, EDGE_KEY_SECONDS, `VPS ${slot}`);
    this.edgeKeys.set(slot, { key, expiresAt: Date.now() + (EDGE_KEY_SECONDS - 300) * 1000 });
    return key;
  }

  private async findPc(id: string) {
    const result = await this.db.query('SELECT * FROM egress_pcs WHERE id = $1', [id]);
    if (!result.rows[0]) throw new NotFoundException('PC não encontrado');
    return result.rows[0];
  }

  private async saveDevice(pc: any, devices: Device[]) {
    const device = devices.find((item) => item.hostname === pc.tailscale_hostname || item.name.split('.')[0] === pc.tailscale_hostname);
    const ip = device?.addresses.find((address) => address.startsWith('100.'));
    if (!device || !ip || (device.id === pc.tailscale_device_id && ip === pc.tailscale_ip)) return {};
    await this.db.query('UPDATE egress_pcs SET tailscale_device_id = $2, tailscale_ip = $3 WHERE id = $1', [pc.id, device.id, ip]);
    return { tailscale_device_id: device.id, tailscale_ip: ip };
  }

  private async devices() {
    return ((await this.call('/tailnet/-/devices')).devices ?? []) as Device[];
  }

  private async createKey(tag: string, expirySeconds: number, description: string) {
    const result = await this.call('/tailnet/-/keys', {
      method: 'POST',
      body: JSON.stringify({ capabilities: { devices: { create: { reusable: false, ephemeral: false, preauthorized: true, tags: [tag] } } }, expirySeconds, description: description.replace(/[^\w -]/g, '').slice(0, 50) }),
    });
    return String(result.key);
  }

  private async call(path: string, init: RequestInit = {}, token?: string) {
    const response = await fetch(`${TAILSCALE_API}${path}`, { ...init, headers: { authorization: `Bearer ${token ?? (await this.accessToken())}`, 'content-type': 'application/json' } });
    const text = await response.text();
    if (!response.ok) throw Object.assign(new BadRequestException(`A Tailscale recusou (${response.status}): ${text.slice(0, 300)}`), { status: response.status });
    return text ? JSON.parse(text) : {};
  }

  private async accessToken() {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    const result = await this.db.query('SELECT tailscale_client_id, tailscale_client_secret FROM egress_settings');
    if (!result.rows[0]) throw new BadRequestException('Conecte a Tailscale em Admin → Saídas de internet');
    return this.requestToken(result.rows[0].tailscale_client_id, decryptSecret(result.rows[0].tailscale_client_secret));
  }

  private async requestToken(clientId: string, clientSecret: string) {
    const response = await fetch(`${TAILSCALE_API}/oauth/token`, { method: 'POST', body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret }) });
    if (!response.ok) throw new BadRequestException(`A Tailscale recusou o client ID ou o secret (${response.status})`);
    const body = await response.json() as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
    return body.access_token;
  }
}
