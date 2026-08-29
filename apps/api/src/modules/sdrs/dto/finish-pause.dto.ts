import { IsIn, IsString, MinLength } from 'class-validator';
import { CALL_RESULT_CATALOG, PIPELINE_STAGE_CATALOG } from '../../metrics/metrics.definitions';

export class FinishPauseDto {
  @IsIn(Object.keys(CALL_RESULT_CATALOG)) callResult!: string;
  @IsIn(Object.keys(PIPELINE_STAGE_CATALOG)) pipelineStage!: string;
  @IsString() @MinLength(1) notes!: string;
}
