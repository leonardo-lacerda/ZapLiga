import { IsIn, IsNumber, IsOptional, IsString, Matches, Min, MinLength, ValidateIf } from 'class-validator';
import { GOAL_METRIC_CATALOG, GOAL_SCOPES, GoalMetric, GoalScope, GoalValueType } from '../metrics.definitions';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateGoalDto {
  @IsIn(GOAL_SCOPES) scope!: GoalScope;

  // Obrigatório para escopo sdr/folder; deve ficar ausente para organization
  // (validado no service, que conhece o valor de `scope` já parseado).
  @ValidateIf((dto: CreateGoalDto) => dto.scope !== 'organization')
  @IsString() @MinLength(1)
  scopeId?: string;

  @IsIn(Object.keys(GOAL_METRIC_CATALOG)) metric!: GoalMetric;
  @IsIn(['absolute', 'percentage']) valueType!: GoalValueType;
  @IsNumber() @Min(0) targetValue!: number;
  @Matches(DATE_RE, { message: 'periodFrom deve estar no formato YYYY-MM-DD' }) periodFrom!: string;
  @Matches(DATE_RE, { message: 'periodTo deve estar no formato YYYY-MM-DD' }) periodTo!: string;
}
