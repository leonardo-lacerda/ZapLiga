import { IsString, MinLength } from 'class-validator';

export class OutcomeDto {
  @IsString() @MinLength(1) outcome!: string;
}
