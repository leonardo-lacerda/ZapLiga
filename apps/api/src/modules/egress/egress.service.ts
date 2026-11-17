import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { MAIN_WAXUM_NODE, waxumNodes } from '../../infrastructure/waxum/waxum.client';
import { AuditService } from '../audit/audit.service';
import { decryptSecret, encryptSecret } from '../lead-ingestion/lead-ingestion.crypto';
import { NumbersService } from '../numbers/numbers.service';

// Internet exit through an attendant's PC (docs/saida-pelo-pc-do-atendente.md).
// The API holds a Tailscale OAuth client: it creates the join keys for the PCs
// and for the VPS slots, and finds the PCs among the tailnet's devices.

// Overridable so a local stack can point at a stand-in.
const TAILSCALE_API = process.env.TAILSCALE_API_URL ?? 'https://api.tailscale.com/api/v2';
export const EDGE_TAG = 'tag:zapliga-edge';
export const PC_TAG = 'tag:atendente-pc';
// Tailscale caps auth keys at 90 days; the install command gets a fresh key a week before.
const PC_KEY_SECONDS = 90 * 24 * 3600;
const PC_KEY_RENEW_SECONDS = 7 * 24 * 3600;
const EDGE_KEY_SECONDS = 3600;
// The slot watcher reports every 10 s; past this the slot itself is down.
export const REPORT_STALE_SECONDS = 60;
// How often the tailnet's devices are read again while a slot waits for its PC.
const DEVICE_REFRESH_MS = 60_000;

// Pasted once into the Tailscale admin (Access controls). The slots may only use
// the PCs as an exit to the internet: the PC does not reach the VPS, and the VPS
// does not reach the attendant's home network.
export const TAILSCALE_POLICY = {
  // The edge tag owns both tags: Tailscale refused keys for a credential's own tags unless a tag it holds owns them.
  tagOwners: { [EDGE_TAG]: ['autogroup:admin', EDGE_TAG], [PC_TAG]: ['autogroup:admin', EDGE_TAG] },
  grants: [{ src: [EDGE_TAG], dst: ['autogroup:internet'], ip: ['*'] }],
  autoApprovers: { exitNode: [PC_TAG] },
};

type Device = { id: string; hostname: string; name: string; addresses: string[]; tags?: string[] };

