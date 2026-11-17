import { Module } from '@nestjs/common';
import { GeelarkWorkerClient } from '../../infrastructure/geelark-worker/geelark-worker.client';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
import { DialerModule } from '../dialer/dialer.module';
import { EgressModule } from '../egress/egress.module';
import { NumbersModule } from '../numbers/numbers.module';
import { WhatsappProvisioningController } from './whatsapp-provisioning.controller';
import { WhatsappProvisioningService } from './whatsapp-provisioning.service';

@Module({
  // DialerModule exports the shared WaxumClient; NumbersModule creates, pairs and moves the line;
  // EgressModule lists the attendants' PCs the phone goes out through. None of them imports this module.
  imports: [AuditModule, BillingModule, DialerModule, EgressModule, NumbersModule],
  controllers: [WhatsappProvisioningController],
  providers: [WhatsappProvisioningService, GeelarkWorkerClient],
})
export class WhatsappProvisioningModule {}
