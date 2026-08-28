import { IsIn } from 'class-validator';

export class UpdateMembershipRoleDto {
  @IsIn(['leader', 'sdr']) role!: 'leader' | 'sdr';
}
