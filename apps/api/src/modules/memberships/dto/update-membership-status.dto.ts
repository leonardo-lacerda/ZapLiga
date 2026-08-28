import { IsIn } from 'class-validator';

export class UpdateMembershipStatusDto {
  @IsIn(['active', 'blocked', 'removed'])
  status!: 'active' | 'blocked' | 'removed';
}
