import { ArrayMaxSize, ArrayUnique, IsArray, IsInt, IsNumber, IsObject, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class CreateCampaignDto {
  @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsString() @MinLength(1) folderId!: string;
  @IsOptional() @IsString() @MaxLength(80) primaryGoalMetric?: string;
  @IsOptional() @IsNumber() @Min(0) primaryGoalTarget?: number;
  @IsArray() @ArrayMaxSize(500) @ArrayUnique() @IsString({ each: true }) sdrIds!: string[];
  @IsArray() @ArrayMaxSize(500) @ArrayUnique() @IsString({ each: true }) numberIds!: string[];
  @IsObject() config!: Record<string, unknown>;
}

export class UpdateCampaignDto {
  @IsInt() @Min(0) expectedLockVersion!: number;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsString() @MinLength(1) folderId?: string;
  @IsOptional() @IsString() @MaxLength(80) primaryGoalMetric?: string;
  @IsOptional() @IsNumber() @Min(0) primaryGoalTarget?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(500) @ArrayUnique() @IsString({ each: true }) sdrIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(500) @ArrayUnique() @IsString({ each: true }) numberIds?: string[];
  @IsOptional() @IsObject() config?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(500) changeReason?: string;
}

export class CampaignTransitionDto {
  @IsInt() @Min(0) expectedLockVersion!: number;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class DuplicateCampaignDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
}
