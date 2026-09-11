import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { LeadFoldersController } from './lead-folders.controller';
import { LeadFoldersService } from './lead-folders.service';
import { BillingModule } from '../billing/billing.module';

@Module({ imports: [AuditModule, BillingModule], controllers: [LeadFoldersController], providers: [LeadFoldersService], exports: [LeadFoldersService] })
export class LeadFoldersModule {}
