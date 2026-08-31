import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DialerModule } from '../dialer/dialer.module';
import { CallbacksController } from './callbacks.controller';
import { CallbacksService } from './callbacks.service';

@Module({ imports: [AuditModule, DialerModule], controllers: [CallbacksController], providers: [CallbacksService], exports: [CallbacksService] })
export class CallbacksModule {}
