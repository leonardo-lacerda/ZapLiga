import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { DialerModule } from '../dialer/dialer.module';
import { UsersModule } from '../users/users.module';
import { MembershipsModule } from '../memberships/memberships.module';
import { NumbersModule } from '../numbers/numbers.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [AuthModule, AuditModule, DialerModule, UsersModule, MembershipsModule, NumbersModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
