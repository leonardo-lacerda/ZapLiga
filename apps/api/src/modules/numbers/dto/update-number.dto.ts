import { IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

export class UpdateNumberDto {
  @IsOptional() @IsString() @MinLength(2) label?: string;
  @IsOptional() @IsInt() @Min(1) @Max(50) maxConcurrentCalls?: number;
  @IsOptional() @IsInt() @Min(0) @Max(3600) cooldownSeconds?: number;
}
