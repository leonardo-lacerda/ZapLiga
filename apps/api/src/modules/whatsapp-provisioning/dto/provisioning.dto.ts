import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

export class CreateProvisioningJobDto {
  // Id of the attendant PC (egress_pcs.id) the phone goes out through.
  @IsString() @MinLength(1) @MaxLength(64) egressNode!: string;
  @IsString() @MinLength(1) @MaxLength(120) geelarkPhoneId!: string;
  @IsIn(['whatsapp', 'business']) app!: 'whatsapp' | 'business';
  // Digits are validated (and separators stripped) by the service, which answers 400 in Portuguese.
  @IsString() @MaxLength(8) countryCode!: string;
  @IsString() @MaxLength(32) number!: string;
  @IsOptional() @IsBoolean() powerOffWhenDone?: boolean;
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

export class LinkDecisionDto {
  @IsBoolean() connect!: boolean;
}

export class AssignEgressNodeDto {
  @ValidateIf((_object, value) => value !== null) @IsString() @MinLength(1) @MaxLength(120) userId!: string | null;
}
