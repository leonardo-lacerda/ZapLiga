import { Matches } from 'class-validator';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class ReprocessRollupDto {
  @Matches(DATE_RE, { message: 'from deve estar no formato YYYY-MM-DD' }) from!: string;
  @Matches(DATE_RE, { message: 'to deve estar no formato YYYY-MM-DD' }) to!: string;
}
