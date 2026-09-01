import { IsIn, IsInt, IsObject, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

export class CreateLeadIntegrationDto {
  @IsString() @MinLength(2) name!: string;
  @IsOptional() @IsIn(['webhook', 'api', 'automation']) integrationType?: 'webhook' | 'api' | 'automation';
  @IsString() @MinLength(1) defaultFolderId!: string;
  @IsOptional() @IsIn(['update_existing', 'ignore_duplicate', 'reject_duplicate']) duplicatePolicy?: 'update_existing' | 'ignore_duplicate' | 'reject_duplicate';
  @IsOptional() @IsInt() @Min(-100) @Max(100) defaultPriority?: number;
  @IsOptional() @IsObject() fieldMapping?: Record<string, string>;
}
