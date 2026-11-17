import { IsString } from 'class-validator';

export class PairNumberDto {
  @IsString() phone!: string;
}
