import { IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

export class CreateNumberDto {
  @IsString() @MinLength(2) label!: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsInt() @Min(1) @Max(50) maxConcurrentCalls?: number;
  @IsOptional() @IsInt() @Min(0) @Max(3600) cooldownSeconds?: number;
  @IsOptional() @IsInt() @Min(1) @Max(20) maxCallsPerWindow?: number;
  @IsOptional() @IsInt() @Min(60) @Max(3600) callWindowSeconds?: number;
}
