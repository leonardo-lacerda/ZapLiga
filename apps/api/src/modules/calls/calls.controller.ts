import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { DialerService } from '../dialer/dialer.service';
import { DatabaseService } from '../../database/database.service';

@Controller()
export class CallsController {
  constructor(private readonly db: DatabaseService, private readonly dialer: DialerService) {}

  @Get('/api/calls')
  list(@Query('limit') limit = '100') {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    return this.db.query(`SELECT c.*, l.name AS lead_name, l.phone AS lead_phone, n.label AS number_label, s.name AS sdr_name FROM calls c JOIN leads l ON l.id = c.lead_id JOIN whatsapp_numbers n ON n.id = c.number_id JOIN sdrs s ON s.id = c.sdr_id ORDER BY c.created_at DESC LIMIT $1`, [safeLimit]).then((result) => result.rows);
  }

  @Post('/api/calls/manual')
  async manual(@Body() body: any) {
    const leadId = String(body.leadId ?? '').trim();
    if (!leadId) throw new BadRequestException('leadId é obrigatório');
    try { return await this.dialer.manualCall(leadId); }
    catch (error) { throw new BadRequestException(String((error as Error).message ?? error)); }
  }

  @Post('/api/calls/:id/outcome')
  outcome(@Param('id') id: string, @Body() body: any) { return this.dialer.recordOutcome(id, String(body.outcome ?? 'completed')); }
}
