import { Module } from '@nestjs/common';
import { WaxumClient } from '../../infrastructure/waxum/waxum.client';
import { SdrGateway } from '../sdrs/sdr.gateway';
import { DialerService } from './dialer.service';
import { ContactComplianceModule } from '../contact-compliance/contact-compliance.module';
import { DialerScheduleModule } from '../dialer-schedule/dialer-schedule.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [ContactComplianceModule, DialerScheduleModule, AuditModule],
  providers: [WaxumClient, DialerService, SdrGateway],
  exports: [DialerService, SdrGateway, WaxumClient],
})
export class DialerModule {}
