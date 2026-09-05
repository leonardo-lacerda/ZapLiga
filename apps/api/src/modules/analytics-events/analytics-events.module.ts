import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { OutboundWebhooksModule } from '../outbound-webhooks/outbound-webhooks.module';
import { AnalyticsEventsController } from './analytics-events.controller';
import { AnalyticsEventsService } from './analytics-events.service';

@Module({ imports: [AuditModule, OutboundWebhooksModule], controllers: [AnalyticsEventsController], providers: [AnalyticsEventsService], exports: [AnalyticsEventsService] })
export class AnalyticsEventsModule {}
