import { IsString, MaxLength, MinLength } from 'class-validator';

export class LiftSuppressionDto {
  @IsString() @MinLength(5) @MaxLength(500) reason!: string;
}

