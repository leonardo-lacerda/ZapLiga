import { Module } from '@nestjs/common';
import { CrmEventsService } from './crm-events.service';

// Kept free of other feature modules so the dialer and the line service can publish CRM events
// without depending on the CRM integration module (which depends on them).
@Module({ providers: [CrmEventsService], exports: [CrmEventsService] })
export class CrmEventsModule {}
