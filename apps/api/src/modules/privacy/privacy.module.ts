import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrivacyController } from './privacy.controller';
import { PrivacyService } from './privacy.service';

@Module({ imports: [AuditModule], controllers: [PrivacyController], providers: [PrivacyService] })
export class PrivacyModule {}
