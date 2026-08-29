import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { DatabaseService } from '../database/database.service';

async function main() {
  const email = String(process.env.SUPERADMIN_EMAIL ?? '').trim().toLowerCase();
  const password = String(process.env.SUPERADMIN_PASSWORD ?? '');
  const name = String(process.env.SUPERADMIN_NAME ?? 'Admin supremo').trim();
  if (!email || !password) throw new Error('Defina SUPERADMIN_EMAIL e SUPERADMIN_PASSWORD antes de executar o bootstrap');
  if (process.env.NODE_ENV === 'production' && password === 'change-this-password') throw new Error('SUPERADMIN_PASSWORD ainda está com o valor de exemplo; defina uma senha real antes de rodar em produção');
  const db = new DatabaseService();
  await db.onModuleInit();
  try {
    const current = await db.query('SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1', [email]);
    const rounds = Math.max(10, Number(process.env.BCRYPT_ROUNDS ?? 12));
    const passwordHash = await bcrypt.hash(password, rounds);
    if (current.rows[0]) {
      await db.query("UPDATE users SET password_hash = $1, platform_role = 'super_admin', status = 'active', updated_at = now() WHERE id = $2", [passwordHash, current.rows[0].id]);
      console.log(`Admin supremo atualizado: ${email}`);
      return;
    }
    const userId = randomUUID();
    await db.transaction(async (client) => {
      await client.query(`INSERT INTO users (id, name, email, password_hash, platform_role) VALUES ($1, $2, $3, $4, 'super_admin')`, [userId, name, email, passwordHash]);
      await client.query(`INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata) VALUES ($1, $2, 'user.bootstrap_admin', 'user', $3, '{}'::jsonb)`, [randomUUID(), userId, userId]);
    });
    console.log(`Admin supremo criado: ${email}`);
  } finally {
    await db.onModuleDestroy();
  }
}

void main().catch((error) => { console.error(String(error)); process.exitCode = 1; });
