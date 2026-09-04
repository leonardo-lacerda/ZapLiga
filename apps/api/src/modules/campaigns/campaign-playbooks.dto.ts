import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateCampaignPlaybookDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
}

export class InstantiateCampaignPlaybookDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
}
