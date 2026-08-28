import { IsEmail, IsIn } from 'class-validator';

export class CreateInvitationDto {
  @IsEmail()
  email!: string;

  @IsIn(['leader', 'sdr'])
  role!: 'leader' | 'sdr';
}
