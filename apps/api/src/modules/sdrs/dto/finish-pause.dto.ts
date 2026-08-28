import { IsString, MinLength } from 'class-validator';

export class FinishPauseDto {
  @IsString() @MinLength(1) callResult!: string;
  @IsString() @MinLength(1) pipelineStage!: string;
  @IsString() @MinLength(1) notes!: string;
}
