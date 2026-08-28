import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });

  async onModuleInit() {
    await this.migrate();
  }

  async onModuleDestroy() { await this.pool.end(); }

  query<T extends QueryResultRow = any>(text: string, params: unknown[] = []) {
    return this.pool.query<T>(text, params);
  }

  async transaction<T>(fn: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async migrate() {
    const compiledDir = join(__dirname, 'migrations');
    const sourceDir = join(process.cwd(), 'apps/api/src/database/migrations');
    const hasCompiledMigrations = existsSync(compiledDir)
      && readdirSync(compiledDir).some((file) => file.endsWith('.sql'));
    const migrationsDir = hasCompiledMigrations ? compiledDir : sourceDir;
    const files = readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort();
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(982374)');
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      const applied = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
      const appliedVersions = new Set(applied.rows.map((row) => row.version));
      for (const file of files) {
        if (appliedVersions.has(file)) continue;
        const sql = readFileSync(join(migrationsDir, file), 'utf8');
        await client.query('BEGIN');
        try {
          await client.query('SELECT set_config($1, $2, true)', ['zapcall.legacy_tenant_id', process.env.LEGACY_TENANT_ID ?? 'tenant-legado']);
          await client.query('SELECT set_config($1, $2, true)', ['zapcall.legacy_tenant_name', process.env.LEGACY_TENANT_NAME ?? 'Operação legada']);
          await client.query('SELECT set_config($1, $2, true)', ['zapcall.legacy_tenant_slug', process.env.LEGACY_TENANT_SLUG ?? 'operacao-legada']);
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(982374)').catch(() => undefined);
      client.release();
    }
  }

  async migrationStatus() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const result = await this.pool.query<{ version: string; applied_at: string }>(
      'SELECT version, applied_at FROM schema_migrations ORDER BY version',
    );
    return result.rows;
  }
}
