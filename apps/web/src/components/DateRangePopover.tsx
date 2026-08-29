import { useState } from 'react';
import { Button, Icon } from './ui';

export type DateRange = { from: string; to: string };

const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const monthsPt = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const formatShort = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return `${String(d).padStart(2, '0')} ${monthsPt[m - 1]} ${y}`; };
export const formatDateRangeLabel = (range: DateRange) => range.from === range.to ? formatShort(range.from) : `${formatShort(range.from)} – ${formatShort(range.to)}`;

const presets: { label: string; days: number | 'today' | 'month' }[] = [
  { label: 'Hoje', days: 'today' },
  { label: '7 dias', days: 7 },
  { label: '30 dias', days: 30 },
  { label: 'Este mês', days: 'month' },
];

function presetRange(days: number | 'today' | 'month'): DateRange {
  const today = new Date();
  if (days === 'today') return { from: isoDate(today), to: isoDate(today) };
  if (days === 'month') return { from: isoDate(new Date(today.getFullYear(), today.getMonth(), 1)), to: isoDate(today) };
  return { from: isoDate(new Date(today.getTime() - (days - 1) * 86400000)), to: isoDate(today) };
}

export function DateRangePopover({ value, onChange }: { value: DateRange; onChange: (range: DateRange) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);

  const openPopover = () => { setDraft(value); setOpen(true); };
  const apply = (range: DateRange) => { onChange(range.from > range.to ? { from: range.to, to: range.from } : range); setOpen(false); };

  return <div className="date-range-anchor">
    <button className="date-filter" onClick={openPopover}><Icon name="calendar" size={15} />{formatDateRangeLabel(value)}<Icon name="chevron" size={14} /></button>
    {open && <>
      <div className="date-range-backdrop" onMouseDown={() => setOpen(false)} />
      <div className="date-range-popover" onMouseDown={(event) => event.stopPropagation()}>
        <div className="date-range-presets">
          {presets.map((preset) => <button type="button" key={preset.label} onClick={() => apply(presetRange(preset.days))}>{preset.label}</button>)}
        </div>
        <div className="date-range-custom">
          <label>De<input type="date" value={draft.from} max={draft.to} onChange={(event) => setDraft({ ...draft, from: event.target.value })} /></label>
          <label>Até<input type="date" value={draft.to} min={draft.from} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></label>
        </div>
        <div className="date-range-footer">
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button>
          <Button onClick={() => apply(draft)}>Aplicar</Button>
        </div>
      </div>
    </>}
  </div>;
}
