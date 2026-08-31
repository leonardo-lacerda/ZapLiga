import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ContactComplianceController } from './contact-compliance.controller';
import { ContactComplianceService } from './contact-compliance.service';

@Module({ imports: [AuditModule], controllers: [ContactComplianceController], providers: [ContactComplianceService], exports: [ContactComplianceService] })
export class ContactComplianceModule {}

