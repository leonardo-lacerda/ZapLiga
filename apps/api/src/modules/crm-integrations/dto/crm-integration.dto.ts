import { ArrayMaxSize, IsArray, IsEmail, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateCrmIntegrationDto {
  @IsString() @MinLength(2) @MaxLength(80) name!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsString({ each: true }) allowedOrigins?: string[];
}

export class HandshakeDto {
  @IsString() @MaxLength(500) webhookUrl!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsString({ each: true }) allowedOrigins?: string[];
  @IsOptional() @IsString() @MaxLength(120) externalAccountId?: string;
}

export class EnsureAgentDto {
  @IsString() @MinLength(1) @MaxLength(120) externalUserId!: string;
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
}

export class CreateDialIntentDto {
  @IsString() @MinLength(1) sdrId!: string;
  @IsString() @MinLength(1) numberId!: string;
  @IsString() @MinLength(8) @MaxLength(32) phone!: string;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsObject() externalRef?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(120) leadExternalId?: string;
}

export class IntegrationWrapUpDto {
  @IsIn(['interessado', 'reuniao_agendada', 'retornar', 'sem_interesse', 'numero_invalido', 'nao_ligar_novamente']) callResult!: string;
  @IsOptional() @IsIn(['novo', 'contatado', 'qualificado', 'reuniao', 'ganho', 'perdido']) pipelineStage?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsString() callbackAt?: string;
}

export class IntegrationSuppressionDto {
  @IsString() @MinLength(8) @MaxLength(32) phone!: string;
  @IsOptional() @IsIn(['requested_opt_out', 'invalid_number', 'legal_restriction', 'internal_policy', 'other']) reason?: 'requested_opt_out' | 'invalid_number' | 'legal_restriction' | 'internal_policy' | 'other';
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class IntegrationCreateNumberDto {
  @IsString() @MinLength(2) @MaxLength(80) label!: string;
  @IsOptional() @IsString() @MaxLength(32) phone?: string;
}

export class IntegrationUpdateNumberDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) label?: string;
  @IsOptional() @IsInt() @Min(0) @Max(3600) cooldownSeconds?: number;
  @IsOptional() @IsInt() @Min(1) @Max(20) maxCallsPerWindow?: number;
  @IsOptional() @IsInt() @Min(60) @Max(3600) callWindowSeconds?: number;
}
