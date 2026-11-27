import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateNumberDto {
  @IsString() @MinLength(2) label!: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsInt() @Min(1) @Max(50) maxConcurrentCalls?: number;
  @IsOptional() @IsInt() @Min(0) @Max(3600) cooldownSeconds?: number;
  @IsOptional() @IsInt() @Min(1) @Max(20) maxCallsPerWindow?: number;
  @IsOptional() @IsInt() @Min(60) @Max(3600) callWindowSeconds?: number;
  // Born with its camouflage profile (docs/stealth-profile.md); super admin only.
  @IsOptional() @IsBoolean() stealth?: boolean;
  // Born with the new camouflage, as this Multilogin cloud phone (docs/device-profile.md); super admin only.
  @IsOptional() @IsString() @MinLength(1) @MaxLength(64) multiloginPhoneId?: string;
  // The number is WhatsApp Business; required with multiloginPhoneId.
  @IsOptional() @IsBoolean() business?: boolean;
}
