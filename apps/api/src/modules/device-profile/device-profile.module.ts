import { Module } from '@nestjs/common';
import { MultiloginClient } from '../../infrastructure/multilogin/multilogin.client';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
import { DeviceProfileController } from './device-profile.controller';
import { DeviceProfileService } from './device-profile.service';

@Module({ imports: [AuditModule, BillingModule], controllers: [DeviceProfileController], providers: [DeviceProfileService, MultiloginClient], exports: [DeviceProfileService] })
export class DeviceProfileModule {}
