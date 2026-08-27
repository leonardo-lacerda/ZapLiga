import { BadRequestException, Body, Controller, Delete, Get, Param, NotFoundException, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { parse } from 'csv-parse/sync';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';

const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '');

@Controller()
export class LeadsController {
  constructor(private readonly db: DatabaseService) {}

  @Post('/api/leads')
  async create(@Body() body: any) {
    const phone = digits(body.phone);
    if (!phone || !String(body.name ?? '').trim()) throw new BadRequestException('name e phone são obrigatórios');
    return (await this.db.query(`INSERT INTO leads (id,name,phone) VALUES ($1,$2,$3) ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name RETURNING *`, [randomUUID(), String(body.name).trim(), phone])).rows[0];
  }

  @Post('/api/leads/import')
  @UseInterceptors(FileInterceptor('file'))
  async import(@UploadedFile() file: Express.Multer.File) {
    if (!file?.buffer) throw new BadRequestException('Envie um arquivo CSV no campo file');
    let records: any[];
    try { records = parse(file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, bom: true, trim: true }); }
    catch { throw new BadRequestException('CSV inválido; use as colunas name,phone'); }
    let imported = 0;
    for (const row of records) {
      const phone = digits(row.phone); const name = String(row.name ?? '').trim();
      if (!phone || !name) continue;
      await this.db.query(`INSERT INTO leads (id,name,phone) VALUES ($1,$2,$3) ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name`, [randomUUID(), name, phone]);
      imported++;
    }
    return { imported };
  }

  @Get('/api/leads')
  list(@Query('status') status?: string) { return this.db.query(status ? 'SELECT * FROM leads WHERE status = $1 ORDER BY created_at DESC' : 'SELECT * FROM leads ORDER BY created_at DESC', status ? [status] : []).then((result) => result.rows); }

  @Delete('/api/leads')
  async clear() {
    const active = await this.db.query(`SELECT count(*)::int AS count FROM calls WHERE status IN ('reserved', 'dialing', 'media_active')`);
    if (Number(active.rows[0].count) > 0) throw new BadRequestException('Pause o discador e aguarde as chamadas em andamento terminarem');
    return this.db.transaction(async (client) => {
      const calls = await client.query('DELETE FROM calls');
      const leads = await client.query('DELETE FROM leads');
      return { ok: true, deletedLeads: leads.rowCount ?? 0, deletedCalls: calls.rowCount ?? 0 };
    });
  }

  @Post('/api/leads/:id/reset')
  async reset(@Param('id') id: string) {
    const active = await this.db.query(`SELECT status FROM calls WHERE lead_id = $1 AND status IN ('reserved', 'dialing', 'media_active') LIMIT 1`, [id]);
    if (active.rows[0]) throw new BadRequestException('Não é possível resetar um contato durante uma chamada');
    const result = await this.db.query(`UPDATE leads SET status = 'queued', attempts = 0, next_eligible_at = now(), do_not_call = false WHERE id = $1 RETURNING *`, [id]);
    if (!result.rows[0]) throw new NotFoundException('Lead não encontrado');
    return result.rows[0];
  }
}
