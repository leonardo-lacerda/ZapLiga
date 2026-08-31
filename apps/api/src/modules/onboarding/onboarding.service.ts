import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class OnboardingService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}
  async status(tenantId: string, userId: string) {
    const result = await this.db.query(`SELECT
      (u.email_verified_at IS NOT NULL) AS email_verified,
      NOT EXISTS (SELECT 1 FROM legal_document_versions d WHERE d.retired_at IS NULL AND d.effective_at <= now() AND NOT EXISTS (SELECT 1 FROM user_legal_acceptances a WHERE a.user_id = $2 AND a.legal_document_version_id = d.id)) AS legal_accepted,
      EXISTS (SELECT 1 FROM whatsapp_numbers n WHERE n.tenant_id = $1 AND n.status <> 'removed') AS number_connected,
      EXISTS (SELECT 1 FROM tenant_memberships tm WHERE tm.tenant_id = $1 AND tm.role = 'sdr' AND tm.status = 'active') AS sdr_invited,
      EXISTS (SELECT 1 FROM leads l WHERE l.tenant_id = $1) AS leads_imported,
      EXISTS (SELECT 1 FROM tenant_onboarding_steps os WHERE os.tenant_id = $1 AND os.step = 'audio_tested') AS audio_tested,
      EXISTS (SELECT 1 FROM calls c WHERE c.tenant_id = $1 AND c.source = 'manual') AS test_call_completed,
      EXISTS (SELECT 1 FROM audit_logs al WHERE al.tenant_id = $1 AND al.action IN ('dialer.schedule_changed','dialer.settings_changed')) AS settings_reviewed,
      EXISTS (SELECT 1 FROM audit_logs al WHERE al.tenant_id = $1 AND al.action = 'dialer.started') AS operation_started
      FROM users u WHERE u.id = $2`, [tenantId, userId]);
    const state = result.rows[0] ?? {};
    const steps = [
      ['email_verified', 'Verificar e-mail'], ['legal_accepted', 'Aceitar documentos legais'], ['number_connected', 'Conectar primeiro número'],
      ['sdr_invited', 'Convidar primeiro SDR'], ['leads_imported', 'Criar ou importar contatos'], ['audio_tested', 'Testar áudio'],
      ['test_call_completed', 'Realizar chamada autorizada de teste'], ['settings_reviewed', 'Revisar horários e tentativas'], ['operation_started', 'Iniciar a operação'],
    ].map(([key, label]) => ({ key, label, completed: Boolean(state[key]) }));
    return { steps, completed: steps.filter((step) => step.completed).length, total: steps.length };
  }
  async completeAudio(tenantId: string, userId: string) {
    await this.db.query(`INSERT INTO tenant_onboarding_steps (tenant_id, step, completed_by_user_id) VALUES ($1, 'audio_tested', $2) ON CONFLICT (tenant_id, step) DO NOTHING`, [tenantId, userId]);
    await this.audit.record({ actorUserId: userId, tenantId, action: 'onboarding.audio_tested', entityType: 'tenant', entityId: tenantId });
    return this.status(tenantId, userId);
  }
}
