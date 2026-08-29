import { IsIn } from 'class-validator';

export class UpdatePlatformRoleDto {
  @IsIn(['user', 'super_admin'])
  platformRole!: 'user' | 'super_admin';
}
