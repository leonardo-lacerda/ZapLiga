import { Equals, IsBoolean, IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class RegisterOrganizerDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  companyName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u)
  companySlug?: string;

  @IsBoolean()
  @Equals(true, { message: 'É necessário aceitar os Termos e a Política de Privacidade' })
  legalAccepted!: boolean;
}
