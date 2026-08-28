import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { DatabaseService } from '../../database/database.service';
import { normalizeEmail, publicUser } from './users.utils';

@Injectable()
export class UsersService {
  constructor(private readonly db: DatabaseService) {}

  async hashPassword(password: string) {
    const rounds = Math.max(10, Number(process.env.BCRYPT_ROUNDS ?? 12));
    return bcrypt.hash(password, rounds);
  }

  comparePassword(password: string, hash: string) {
    return bcrypt.compare(password, hash);
  }

  findByEmail(email: string) {
    return this.db.query('SELECT * FROM users WHERE lower(email) = lower($1) LIMIT 1', [normalizeEmail(email)]).then((result) => result.rows[0] ?? null);
  }

  async findById(id: string) {
    const result = await this.db.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
    return result.rows[0] ?? null;
  }

  async listAll() {
    return (await this.db.query(`
      SELECT u.id, u.name, u.email, u.platform_role, u.status, u.created_at, u.last_login_at,
        COALESCE(json_agg(json_build_object('tenantId', tm.tenant_id, 'tenantName', t.name, 'role', tm.role, 'status', tm.status)) FILTER (WHERE tm.id IS NOT NULL), '[]'::json) AS memberships
      FROM users u
      LEFT JOIN tenant_memberships tm ON tm.user_id = u.id
      LEFT JOIN tenants t ON t.id = tm.tenant_id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `)).rows;
  }

  async requireById(id: string) {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('Usuário não encontrado');
    return user;
  }

  async create(input: { name: string; email: string; password: string; platformRole?: 'user' | 'super_admin' }) {
    const email = normalizeEmail(input.email);
    const passwordHash = await this.hashPassword(input.password);
    return this.createWithHash({ ...input, email, passwordHash });
  }

  async createWithHash(input: { name: string; email: string; passwordHash: string; platformRole?: 'user' | 'super_admin' }, executor = this.db) {
    try {
      const result = await executor.query(`
        INSERT INTO users (id, name, email, password_hash, platform_role)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `, [randomUUID(), input.name.trim(), normalizeEmail(input.email), input.passwordHash, input.platformRole ?? 'user']);
      return result.rows[0];
    } catch (error) {
      if (String(error).includes('users_email_lower_idx') || String(error).includes('users_email_key')) throw new ConflictException('Já existe um usuário com este e-mail');
      throw error;
    }
  }

  async markLogin(id: string) {
    const result = await this.db.query('UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1 RETURNING *', [id]);
    return result.rows[0] ?? null;
  }

  async setStatus(id: string, status: 'active' | 'blocked') {
    const result = await this.db.transaction(async (client) => {
      const updated = await client.query('UPDATE users SET status = $1, updated_at = now() WHERE id = $2 RETURNING *', [status, id]);
      if (status === 'blocked' && updated.rows[0]) await client.query('UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1 AND revoked_at IS NULL', [id]);
      return updated;
    });
    if (!result.rows[0]) throw new NotFoundException('Usuário não encontrado');
    return result.rows[0];
  }

  sanitize(user: any) { return publicUser(user); }
}
