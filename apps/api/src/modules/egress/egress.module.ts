import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { NumbersModule } from '../numbers/numbers.module';
import { EgressAdminController, EgressInternalController } from './egress.controller';
import { EgressPoolService } from './egress-pool.service';
import { EgressService } from './egress.service';

@Module({ imports: [AuthModule, AuditModule, NumbersModule], controllers: [EgressAdminController, EgressInternalController], providers: [EgressService, EgressPoolService] })
export class EgressModule {}
