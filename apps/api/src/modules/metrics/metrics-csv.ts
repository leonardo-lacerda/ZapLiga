export type CsvColumn = { key: string; label: string };

const UTF8_BOM = '﻿';

function escapeCsvValue(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

/**
 * Gera CSV com BOM UTF-8 (Excel no Windows não detecta acentuação sem ele) e
 * quebra de linha CRLF (padrão do formato). Escapa vírgula, aspas e quebras
 * de linha por campo — nunca confia que os dados não contêm essas coisas
 * (nomes de lead, notas de pós-atendimento etc. são texto livre).
 */
export function buildCsv(columns: CsvColumn[], rows: Record<string, unknown>[]): string {
  const header = columns.map((column) => escapeCsvValue(column.label)).join(',');
  const lines = rows.map((row) => columns.map((column) => escapeCsvValue(row[column.key])).join(','));
  return UTF8_BOM + [header, ...lines].join('\r\n');
}
