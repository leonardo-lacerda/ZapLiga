import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

const isRegister = (object: { mode?: string }) => object.mode !== 'network_check';

export class CreateProvisioningJobDto {
  // Id of the attendant PC (egress_pcs.id) the phone goes out through.
  @IsString() @MinLength(1) @MaxLength(64) egressNode!: string;
  @IsString() @MinLength(1) @MaxLength(120) geelarkPhoneId!: string;
  // network_check: only applies the PC's proxy, starts the phone, checks its IP and powers it off.
  @IsOptional() @IsIn(['register', 'network_check']) mode?: 'register' | 'network_check';
  @ValidateIf(isRegister) @IsIn(['whatsapp', 'business']) app?: 'whatsapp' | 'business';
  // Digits are validated (and separators stripped) by the service, which answers 400 in Portuguese.
  @ValidateIf(isRegister) @IsString() @MaxLength(8) countryCode?: string;
  @ValidateIf(isRegister) @IsString() @MaxLength(32) number?: string;
  @IsOptional() @IsBoolean() powerOffWhenDone?: boolean;
  // Wipe the WhatsApp already on the phone first (signs out the account that is there).
  @IsOptional() @IsBoolean() resetApp?: boolean;
}

export const ANDROID_VERSIONS = ['Android 12', 'Android 13', 'Android 14', 'Android 15', 'Android 16', 'Android 11'] as const;
export type AndroidVersion = typeof ANDROID_VERSIONS[number];

export class CreatePhoneDto {
  @IsString() @MinLength(1) @MaxLength(60) name!: string;
  // Android 10 is left out: GeeLark gives no ADB on it, and without ADB there is no registration.
  @IsIn(ANDROID_VERSIONS) androidVersion!: AndroidVersion;
  // The PC (egress_pcs.id) the new phone goes out through from its first boot.
  @IsString() @MinLength(1) @MaxLength(64) egressNode!: string;
}

export class SubmitSmsCodeDto {
  // 6 digits; "123-456" and "123 456" are accepted. Never logged or stored.
  @IsString() @Matches(/^\s*\d{3}[\s-]?\d{3}\s*$/, { message: 'O código SMS deve ter 6 dígitos' }) code!: string;
}

/** Multipart text field; the optional `photo` file is read by the controller interceptor. */
export class SubmitProfileDto {
  // WhatsApp limits the profile name to 25 characters.
  @IsString() @MinLength(1) @MaxLength(25) name!: string;
}

export class RequestCodeDto {
  @IsIn(['sms', 'voice']) method!: 'sms' | 'voice';
}

export class LinkDecisionDto {
  @IsBoolean() connect!: boolean;
}

export class AssignEgressNodeDto {
  @ValidateIf((_object, value) => value !== null) @IsString() @MinLength(1) @MaxLength(120) userId!: string | null;
}
