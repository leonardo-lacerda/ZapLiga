import { IsBoolean } from 'class-validator';

export class SetStealthDto {
  @IsBoolean() enabled!: boolean;
}
