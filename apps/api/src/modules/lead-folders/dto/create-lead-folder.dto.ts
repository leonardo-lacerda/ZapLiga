import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateLeadFolderDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  isActive?: boolean;
}
