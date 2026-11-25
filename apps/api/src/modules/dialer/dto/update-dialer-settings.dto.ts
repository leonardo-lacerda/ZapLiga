import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

export class UpdateDialerSettingsDto {
  @IsOptional() @IsInt() @Min(1) @Max(1000) global_max_concurrent_calls?: number;
  @IsOptional() @IsInt() @Min(1) @Max(60) max_calls_per_minute?: number;
  @IsOptional() @IsInt() @Min(0) @Max(3600) min_seconds_between_calls?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100) max_attempts_per_lead?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10080) retry_delay_minutes?: number;
  @IsOptional() @IsInt() @Min(1) @Max(600) ring_timeout_seconds?: number;
  @IsOptional() @IsInt() @Min(0) @Max(3600) default_number_cooldown_seconds?: number;
  @IsOptional() @IsIn(['fifo', 'lifo', 'priority_fifo']) queue_strategy?: 'fifo' | 'lifo' | 'priority_fifo';
  /** Team phones (country code + area code + number, digits only) a new line calls first: the canary. */
  @IsOptional() @IsArray() @ArrayMaxSize(10) @Matches(/^\d{10,15}$/, { each: true, message: 'Cada celular da equipe precisa ter só dígitos, com DDI e DDD (10 a 15)' }) canary_phones?: string[];
}
