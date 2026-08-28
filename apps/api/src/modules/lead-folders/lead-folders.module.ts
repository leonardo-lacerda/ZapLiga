import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { LeadFoldersController } from './lead-folders.controller';
import { LeadFoldersService } from './lead-folders.service';

@Module({ imports: [AuditModule], controllers: [LeadFoldersController], providers: [LeadFoldersService], exports: [LeadFoldersService] })
export class LeadFoldersModule {}
