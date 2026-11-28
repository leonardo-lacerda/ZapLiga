import { Module } from '@nestjs/common';
import { NumbersModule } from '../numbers/numbers.module';
import { LineDailyStatsService } from './line-daily-stats.service';
import { LineLearningsService } from './line-learnings.service';
import { LineMonitorController } from './line-monitor.controller';
import { LineMonitorService } from './line-monitor.service';

@Module({
  imports: [NumbersModule],
  controllers: [LineMonitorController],
  providers: [LineMonitorService, LineDailyStatsService, LineLearningsService],
  exports: [LineMonitorService, LineLearningsService],
})
export class LineMonitorModule {}
