import { IsIn } from 'class-validator';

export class UpdateUserStatusDto {
  @IsIn(['active', 'blocked'])
  status!: 'active' | 'blocked';
}
