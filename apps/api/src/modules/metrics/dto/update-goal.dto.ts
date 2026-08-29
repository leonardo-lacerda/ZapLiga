import { IsIn, IsNumber, IsOptional, Matches, Min } from 'class-validator';
import { GoalValueType } from '../metrics.definitions';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Escopo, escopo-alvo e métrica não são editáveis — trocar qualquer um deles
// é, na prática, criar uma meta diferente (use POST). Editar aqui sempre
// congela a meta atual e cria uma nova vigente (plano: "metas antigas devem
// permanecer congeladas para preservar relatórios históricos").
export class UpdateGoalDto {
  @IsOptional() @IsIn(['absolute', 'percentage']) valueType?: GoalValueType;
  @IsOptional() @IsNumber() @Min(0) targetValue?: number;
  @IsOptional() @Matches(DATE_RE, { message: 'periodFrom deve estar no formato YYYY-MM-DD' }) periodFrom?: string;
  @IsOptional() @Matches(DATE_RE, { message: 'periodTo deve estar no formato YYYY-MM-DD' }) periodTo?: string;
}
