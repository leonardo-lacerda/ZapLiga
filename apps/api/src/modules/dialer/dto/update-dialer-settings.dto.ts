import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class UpdateDialerSettingsDto {
  @IsOptional() @IsInt() @Min(1) @Max(1000) global_max_concurrent_calls?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100) max_attempts_per_lead?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10080) retry_delay_minutes?: number;
  @IsOptional() @IsInt() @Min(1) @Max(600) ring_timeout_seconds?: number;
  @IsOptional() @IsInt() @Min(0) @Max(3600) default_number_cooldown_seconds?: number;
}
