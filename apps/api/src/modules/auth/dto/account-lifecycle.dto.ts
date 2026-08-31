import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class ForgotPasswordDto { @IsEmail() email!: string; }
export class ResendVerificationDto { @IsEmail() email!: string; }
export class TokenDto { @IsString() @MinLength(32) @MaxLength(256) token!: string; }
export class ResetPasswordDto extends TokenDto { @IsString() @MinLength(8) @MaxLength(128) password!: string; }
export class UpdateProfileDto { @IsString() @MinLength(2) @MaxLength(120) name!: string; }
export class ChangePasswordDto {
  @IsString() @MinLength(8) @MaxLength(128) currentPassword!: string;
  @IsString() @MinLength(8) @MaxLength(128) newPassword!: string;
}
