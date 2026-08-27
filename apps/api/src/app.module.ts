import { Module } from '@nestjs/common';
import { DatabaseService } from './database/database.service';
import { RedisService } from './infrastructure/redis/redis.service';
import { WaxumClient } from './infrastructure/waxum/waxum.client';
import { CallsController } from './modules/calls/calls.controller';
import { DialerController } from './modules/dialer/dialer.controller';
import { DialerService } from './modules/dialer/dialer.service';
import { LeadsController } from './modules/leads/leads.controller';
import { HealthController } from './modules/health/health.controller';
import { NumbersController } from './modules/numbers/numbers.controller';
import { SdrGateway } from './modules/sdrs/sdr.gateway';
import { SdrsController } from './modules/sdrs/sdrs.controller';

@Module({
  controllers: [CallsController, DialerController, HealthController, LeadsController, NumbersController, SdrsController],
  providers: [DatabaseService, RedisService, WaxumClient, DialerService, SdrGateway],
  exports: [DialerService, SdrGateway],
})
export class AppModule {}
