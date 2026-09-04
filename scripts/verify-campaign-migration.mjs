import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const sourceUrl = new URL(process.env.DATABASE_URL ?? 'postgres://zapcall:zapcall@127.0.0.1:5432/zapcall');
const testDatabase = `zapcall_campaign_migration_${process.pid}_${Date.now()}`;
assert(/^[a-z0-9_]+$/.test(testDatabase), 'Nome inseguro para o banco temporário');

const adminUrl = new URL(sourceUrl);
adminUrl.pathname = '/postgres';
const testUrl = new URL(sourceUrl);
testUrl.pathname = `/${testDatabase}`;
const admin = new pg.Client({ connectionString: adminUrl.toString() });
let database;
let adminConnected = false;
let databaseCreated = false;

const applyMigration = async (client, migrationsDir, file) => {
  const sql = await readFile(join(migrationsDir, file), 'utf8');
  await client.query('BEGIN');
  try {
    await client.query('SELECT set_config($1, $2, true)', ['zapcall.legacy_tenant_id', 'tenant-legado']);
    await client.query('SELECT set_config($1, $2, true)', ['zapcall.legacy_tenant_name', 'Operação legada']);
    await client.query('SELECT set_config($1, $2, true)', ['zapcall.legacy_tenant_slug', 'operacao-legada']);
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
};

try {
  await admin.connect();
  adminConnected = true;
  await admin.query(`CREATE DATABASE "${testDatabase}"`);
  databaseCreated = true;
  database = new pg.Client({ connectionString: testUrl.toString() });
  await database.connect();
  await database.query('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');

  const migrationsDir = join(process.cwd(), 'apps/api/src/database/migrations');
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
  const campaignMigration = '043_campaigns_read_model.sql';
  const lifecycleMigration = '044_campaign_lifecycle.sql';
  const legacyMigrations = files.filter((file) => file < campaignMigration);
  assert(files.includes(campaignMigration), `Migration ausente: ${campaignMigration}`);
  assert(files.includes(lifecycleMigration), `Migration ausente: ${lifecycleMigration}`);

  for (const file of legacyMigrations) await applyMigration(database, migrationsDir, file);

  await database.query("INSERT INTO leads (id, tenant_id, folder_id, name, phone) VALUES ('legacy-lead', 'tenant-legado', 'folder-default-tenant-legado', 'Lead legado', '5511999990001')");
  await database.query("INSERT INTO sdrs (id, tenant_id, name) VALUES ('legacy-sdr', 'tenant-legado', 'SDR legado')");
  await database.query("INSERT INTO whatsapp_numbers (id, tenant_id, label, phone, waxum_session_id, status) VALUES ('legacy-number', 'tenant-legado', 'Linha legada', '5511999990002', 'legacy-session', 'connected')");
  await database.query("INSERT INTO calls (id, tenant_id, folder_id, lead_id, number_id, sdr_id, status, attempt_number) VALUES ('legacy-call', 'tenant-legado', 'folder-default-tenant-legado', 'legacy-lead', 'legacy-number', 'legacy-sdr', 'ended', 1)");

  const before = (await database.query("SELECT status, attempt_number, lead_id, number_id, sdr_id, folder_id FROM calls WHERE id = 'legacy-call'")).rows[0];
  await applyMigration(database, migrationsDir, campaignMigration);
  const after = (await database.query("SELECT status, attempt_number, lead_id, number_id, sdr_id, folder_id FROM calls WHERE id = 'legacy-call'")).rows[0];
  assert(JSON.stringify(after) === JSON.stringify(before), 'A migration alterou a chamada legada');

  const campaign = (await database.query("SELECT * FROM campaigns WHERE tenant_id = 'tenant-legado' AND is_legacy = true")).rows[0];
  assert(campaign?.current_version === 1, 'Campanha legada ou versão atual ausente');
  const version = (await database.query('SELECT * FROM campaign_versions WHERE tenant_id = $1 AND campaign_id = $2 AND version = 1', ['tenant-legado', campaign.id])).rows[0];
  assert(version?.config_hash?.length === 32, 'Snapshot versionado sem hash');
  assert(version.config_snapshot.source === 'legacy_operation', 'Snapshot legado sem origem canônica');
  assert(version.config_snapshot.folder_ids.includes('folder-default-tenant-legado'), 'Snapshot não preservou a pasta legada');
  assert(version.config_snapshot.sdr_ids.includes('legacy-sdr'), 'Snapshot não preservou o SDR legado');
  assert(version.config_snapshot.number_ids.includes('legacy-number'), 'Snapshot não preservou a linha legada');

  const links = (await database.query(`SELECT
    (SELECT count(*)::int FROM campaign_sdrs WHERE tenant_id = 'tenant-legado' AND campaign_id = $1) AS sdrs,
    (SELECT count(*)::int FROM campaign_numbers WHERE tenant_id = 'tenant-legado' AND campaign_id = $1) AS numbers`, [campaign.id])).rows[0];
  assert(links.sdrs === 1 && links.numbers === 1, 'Backfill não vinculou recursos legados');

  await applyMigration(database, migrationsDir, lifecycleMigration);
  const lifecycleCampaign = (await database.query('SELECT lock_version, draft_config, current_version FROM campaigns WHERE id = $1', [campaign.id])).rows[0];
  assert(lifecycleCampaign.lock_version === 0 && lifecycleCampaign.current_version === 1, 'Migration de ciclo de vida alterou a versão legada');
  assert(lifecycleCampaign.draft_config.source === 'legacy_operation', 'Migration de ciclo de vida não preservou a configuração legada');
  await database.query("INSERT INTO campaigns (id, tenant_id, name, status, folder_id, current_version, is_legacy, draft_config) VALUES ('draft-test', 'tenant-legado', 'Rascunho de teste', 'draft', 'folder-default-tenant-legado', NULL, false, '{}'::jsonb)");
  let immutableVersionRejected = false;
  try {
    await database.query("UPDATE campaign_versions SET change_reason = 'mutação indevida' WHERE id = $1", [version.id]);
  } catch (error) {
    immutableVersionRejected = error?.code === '55000';
  }
  assert(immutableVersionRejected, 'Versão publicada aceitou mutação');

  await database.query("INSERT INTO tenants (id, name, slug, status) VALUES ('tenant-other', 'Outro tenant', 'outro-tenant', 'active')");
  await database.query("INSERT INTO sdrs (id, tenant_id, name) VALUES ('other-sdr', 'tenant-other', 'SDR externo')");
  let crossTenantRejected = false;
  try {
    await database.query('INSERT INTO campaign_sdrs (tenant_id, campaign_id, sdr_id) VALUES ($1, $2, $3)', ['tenant-legado', campaign.id, 'other-sdr']);
  } catch (error) {
    crossTenantRejected = error?.code === '23503';
  }
  assert(crossTenantRejected, 'FK composta aceitou vínculo de SDR entre tenants');

  await database.query("INSERT INTO whatsapp_numbers (id, tenant_id, label, waxum_session_id, status) VALUES ('other-number', 'tenant-other', 'Linha nova', 'other-session', 'connected')");
  const otherCampaign = (await database.query("SELECT id FROM campaigns WHERE tenant_id = 'tenant-other' AND is_legacy = true")).rows[0];
  const liveLinks = (await database.query(`SELECT
    (SELECT count(*)::int FROM campaign_sdrs WHERE tenant_id = 'tenant-other' AND campaign_id = $1) AS sdrs,
    (SELECT count(*)::int FROM campaign_numbers WHERE tenant_id = 'tenant-other' AND campaign_id = $1) AS numbers`, [otherCampaign.id])).rows[0];
  assert(liveLinks.sdrs === 1 && liveLinks.numbers === 1, 'Campanha legada nova não acompanhou recursos conectados depois do tenant');

  console.log('Campaign migration OK: legado preservado, versões imutáveis, read model sincronizado e vínculo cross-tenant bloqueado.');
} finally {
  if (database) await database.end().catch(() => undefined);
  if (adminConnected) {
    if (databaseCreated) await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}
