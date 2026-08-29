import { IsInt, IsOptional, Max, Min, ValidateIf } from 'class-validator';

export class SetRetentionPolicyDto {
  @ValidateIf((dto: SetRetentionPolicyDto) => dto.retentionDays !== null)
  @IsInt() @Min(30) @Max(3650) @IsOptional()
  retentionDays!: number | null;
}
