import { IsString, MinLength } from 'class-validator';

export class ManualCallDto {
  @IsString() @MinLength(1) leadId!: string;
}
