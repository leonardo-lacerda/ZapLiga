import { IsOptional, IsString, MinLength } from 'class-validator';

export class ManualCallDto {
  @IsOptional() @IsString() @MinLength(1) leadId?: string;
  @IsOptional() @IsString() @MinLength(3) phone?: string;
  @IsOptional() @IsString() name?: string;
  /** The WhatsApp line to call from; omitted = the least recently used connected line. */
  @IsOptional() @IsString() @MinLength(1) numberId?: string;
}
