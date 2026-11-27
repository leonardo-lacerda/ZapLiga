import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
import { CrmEventsModule } from '../crm-events/crm-events.module';
import { DeviceProfileModule } from '../device-profile/device-profile.module';
import { DialerModule } from '../dialer/dialer.module';
import { NumbersController } from './numbers.controller';
import { NumbersService } from './numbers.service';

@Module({ imports: [AuditModule, BillingModule, CrmEventsModule, DialerModule, DeviceProfileModule], controllers: [NumbersController], providers: [NumbersService], exports: [NumbersService] })
export class NumbersModule {}
