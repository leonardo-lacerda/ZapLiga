import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
import { DialerModule } from '../dialer/dialer.module';
import { NumbersController } from './numbers.controller';
import { NumbersService } from './numbers.service';

@Module({ imports: [AuditModule, BillingModule, DialerModule], controllers: [NumbersController], providers: [NumbersService], exports: [NumbersService] })
export class NumbersModule {}
