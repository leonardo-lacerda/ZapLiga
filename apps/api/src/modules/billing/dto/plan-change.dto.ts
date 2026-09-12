import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class PlanChangeDto {
  @IsString() @MaxLength(80) planCode!: string;
  @IsOptional() @IsIn(['month', 'year']) interval?: 'month' | 'year';
  @IsOptional() @IsInt() @Min(1) @Max(100000) totalSdrSeats?: number;
}
