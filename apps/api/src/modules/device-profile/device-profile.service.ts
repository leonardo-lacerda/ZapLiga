import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { MultiloginClient } from '../../infrastructure/multilogin/multilogin.client';
import { AuditService } from '../audit/audit.service';
import { EntitlementService } from '../billing/entitlement.service';
import { DEVICE_PROFILE_KILLSWITCH_MESSAGE, buildDeviceProfile, deviceProfileKillswitchOn, deviceProfileState, type DeviceProfileV1 } from './device-profile';

const UNIQUE_VIOLATION = '23505';
export const PHONE_TAKEN_MESSAGE = 'Este celular da Multilogin já deu a identidade para outra linha. Escolha outro.';
export const SWAP_WHILE_ACTIVE_MESSAGE = 'A linha está pareada com o celular atual. Volte para "Como está hoje", pareie de novo e só então troque o celular ou o app.';
export const APP_REQUIRED_MESSAGE = 'Diga se o número é WhatsApp ou WhatsApp Business.';

/**
 * New camouflage per line (docs/device-profile.md): the admin's choice for each line and the
 * Multilogin cloud phone its identity is copied from. Nothing here touches a live session: the
 * choice takes effect at the line's next pairing (NumbersService).
 */
@Injectable()
export class DeviceProfileService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly entitlement: EntitlementService,
    private readonly multilogin: MultiloginClient,
  ) {}

  /** The cloud phones, each with the line that already took its identity, if any. */
  async phones() {
    const phones = await this.multilogin.listPhones();
    const taken = (await this.db.query('SELECT multilogin_phone_id, label FROM whatsapp_numbers WHERE multilogin_phone_id = ANY($1::text[])', [phones.map((phone) => phone.id)])).rows as { multilogin_phone_id: string; label: string }[];
    const takenBy = new Map(taken.map((row) => [row.multilogin_phone_id, row.label]));
    return { items: phones.map((phone) => ({ ...phone, takenBy: takenBy.get(phone.id) ?? null })) };
  }

  /** The profile a line gets from a cloud phone that no other line took. */
  async profileFor(multiloginPhoneId: string, business: boolean): Promise<DeviceProfileV1> {
    if (deviceProfileKillswitchOn()) throw new BadRequestException(DEVICE_PROFILE_KILLSWITCH_MESSAGE);
    const taken = (await this.db.query('SELECT 1 FROM whatsapp_numbers WHERE multilogin_phone_id = $1 LIMIT 1', [multiloginPhoneId])).rows[0];
    if (taken) throw new ConflictException(PHONE_TAKEN_MESSAGE);
    const phone = await this.multilogin.getPhone(multiloginPhoneId);
    if (!phone) throw new BadRequestException('Celular não encontrado na Multilogin (ou sem marca, modelo e versão do Android).');
    return buildDeviceProfile(phone, business);
  }

  /**
   * On: the line pairs as the chosen cloud phone from its next QR or code. The first choice copies
   * the phone; choosing another phone copies that one, and changing the app (WhatsApp or Business)
   * rewrites the copy: neither is possible while the line is paired with the current copy. Off: the line pairs as it did before from its next QR or code. The copy is kept, so
   * turning it on again reuses it.
   */
  async setChoice(tenantId: string, actorUserId: string, id: string, enabled: boolean, multiloginPhoneId?: string, business?: boolean) {
    await this.entitlement.assertAction(tenantId, 'write', actorUserId);
    const line = (await this.db.query("SELECT * FROM whatsapp_numbers WHERE id = $1 AND tenant_id = $2 AND status <> 'removed'", [id, tenantId])).rows[0];
    if (!line) throw new NotFoundException('Número não encontrado');
    if (enabled && deviceProfileKillswitchOn()) throw new BadRequestException(DEVICE_PROFILE_KILLSWITCH_MESSAGE);
    const phoneId = multiloginPhoneId ?? line.multilogin_phone_id;
    if (enabled && !phoneId) throw new BadRequestException('Escolha o celular da Multilogin em que o número foi registrado.');
    const swap = enabled && phoneId !== line.multilogin_phone_id;
    if (swap && business === undefined) throw new BadRequestException(APP_REQUIRED_MESSAGE);
    const current = line.device_profile as DeviceProfileV1 | null;
    const appChange = enabled && !swap && business !== undefined && current !== null && current.android.business !== business;
    if ((swap || appChange) && line.device_profile_active) throw new BadRequestException(SWAP_WHILE_ACTIVE_MESSAGE);
    const profile = swap ? await this.profileFor(phoneId, business as boolean)
      : appChange && current ? { ...current, android: { ...current.android, business: business as boolean } } : null;
    let row;
    try {
      row = (await this.db.query(`
        UPDATE whatsapp_numbers SET device_profile_enabled = $3,
          multilogin_phone_id = CASE WHEN $4::jsonb IS NULL THEN multilogin_phone_id ELSE $5 END,
          device_profile = COALESCE($4::jsonb, device_profile),
          device_profile_frozen_at = CASE WHEN $4::jsonb IS NULL THEN device_profile_frozen_at ELSE now() END
        WHERE id = $1 AND tenant_id = $2 RETURNING *
      `, [id, tenantId, enabled, profile ? JSON.stringify(profile) : null, phoneId])).rows[0];
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new ConflictException(PHONE_TAKEN_MESSAGE);
      throw error;
    }
    await this.audit.record({ actorUserId, tenantId, action: 'number.device_profile_changed', entityType: 'whatsapp_number', entityId: id, metadata: { enabled, ...(profile ? { profile } : {}) } });
    return { ...row, device_profile_state: deviceProfileState(row) };
  }
}
