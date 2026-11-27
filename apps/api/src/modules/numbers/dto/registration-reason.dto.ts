import { IsIn } from 'class-validator';
import { REGISTRATION_REASONS, RegistrationReason } from '../../dialer/line-loss.rules';

/** What the phone showed when WhatsApp refused its registration (docs/line-loss-causes.md). */
export class RegistrationReasonDto {
  @IsIn(REGISTRATION_REASONS) reason!: RegistrationReason;
}
