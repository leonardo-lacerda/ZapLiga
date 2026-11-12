import { Module } from '@nestjs/common';
import { CrmEventsModule } from '../crm-events/crm-events.module';
import { CallRecordingsService } from './call-recordings.service';

@Module({ imports: [CrmEventsModule], providers: [CallRecordingsService], exports: [CallRecordingsService] })
export class CallRecordingsModule {}
