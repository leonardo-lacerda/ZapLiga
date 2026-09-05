import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export const EXPERIMENT_PRIMARY_METRICS = ['answer_rate', 'positive_rate', 'failure_rate', 'rapid_drop_rate'] as const;
export const EXPERIMENT_GUARDRAIL_METRICS = ['failure_rate', 'opt_out_rate', 'rapid_drop_rate', 'line_failure_rate'] as const;

export class ExperimentVariantDto {
  @IsString() @MinLength(1) @MaxLength(40) key!: string;
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsInt() @Min(1) @Max(100) allocationPercent!: number;
  @IsInt() @Min(1) @Max(1440) cadenceMinutes!: number;
  @IsInt() @Min(0) @Max(100) priority!: number;
}

export class ExperimentGuardrailDto {
  @IsIn(EXPERIMENT_GUARDRAIL_METRICS) metric!: typeof EXPERIMENT_GUARDRAIL_METRICS[number];
  @IsIn(['max', 'min']) operator!: 'max' | 'min';
  @IsNumber() @Min(0) @Max(1) threshold!: number;
}

export class CreateExperimentDto {
  @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @IsString() @MinLength(10) @MaxLength(2000) hypothesis!: string;
  @IsString() @MinLength(1) campaignId!: string;
  @IsIn(EXPERIMENT_PRIMARY_METRICS) primaryMetric!: typeof EXPERIMENT_PRIMARY_METRICS[number];
  @IsOptional() @IsInt() @Min(1) @Max(100) trafficPercent?: number;
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(4) @ArrayUnique((variant: ExperimentVariantDto) => variant.key) @ValidateNested({ each: true }) @Type(() => ExperimentVariantDto) variants!: ExperimentVariantDto[];
  @IsArray() @ArrayMinSize(4) @ArrayMaxSize(4) @ArrayUnique((guardrail: ExperimentGuardrailDto) => guardrail.metric) @ValidateNested({ each: true }) @Type(() => ExperimentGuardrailDto) guardrails!: ExperimentGuardrailDto[];
}

export class ExperimentStopDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
