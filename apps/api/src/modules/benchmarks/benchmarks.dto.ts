import { ArrayMinSize, ArrayUnique, IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const BENCHMARK_TERMS_VERSION = 'benchmark-v1';
export const BENCHMARK_PURPOSES = ['aggregate_benchmarking'] as const;

export class BenchmarkConsentDto {
  @IsString() @IsIn([BENCHMARK_TERMS_VERSION]) termsVersion!: string;
  @IsArray() @ArrayMinSize(1) @ArrayUnique() @IsIn(BENCHMARK_PURPOSES, { each: true }) purposes!: string[];
}

export class BenchmarkConsentRevokeDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
