import { Controller, Get, Headers, Param, UnauthorizedException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { NumbersService } from '../numbers/numbers.service';

/**
 * The device profile a Waxum asks for before opening a session's handshake
 * (docs/device-profile.md). Called by the Waxum itself, with the key it already shares with
 * the API, so it is not behind the user guards: the caller is the container, not a person.
 *
 * `{ profile: null }` is a normal answer: the line has no frozen profile and the Waxum keeps
 * its environment defaults, which is the behaviour before profiles existed.
 */
@Controller('/api/internal/waxum')
export class WaxumInternalController {
  constructor(private readonly db: DatabaseService, private readonly numbers: NumbersService) {}

  private authorize(authorization?: string) {
    if (!process.env.WAXUM_API_KEY || authorization !== `Bearer ${process.env.WAXUM_API_KEY}`) throw new UnauthorizedException();
  }

  @Get('/sessions/:sessionId/device-profile')
  async deviceProfile(@Param('sessionId') sessionId: string, @Headers('authorization') authorization?: string) {
    this.authorize(authorization);
    const line = (await this.db.query('SELECT id, tenant_id FROM whatsapp_numbers WHERE waxum_session_id = $1 AND status <> \'removed\' LIMIT 1', [sessionId])).rows[0];
    if (!line) return { profile: null };
    return { profile: await this.numbers.deviceProfile(line.tenant_id, line.id) };
  }
}
