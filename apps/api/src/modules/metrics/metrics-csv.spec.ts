import { buildCsv } from './metrics-csv';

describe('buildCsv', () => {
  const columns = [{ key: 'name', label: 'Nome' }, { key: 'calls', label: 'Chamadas' }];

  it('starts with a UTF-8 BOM so Excel renders accents correctly', () => {
    const csv = buildCsv(columns, []);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it('writes the header row from column labels', () => {
    const csv = buildCsv(columns, []);
    expect(csv.slice(1)).toBe('Nome,Chamadas');
  });

  it('renders one CRLF-joined line per row, in column order', () => {
    const csv = buildCsv(columns, [{ name: 'Ana', calls: 12 }, { name: 'Bruno', calls: 3 }]);
    expect(csv.slice(1)).toBe('Nome,Chamadas\r\nAna,12\r\nBruno,3');
  });

  it('quotes and escapes values containing commas, quotes, or newlines', () => {
    const csv = buildCsv(columns, [{ name: 'Ana, "SDR" do time\nnoturno', calls: 1 }]);
    expect(csv.slice(1)).toBe('Nome,Chamadas\r\n"Ana, ""SDR"" do time\nnoturno",1');
  });

  it('renders null and undefined as an empty field, not the string "null"', () => {
    const csv = buildCsv(columns, [{ name: null, calls: undefined }]);
    expect(csv.slice(1)).toBe('Nome,Chamadas\r\n,');
  });
});
