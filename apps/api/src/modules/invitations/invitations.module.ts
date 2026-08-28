import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { MembershipsModule } from '../memberships/memberships.module';
import { TenantsModule } from '../tenants/tenants.module';
import { UsersModule } from '../users/users.module';
import { InvitationMailer } from './invitation-mailer';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';

@Module({ imports: [AuthModule, AuditModule, MembershipsModule, TenantsModule, UsersModule], controllers: [InvitationsController], providers: [InvitationsService, InvitationMailer], exports: [InvitationsService] })
export class InvitationsModule {}
