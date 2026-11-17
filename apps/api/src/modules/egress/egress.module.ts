import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { EgressAdminController, EgressInternalController } from './egress.controller';
import { EgressService } from './egress.service';

@Module({ imports: [AuthModule, AuditModule], controllers: [EgressAdminController, EgressInternalController], providers: [EgressService] })
export class EgressModule {}
