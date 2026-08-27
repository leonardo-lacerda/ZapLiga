import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';

@Controller()
export class SdrsController {
  constructor(private readonly db: DatabaseService) {}

  @Post('/api/sdrs')
  async create(@Body() body: any) {
    const name = String(body.name ?? '').trim();
    if (!name) throw new BadRequestException('name é obrigatório');
    return (await this.db.query(`INSERT INTO sdrs (id,name) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING *`, [randomUUID(), name])).rows[0];
  }

  @Get('/api/sdrs')
  list() { return this.db.query('SELECT * FROM sdrs ORDER BY name').then((result) => result.rows); }
}
