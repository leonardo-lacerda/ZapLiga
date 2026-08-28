import { IsOptional, IsString, MinLength } from 'class-validator';

export class ManualCallDto {
  @IsOptional() @IsString() @MinLength(1) leadId?: string;
  @IsOptional() @IsString() @MinLength(3) phone?: string;
  @IsOptional() @IsString() name?: string;
}
