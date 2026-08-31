import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateMembershipRoleDto {
  @IsIn(['leader', 'sdr']) role!: 'leader' | 'sdr';
  @IsOptional() @IsString() @MaxLength(320) confirmationEmail?: string;
}
