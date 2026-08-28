import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

@Module({ imports: [AuthModule, AuditModule], controllers: [TenantsController], providers: [TenantsService], exports: [TenantsService] })
export class TenantsModule {}
