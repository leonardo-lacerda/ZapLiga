import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export const SUPPRESSION_REASONS = ['requested_opt_out', 'invalid_number', 'legal_restriction', 'internal_policy', 'other'] as const;
export const SUPPRESSION_SOURCES = ['post_call', 'lead_action', 'import', 'admin', 'api'] as const;

export class CreateSuppressionDto {
  @IsString() @MinLength(10) @MaxLength(32) phone!: string;
  @IsIn(SUPPRESSION_REASONS) reason!: (typeof SUPPRESSION_REASONS)[number];
  @IsOptional() @IsIn(SUPPRESSION_SOURCES) source?: (typeof SUPPRESSION_SOURCES)[number];
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

