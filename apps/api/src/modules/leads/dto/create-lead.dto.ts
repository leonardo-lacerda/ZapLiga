import { IsString, MinLength } from 'class-validator';

export class CreateLeadDto {
  @IsString() @MinLength(2) name!: string;
  @IsString() @MinLength(3) phone!: string;
}
