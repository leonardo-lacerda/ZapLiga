import { IsIn } from 'class-validator';

export class UpdateTenantStatusDto {
  @IsIn(['active', 'blocked', 'archived'])
  status!: 'active' | 'blocked' | 'archived';
}
