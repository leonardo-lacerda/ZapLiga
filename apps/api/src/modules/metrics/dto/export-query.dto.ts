import { IsIn, IsOptional } from 'class-validator';
import { REPORT_PERIOD_PRESETS, ReportPeriodPreset } from '../metrics-report-periods';
import { MetricsSummaryQueryDto } from './metrics-summary-query.dto';

const EXPORT_DATASETS = ['sdrs', 'folders', 'numbers', 'calls', 'leads'] as const;

export class ExportCsvQueryDto extends MetricsSummaryQueryDto {
  @IsIn(EXPORT_DATASETS) dataset!: typeof EXPORT_DATASETS[number];
}

export class ExportPdfQueryDto extends MetricsSummaryQueryDto {
  @IsOptional() @IsIn(REPORT_PERIOD_PRESETS) period?: ReportPeriodPreset;
}
