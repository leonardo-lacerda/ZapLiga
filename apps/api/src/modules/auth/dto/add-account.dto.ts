import { IsEmail, IsString, MinLength } from 'class-validator';

export class AddAccountDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}
