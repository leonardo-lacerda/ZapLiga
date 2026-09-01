import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { LeadIngestionController } from './lead-ingestion.controller';
import { LeadIngestionService } from './lead-ingestion.service';

@Module({ imports: [AuditModule], controllers: [LeadIngestionController], providers: [LeadIngestionService], exports: [LeadIngestionService] })
export class LeadIngestionModule {}
