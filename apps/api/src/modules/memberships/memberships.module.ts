import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { MembershipsController } from './memberships.controller';
import { MembershipsService } from './memberships.service';

@Module({ imports: [AuthModule, AuditModule], controllers: [MembershipsController], providers: [MembershipsService], exports: [MembershipsService] })
export class MembershipsModule {}
