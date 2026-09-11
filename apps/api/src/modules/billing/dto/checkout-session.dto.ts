import { IsIn, IsInt, IsOptional, IsString, IsUrl, Max, MaxLength, Min } from 'class-validator';

export class CheckoutSessionDto {
  @IsString() @MaxLength(80) planCode!: string;
  @IsIn(['month', 'year']) interval!: 'month' | 'year';
  @IsOptional() @IsInt() @Min(1) @Max(100000) totalSdrSeats?: number;
  @IsOptional() @IsUrl({ require_tld: false }) successUrl?: string;
  @IsOptional() @IsUrl({ require_tld: false }) cancelUrl?: string;
}
