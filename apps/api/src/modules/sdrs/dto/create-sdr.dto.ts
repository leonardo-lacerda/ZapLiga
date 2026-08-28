import { IsString, MinLength } from 'class-validator';

export class CreateSdrDto {
  @IsString() @MinLength(2) name!: string;
}
