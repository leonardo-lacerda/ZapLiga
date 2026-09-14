import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class UpdateTenantLimitsDto {
  @IsOptional() @IsInt() @Min(1) @Max(10_000_000) maxLeads?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10_000) maxNumbers?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100_000) maxSdrs?: number;
}
