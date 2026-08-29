import { IsBoolean, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class SaveViewDto {
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsOptional() @IsBoolean() isShared?: boolean;
  // Formato livre de propósito: espelha o MetricsFiltersState do frontend
  // (período, comparação, pastas/SDRs/números, origem, resultado, etapa,
  // status), que pode ganhar campos novos sem exigir migração de schema.
  @IsObject() filters!: Record<string, unknown>;
}

export class UpdateViewDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsBoolean() isShared?: boolean;
  @IsOptional() @IsObject() filters?: Record<string, unknown>;
}