@Injectable()
export class EgressService {
  private readonly logger = new Logger(EgressService.name);
  private token?: { value: string; expiresAt: number };
  // A slot asks for a key on every check until its login goes through; hand out the same one.
  private readonly edgeKeys = new Map<string, { key: string; expiresAt: number }>();
  private devicesSyncedAt = 0;

  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly numbers: NumbersService) {}

  slots() { return [...waxumNodes().keys()].filter((node) => node !== MAIN_WAXUM_NODE); }

  async settings() {
    const result = await this.db.query('SELECT tailscale_client_id, pool_enabled, max_numbers_per_pc, offline_grace_seconds FROM egress_settings');
    const row = result.rows[0];
    return {
      configured: Boolean(row),
      clientId: row?.tailscale_client_id ?? null,
      poolEnabled: row?.pool_enabled ?? true,
      maxNumbersPerPc: row?.max_numbers_per_pc ?? 5,
      offlineGraceSeconds: row?.offline_grace_seconds ?? 180,
      slots: this.slots().length,
      policy: TAILSCALE_POLICY,
    };
  }

  async saveSettings(actorUserId: string, clientId: string, clientSecret: string) {
    // Checked before saving: the token proves the client, the device list its scope.
    this.token = undefined;
    const token = await this.requestToken(clientId, clientSecret);
    await this.call('/tailnet/-/devices', {}, token);
    // A new credential gets a new install key too.
    await this.db.query(`
      INSERT INTO egress_settings (id, tailscale_client_id, tailscale_client_secret) VALUES (true, $1, $2)
      ON CONFLICT (id) DO UPDATE SET tailscale_client_id = EXCLUDED.tailscale_client_id, tailscale_client_secret = EXCLUDED.tailscale_client_secret, pc_auth_key = NULL, pc_auth_key_expires_at = NULL, updated_at = now()
    `, [clientId, encryptSecret(clientSecret)]);
    this.token = undefined;
    await this.audit.record({ actorUserId, action: 'egress.tailscale_connected', entityType: 'egress_settings', entityId: 'tailscale', metadata: { clientId } });
    return this.settings();
  }

  async savePoolSettings(actorUserId: string, changes: { poolEnabled?: boolean; maxNumbersPerPc?: number; offlineGraceSeconds?: number }) {
    const result = await this.db.query(`
      UPDATE egress_settings SET pool_enabled = COALESCE($1, pool_enabled), max_numbers_per_pc = COALESCE($2, max_numbers_per_pc),
        offline_grace_seconds = COALESCE($3, offline_grace_seconds), updated_at = now() RETURNING id
    `, [changes.poolEnabled ?? null, changes.maxNumbersPerPc ?? null, changes.offlineGraceSeconds ?? null]);
    if (!result.rows[0]) throw new BadRequestException('Conecte a Tailscale primeiro');
    await this.audit.record({ actorUserId, action: 'egress.pool_settings_changed', entityType: 'egress_settings', entityId: 'pool', metadata: changes });
    return this.settings();
  }

  /** The same command for every PC: it joins with the shared key and registers itself (syncPcs). */
  async installCommand() {
    const key = await this.pcKey();
    const up = `up --reset --force-reauth --advertise-exit-node --auth-key=${key}`;
    return {
      // Wrapped in `powershell -Command` so it also runs when pasted into cmd.exe.
      windows: `powershell -NoProfile -Command "winget install -e --id Tailscale.Tailscale --silent --accept-source-agreements --accept-package-agreements; Start-Sleep 5; & (Join-Path $env:ProgramFiles 'Tailscale\\tailscale.exe') ${up} --unattended; powercfg /change standby-timeout-ac 0"`,
      linux: `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale ${up}`,
    };
  }

  private async pcKey() {
    const result = await this.db.query(`SELECT pc_auth_key FROM egress_settings WHERE pc_auth_key_expires_at > now() + make_interval(secs => $1)`, [PC_KEY_RENEW_SECONDS]);
    if (result.rows[0]?.pc_auth_key) return decryptSecret(result.rows[0].pc_auth_key);
    const key = await this.createKey(PC_TAG, PC_KEY_SECONDS, 'PCs dos atendentes', true);
    await this.db.query(`UPDATE egress_settings SET pc_auth_key = $1, pc_auth_key_expires_at = now() + make_interval(secs => $2)`, [encryptSecret(key), PC_KEY_SECONDS]);
    return key;
  }

  async listPcs() {
    await this.syncPcs();
    const result = await this.db.query(`
      SELECT p.id, p.name, p.slot, p.tailscale_ip, p.fallback, p.route, p.route_reported_at, p.offline_since, p.created_at,
        EXTRACT(EPOCH FROM (now() - p.route_reported_at))::int AS report_age_seconds,
        (SELECT count(*)::int FROM whatsapp_numbers n WHERE p.slot IS NOT NULL AND n.waxum_node = p.slot AND n.status <> 'removed') AS number_count
      FROM egress_pcs p ORDER BY p.created_at
    `);
    const main = await this.db.query(`SELECT count(*)::int AS total FROM whatsapp_numbers WHERE waxum_node = $1 AND status <> 'removed'`, [MAIN_WAXUM_NODE]);
    return { items: result.rows.map((pc) => ({ ...pc, status: this.status(pc) })), slots: this.slots().length, vpsNumbers: main.rows[0].total };
  }

  private status(pc: any) {
    if (!pc.slot) return 'no_slot';
    if (pc.route_reported_at === null || Number(pc.report_age_seconds) > REPORT_STALE_SECONDS) return 'slot_down';
    return pc.route === 'pc' ? 'online' : 'pc_offline';
  }

  /**
   * Registers every tailnet device tagged as an attendant PC, refreshes their IPs
   * and gives a free slot to the PCs waiting for one. Reads the tailnet at most
   * once a minute unless `force`.
   */
  async syncPcs(force = true) {
    if (!force && Date.now() - this.devicesSyncedAt < DEVICE_REFRESH_MS) return;
    if (!(await this.db.query('SELECT 1 FROM egress_settings')).rows[0]) return;
    this.devicesSyncedAt = Date.now();
    const devices = (await this.devices()).filter((device) => device.tags?.includes(PC_TAG));
    const known = (await this.db.query('SELECT id, tailscale_device_id, tailscale_hostname, tailscale_ip FROM egress_pcs')).rows;
    for (const device of devices) {
      const ip = device.addresses.find((address) => address.startsWith('100.')) ?? null;
      const hostname = device.name.split('.')[0];
      const pc = known.find((row) => row.tailscale_device_id === device.id || row.tailscale_hostname === hostname);
      if (!pc) {
        await this.db.query('INSERT INTO egress_pcs (id, name, tailscale_hostname, tailscale_device_id, tailscale_ip) VALUES ($1, $2, $3, $4, $5)', [randomUUID(), device.hostname || hostname, hostname, device.id, ip]);
        this.logger.log(`PC ${hostname} joined Tailscale`);
      } else if (pc.tailscale_device_id !== device.id || pc.tailscale_ip !== ip) {
        await this.db.query('UPDATE egress_pcs SET tailscale_device_id = $2, tailscale_ip = $3 WHERE id = $1', [pc.id, device.id, ip]);
      }
    }
    const used = new Set((await this.db.query('SELECT slot FROM egress_pcs WHERE slot IS NOT NULL')).rows.map((row) => row.slot));
    const free = this.slots().filter((slot) => !used.has(slot));
    const waiting = (await this.db.query('SELECT id FROM egress_pcs WHERE slot IS NULL AND tailscale_ip IS NOT NULL ORDER BY created_at LIMIT $1', [free.length])).rows;
    for (const [index, pc] of waiting.entries()) await this.db.query('UPDATE egress_pcs SET slot = $2 WHERE id = $1', [pc.id, free[index]]);
  }

  async updatePc(actorUserId: string, id: string, changes: { name?: string; fallback?: 'offline' | 'vps' }) {
    const pc = await this.findPc(id);
    const result = await this.db.query('UPDATE egress_pcs SET name = COALESCE($2, name), fallback = COALESCE($3, fallback) WHERE id = $1 RETURNING *', [id, changes.name ?? null, changes.fallback ?? null]);
    await this.audit.record({ actorUserId, action: 'egress.pc_updated', entityType: 'egress_pc', entityId: id, metadata: { from: { name: pc.name, fallback: pc.fallback }, to: changes } });
    return result.rows[0];
  }

  /** Moves the PC's lines to the VPS, takes it out of Tailscale and frees its slot. */
  async removePc(actorUserId: string, id: string) {
    const pc = await this.findPc(id);
    if (pc.slot) {
      const lines = await this.db.query("SELECT id, tenant_id FROM whatsapp_numbers WHERE waxum_node = $1 AND status <> 'removed'", [pc.slot]);
      for (const line of lines.rows) await this.numbers.moveToWaxumNode(line.tenant_id, actorUserId, line.id, MAIN_WAXUM_NODE);
    }
    if (pc.tailscale_device_id) await this.call(`/device/${pc.tailscale_device_id}`, { method: 'DELETE' }).catch((error) => {
      if ((error as { status?: number }).status !== 404) throw error;
    });
    await this.db.query('DELETE FROM egress_pcs WHERE id = $1', [id]);
    if (pc.slot) this.edgeKeys.delete(pc.slot);
    await this.audit.record({ actorUserId, action: 'egress.pc_removed', entityType: 'egress_pc', entityId: id, metadata: { name: pc.name, slot: pc.slot } });
    return { removed: true };
  }

  // The exits a line can be moved to: the VPS plus every slot with a PC.
  async nodes() {
    const pcs = await this.db.query(`SELECT slot, name, route = 'pc' AND route_reported_at > now() - make_interval(secs => $1) AS online FROM egress_pcs WHERE slot IS NOT NULL ORDER BY created_at`, [REPORT_STALE_SECONDS]);
    return { items: [{ node: MAIN_WAXUM_NODE, label: 'VPS', online: true }, ...pcs.rows.map((pc) => ({ node: pc.slot, label: pc.name, online: pc.online }))] };
  }

  /**
   * Polled every 10 s by the watcher of each slot (infra/egress/edge-entrypoint.sh),
   * which reports the route it is on. Answers `key=value` lines so the shell
   * needs no JSON parser; no PC on the slot means empty values.
   */
  async slotConfig(slot: string, route: string, loggedIn: boolean) {
    if (!this.slots().includes(slot)) throw new NotFoundException(`Vaga ${slot} não existe`);
    const result = await this.db.query(`
      UPDATE egress_pcs SET route = $2, route_reported_at = now(),
        offline_since = CASE WHEN $2 = 'pc' THEN NULL ELSE COALESCE(offline_since, now()) END
      WHERE slot = $1 RETURNING tailscale_ip, fallback
    `, [slot, route]);
    const pc = result.rows[0];
    // Not answering: the PC may have rejoined Tailscale with a new IP.
    if (pc && route !== 'pc') await this.syncPcs(false);
    if (!pc?.tailscale_ip) return 'exit_node=\nfallback=\nauth_key=\n';
    const authKey = loggedIn ? '' : await this.edgeKey(slot);
    return `exit_node=${pc.tailscale_ip}\nfallback=${pc.fallback}\nauth_key=${authKey}\n`;
  }

  private async edgeKey(slot: string) {
    const cached = this.edgeKeys.get(slot);
    if (cached && cached.expiresAt > Date.now()) return cached.key;
    const key = await this.createKey(EDGE_TAG, EDGE_KEY_SECONDS, `VPS ${slot}`, false);
    this.edgeKeys.set(slot, { key, expiresAt: Date.now() + (EDGE_KEY_SECONDS - 300) * 1000 });
    return key;
  }

  private async findPc(id: string) {
    const result = await this.db.query('SELECT * FROM egress_pcs WHERE id = $1', [id]);
    if (!result.rows[0]) throw new NotFoundException('PC não encontrado');
    return result.rows[0];
  }

  private async devices() {
    return ((await this.call('/tailnet/-/devices')).devices ?? []) as Device[];
  }

  private async createKey(tag: string, expirySeconds: number, description: string, reusable: boolean) {
    const result = await this.call('/tailnet/-/keys', {
      method: 'POST',
      body: JSON.stringify({ capabilities: { devices: { create: { reusable, ephemeral: false, preauthorized: true, tags: [tag] } } }, expirySeconds, description: description.replace(/[^\w -]/g, '').slice(0, 50) }),
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
