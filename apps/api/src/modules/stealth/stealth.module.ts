import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
import { StealthController } from './stealth.controller';
import { StealthService } from './stealth.service';

@Module({ imports: [AuditModule, BillingModule], controllers: [StealthController], providers: [StealthService] })
export class StealthModule {}
