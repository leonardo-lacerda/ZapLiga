import { Transform } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { MetricsSource } from '../metrics.types';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Normaliza `campo=a&campo=b` (array), `campo=a` (string única) e ausência em
// uma lista só — o filtro nunca deve virar SQL diretamente (plano seção 7.3).
const toStringArray = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  return (Array.isArray(value) ? value : [value]).map(String);
};

export class MetricsSummaryQueryDto {
  @IsOptional() @Matches(DATE_RE, { message: 'from deve estar no formato YYYY-MM-DD' }) from?: string;
  @IsOptional() @Matches(DATE_RE, { message: 'to deve estar no formato YYYY-MM-DD' }) to?: string;
  @IsOptional() @Matches(DATE_RE, { message: 'compareFrom deve estar no formato YYYY-MM-DD' }) compareFrom?: string;
  @IsOptional() @Matches(DATE_RE, { message: 'compareTo deve estar no formato YYYY-MM-DD' }) compareTo?: string;

  @IsOptional() @Transform(toStringArray) @IsArray() @IsString({ each: true }) folderIds?: string[];
  @IsOptional() @Transform(toStringArray) @IsArray() @IsString({ each: true }) sdrIds?: string[];
  @IsOptional() @Transform(toStringArray) @IsArray() @IsString({ each: true }) numberIds?: string[];

  @IsOptional() @IsIn(['automatico', 'manual', 'all']) source?: MetricsSource;

  @IsOptional() @Transform(toStringArray) @IsArray() @IsString({ each: true }) callResults?: string[];
  @IsOptional() @Transform(toStringArray) @IsArray() @IsString({ each: true }) pipelineStages?: string[];
  @IsOptional() @Transform(toStringArray) @IsArray() @IsString({ each: true }) statuses?: string[];

  @IsOptional() @IsString() timezone?: string;
}
