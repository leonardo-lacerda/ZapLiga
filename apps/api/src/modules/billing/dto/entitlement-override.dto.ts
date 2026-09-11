import { IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class EntitlementOverrideDto {
  @IsOptional() @IsString() @MaxLength(80) featureCode?: string;
  @IsIn(['grant', 'deny', 'replace_limit']) overrideMode!: 'grant' | 'deny' | 'replace_limit';
  @IsOptional() @IsObject() value?: Record<string, unknown>;
  @IsString() @MaxLength(500) reason!: string;
  @IsOptional() @IsInt() @Min(1) @Max(31_536_000) expiresInSeconds?: number;
}
