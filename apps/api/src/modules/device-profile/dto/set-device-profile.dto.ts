import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class SetDeviceProfileDto {
  @IsBoolean() enabled!: boolean;
  // The Multilogin cloud phone the number was registered on; required the first time.
  @IsOptional() @IsString() @MinLength(1) @MaxLength(64) multiloginPhoneId?: string;
}
