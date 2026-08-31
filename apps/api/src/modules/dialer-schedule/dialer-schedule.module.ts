import { Module } from '@nestjs/common';
import { DialerScheduleService } from './dialer-schedule.service';
import { AuditModule } from '../audit/audit.module';

@Module({ imports: [AuditModule], providers: [DialerScheduleService], exports: [DialerScheduleService] })
export class DialerScheduleModule {}
