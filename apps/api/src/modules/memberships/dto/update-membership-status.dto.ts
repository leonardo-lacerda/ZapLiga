import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateMembershipStatusDto {
  @IsIn(['active', 'blocked', 'removed'])
  status!: 'active' | 'blocked' | 'removed';
  @IsOptional() @IsString() @MaxLength(320) confirmationEmail?: string;
}
