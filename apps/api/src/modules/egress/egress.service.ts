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
import { isProxySlot, REPORT_STALE_SECONDS } from './pc-network';

export { REPORT_STALE_SECONDS };
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

  slots() { return [...waxumNodes().keys()].filter((node) => node !== MAIN_WAXUM_NODE && !isProxySlot(node)); }

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
      // Wrapped in `powershell -Command` so it also runs when pasted into cmd.exe. No `$` inside the
      // quotes: pasted into PowerShell, the outer shell would expand `$env:ProgramFiles` to an
      // unquoted path with a space. `--source winget` skips the Microsoft Store source and its prompts.
      windows: `powershell -NoProfile -Command "winget install -e --id Tailscale.Tailscale --source winget --silent --accept-source-agreements --accept-package-agreements; Start-Sleep 5; & (Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Tailscale\\tailscale.exe') ${up} --unattended; powercfg /change standby-timeout-ac 0"`,
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
      SELECT p.id, p.name, p.slot, p.tailscale_ip, p.route, p.route_reported_at, p.offline_since, p.created_at,
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

  async updatePc(actorUserId: string, id: string, changes: { name?: string }) {
    const pc = await this.findPc(id);
    const result = await this.db.query('UPDATE egress_pcs SET name = COALESCE($2, name) WHERE id = $1 RETURNING *', [id, changes.name ?? null]);
    await this.audit.record({ actorUserId, action: 'egress.pc_updated', entityType: 'egress_pc', entityId: id, metadata: { from: { name: pc.name }, to: changes } });
    return result.rows[0];
  }

  /**
   * Moves the PC's lines to the online PC with the fewest lines, takes it out of Tailscale
   * and frees its slot. Lines never go to the VPS, so a PC with lines and no other online
   * PC to take them cannot be removed.
   */
  async removePc(actorUserId: string, id: string) {
    const pc = await this.findPc(id);
    if (pc.slot) {
      const lines = (await this.db.query("SELECT id, tenant_id FROM whatsapp_numbers WHERE waxum_node = $1 AND status <> 'removed'", [pc.slot])).rows;
      if (lines.length) {
        const target = (await this.db.query(`
          SELECT p.slot FROM egress_pcs p
          WHERE p.slot IS NOT NULL AND p.slot <> $1 AND p.route = 'pc' AND p.route_reported_at > now() - make_interval(secs => $2)
          ORDER BY (SELECT count(*) FROM whatsapp_numbers n WHERE n.waxum_node = p.slot AND n.status <> 'removed') LIMIT 1
        `, [pc.slot, REPORT_STALE_SECONDS])).rows[0]?.slot as string | undefined;
        if (!target) throw new BadRequestException('Nenhum outro PC online para receber os números deste PC. Ligue outro PC antes de remover.');
        for (const line of lines) await this.numbers.moveToWaxumNode(line.tenant_id, actorUserId, line.id, target);
      }
    }
    if (pc.tailscale_device_id) await this.call(`/device/${pc.tailscale_device_id}`, { method: 'DELETE' }).catch((error) => {
      if ((error as { status?: number }).status !== 404) throw error;
    });
    await this.db.query('DELETE FROM egress_pcs WHERE id = $1', [id]);
    if (pc.slot) this.edgeKeys.delete(pc.slot);
    await this.audit.record({ actorUserId, action: 'egress.pc_removed', entityType: 'egress_pc', entityId: id, metadata: { name: pc.name, slot: pc.slot } });
    return { removed: true };
  }

  // The exits a line can be moved to: every slot with a PC or a proxy. Never the VPS.
  async nodes() {
    const pcs = await this.pcExits();
    const proxies = (await this.db.query(`
      SELECT slot, name, COALESCE(route = 'proxy' AND route_reported_at > now() - make_interval(secs => $1), false) AS online FROM egress_proxies ORDER BY created_at
    `, [REPORT_STALE_SECONDS])).rows;
    return { items: [...pcs.map((pc) => ({ node: pc.slot, label: pc.name, online: pc.online })), ...proxies.map((proxy) => ({ node: proxy.slot, label: `Proxy: ${proxy.name}`, online: proxy.online === true }))] };
  }

  /**
   * The PCs that hold a slot, with the id that identifies them while their slot
   * may change. `online`: the slot reports going out through the PC, recently.
   * Also read by the WhatsApp provisioning (docs/provisioning-contract.md, section 4).
   */
  async pcExits(id?: string): Promise<Array<{ id: string; name: string; slot: string; online: boolean }>> {
    const result = await this.db.query(`
      SELECT id, name, slot, COALESCE(route = 'pc' AND route_reported_at > now() - make_interval(secs => $1), false) AS online
      FROM egress_pcs WHERE slot IS NOT NULL AND ($2::text IS NULL OR id = $2) ORDER BY created_at
    `, [REPORT_STALE_SECONDS, id ?? null]);
    return result.rows.map((pc) => ({ id: pc.id, name: pc.name, slot: pc.slot, online: pc.online === true }));
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
        offline_since = CASE WHEN $2 = 'pc' THEN NULL ELSE COALESCE(offline_since, now()) END,
        online_since = CASE WHEN $2 = 'pc' THEN COALESCE(online_since, now()) END
      WHERE slot = $1 RETURNING id, name, tailscale_ip
    `, [slot, route]);
    const pc = result.rows[0];
    if (pc) await this.recordPcRoute(pc.id, slot, pc.name, route === 'pc' ? 'online' : 'offline')
      .catch((error) => this.logger.warn(`PC event of ${slot} not recorded: ${String(error?.message ?? error).slice(0, 200)}`));
    // Not answering: the PC may have rejoined Tailscale with a new IP.
    if (pc && route !== 'pc') await this.syncPcs(false);
    if (!pc?.tailscale_ip) return 'exit_node=\nauth_key=\n';
    const authKey = loggedIn ? '' : await this.edgeKey(slot);
    return `exit_node=${pc.tailscale_ip}\nauth_key=${authKey}\n`;
  }

  /**
   * History of each PC's internet (egress_pc_events, migration 085): one row when it starts going
   * out through the PC and one when it stops, not one per 10 s report. A first report that is not
   * `pc` is recorded too, so the history starts with the PC's real state.
   */
  private recordPcRoute(pcId: string, slot: string, name: string, kind: 'online' | 'offline') {
    return this.db.query(`
      WITH last AS (SELECT kind FROM egress_pc_events WHERE pc_id = $1 ORDER BY occurred_at DESC LIMIT 1)
      INSERT INTO egress_pc_events (pc_id, slot, pc_name, kind)
      SELECT $1, $2, $3, $4::text
      WHERE CASE WHEN $4::text = 'online' THEN COALESCE((SELECT kind FROM last), '') <> 'online'
        ELSE COALESCE((SELECT kind FROM last), 'online') = 'online' END
    `, [pcId, slot, name, kind]);
  }

  /**
   * A PC whose slot stopped reporting never gets to say it went offline: called by the egress
   * pool's tick, this records it as `silent` once; its next report records it `online` again.
   */
  recordSilentPcs() {
    return this.db.query(`
      INSERT INTO egress_pc_events (pc_id, slot, pc_name, kind, detail)
      SELECT p.id, p.slot, p.name, 'silent', jsonb_build_object('lastReportAt', p.route_reported_at)
      FROM egress_pcs p
      WHERE p.slot IS NOT NULL AND (p.route_reported_at IS NULL OR p.route_reported_at < now() - make_interval(secs => $1))
        AND (SELECT e.kind FROM egress_pc_events e WHERE e.pc_id = p.id ORDER BY e.occurred_at DESC LIMIT 1) = 'online'
    `, [REPORT_STALE_SECONDS]);
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
