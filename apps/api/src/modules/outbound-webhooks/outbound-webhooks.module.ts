import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { OutboundWebhooksController } from './outbound-webhooks.controller';
import { OutboundWebhooksService } from './outbound-webhooks.service';

@Module({ imports: [AuditModule], controllers: [OutboundWebhooksController], providers: [OutboundWebhooksService], exports: [OutboundWebhooksService] })
export class OutboundWebhooksModule {}
