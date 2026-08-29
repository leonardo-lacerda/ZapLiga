import { IsNumberString, IsOptional } from 'class-validator';
import { MetricsSummaryQueryDto } from './metrics-summary-query.dto';

export class MetricsDrilldownQueryDto extends MetricsSummaryQueryDto {
  @IsOptional() @IsNumberString() limit?: string;
  @IsOptional() @IsNumberString() offset?: string;
}
