import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NumbersModule } from '../numbers/numbers.module';
import { LineDailyStatsService } from './line-daily-stats.service';
import { LineLearningsService } from './line-learnings.service';
import { LineMonitorController } from './line-monitor.controller';
import { LineMonitorService } from './line-monitor.service';

@Module({
  imports: [AuditModule, NumbersModule],
  controllers: [LineMonitorController],
  providers: [LineMonitorService, LineDailyStatsService, LineLearningsService],
  exports: [LineMonitorService, LineLearningsService],
})
export class LineMonitorModule {}
