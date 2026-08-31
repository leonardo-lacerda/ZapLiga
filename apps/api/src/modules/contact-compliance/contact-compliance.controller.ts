import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { parse } from 'csv-parse/sync';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { ContactComplianceService, normalizeContactPhone } from './contact-compliance.service';
import { CreateSuppressionDto, SUPPRESSION_REASONS } from './dto/create-suppression.dto';
import { LiftSuppressionDto } from './dto/lift-suppression.dto';

const csvCell = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;

@Controller()
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
@Roles('leader', 'super_admin')
export class ContactComplianceController {
  constructor(private readonly compliance: ContactComplianceService) {}

  @Get('/api/tenants/:tenantId/contact-suppressions')
  list(@CurrentTenant() tenantId: string, @Query('search') search = '', @Query('limit') limit = '100', @Query('offset') offset = '0') {
    return this.compliance.list(tenantId, search, Number(limit), Number(offset));
  }

  @Get('/api/tenants/:tenantId/contact-suppressions/export.csv')
  async export(@CurrentTenant() tenantId: string, @Res() response: Response) {
    const items = await this.compliance.exportAll(tenantId);
    const lines = ['phone,reason,source,notes,created_at', ...items.map((row: any) => [row.phone, row.reason, row.source, row.notes, row.created_at].map(csvCell).join(','))];
    response.setHeader('content-type', 'text/csv; charset=utf-8');
    response.setHeader('content-disposition', 'attachment; filename="lista-nao-contato.csv"');
    response.send(`\uFEFF${lines.join('\r\n')}`);
  }

  @Post('/api/tenants/:tenantId/contact-suppressions')
  create(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Body() body: CreateSuppressionDto) {
    return this.compliance.suppress({ tenantId, phone: body.phone, reason: body.reason, source: body.source ?? 'lead_action', notes: body.notes, actorUserId: user.id });
  }

  @Post('/api/tenants/:tenantId/contact-suppressions/import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  async import(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @UploadedFile() file: Express.Multer.File) {
    if (!file?.buffer) throw new BadRequestException('Envie um CSV no campo file');
    let rows: Record<string, unknown>[];
    try { rows = parse(file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, bom: true, trim: true }); }
    catch { throw new BadRequestException('CSV inválido; use as colunas phone,reason,notes'); }
    if (rows.length > 50_000) throw new BadRequestException('O CSV excede 50.000 linhas');
    let duplicated = 0; let skipped = 0;
    const entries = new Map<string, { phone: string; reason: (typeof SUPPRESSION_REASONS)[number]; notes?: string }>();
    for (const row of rows) {
      const phone = normalizeContactPhone(row.phone ?? row.telefone);
      const reason = String(row.reason ?? 'internal_policy') as (typeof SUPPRESSION_REASONS)[number];
      if (phone.length < 10 || phone.length > 15 || !SUPPRESSION_REASONS.includes(reason)) { skipped++; continue; }
      if (entries.has(phone)) { duplicated++; continue; }
      entries.set(phone, { phone, reason, notes: String(row.notes ?? row.observacao ?? '').slice(0, 500) });
    }
    const result = await this.compliance.bulkSuppress(tenantId, [...entries.values()], user.id);
    return { imported: result.imported, duplicated: duplicated + result.existing, skipped, total: rows.length };
  }

  @Get('/api/tenants/:tenantId/leads/:leadId/compliance')
  forLead(@CurrentTenant() tenantId: string, @Param('leadId') leadId: string) { return this.compliance.forLead(tenantId, leadId); }

  @Delete('/api/tenants/:tenantId/contact-suppressions/:id')
  lift(@CurrentTenant() tenantId: string, @Param('id') id: string, @Body() body: LiftSuppressionDto, @CurrentUser() user: any) {
    return this.compliance.lift(tenantId, id, body.reason, user.id);
  }
}
