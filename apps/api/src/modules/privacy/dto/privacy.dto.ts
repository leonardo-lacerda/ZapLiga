import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class SubjectPhoneDto { @IsString() @MaxLength(30) phone!: string; }
export class CreateDataSubjectRequestDto extends SubjectPhoneDto {
  @IsIn(['correction', 'anonymization', 'deletion', 'export']) requestType!: 'correction' | 'anonymization' | 'deletion' | 'export';
  @IsOptional() @IsString() @MaxLength(4000) details?: string;
}
export class RejectDataSubjectRequestDto { @IsString() @MaxLength(1000) reason!: string; }
