import { IsEmail, IsIn } from 'class-validator';

export class CreateMembershipDto {
  @IsEmail()
  email!: string;

  @IsIn(['leader', 'sdr'])
  role!: 'leader' | 'sdr';
}
