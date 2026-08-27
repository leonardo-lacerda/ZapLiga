export type ImportedLead = {
  name: string;
  phone: string;
};

const nameFields = [
  'name',
  'Nome completo',
  'Lead título',
  'Pessoa de contato',
];

const phoneFields = [
  'phone',
  'Telefone comercial',
  'Tel. direto com.',
  'Celular',
  'Telefone residencial',
  'Outro telefone',
];

const normalizeHeader = (value: string) => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');

const firstValue = (row: Record<string, unknown>, fields: string[]) => {
  const normalized = new Map(
    Object.entries(row).map(([key, value]) => [normalizeHeader(key), String(value ?? '').trim()]),
  );

  for (const field of fields) {
    const value = normalized.get(normalizeHeader(field));
    if (value) return value;
  }

  return '';
};

export const parseLeadCsvRow = (row: Record<string, unknown>): ImportedLead | null => {
  const name = firstValue(row, nameFields);
  const phone = firstValue(row, phoneFields).replace(/\D/g, '');

  if (!name || phone.length < 10 || phone.length > 15) return null;
  return { name, phone };
};

