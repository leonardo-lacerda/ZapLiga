import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class PlanChangeDto {
  @IsString() @MaxLength(80) planCode!: string;
  @IsOptional() @IsIn(['month', 'year']) interval?: 'month' | 'year';
}
