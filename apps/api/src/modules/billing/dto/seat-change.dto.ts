import { IsInt, Max, Min } from 'class-validator';

export class SeatChangeDto {
  @IsInt() @Min(1) @Max(100000)
  totalSdrSeats!: number;
}
