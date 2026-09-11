import { IsInt, IsNotEmpty, IsString, Max, Min } from 'class-validator';

export class ManualGrantDto {
  @IsString() @IsNotEmpty() reason!: string;
  @IsString() startsAt!: string;
  @IsString() expiresAt!: string;
  @IsInt() @Min(1) @Max(100000) maxSdrs!: number;
}
