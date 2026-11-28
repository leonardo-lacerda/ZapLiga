/**
 * Line learnings, formula v1 (docs/line-monitor.md): pure functions over the rows the service
 * reads, so each question can be checked with plain data. "Fell" means WhatsApp took the line
 * (LINE_FELL_CAUSES); rates are falls per 100 calls, smoothed so a group with few calls does not
 * swing to 0 or 100.
 */
export const LINE_LEARNINGS_FORMULA_VERSION = 1;
export const LEARNINGS_DEFAULT_DAYS = 30;
/** Confidence by distinct lines behind a number: the line is what falls, not the call. */
export const SMALL_SAMPLE_LINES = 5;
export const SOLID_SAMPLE_LINES = 10;
/** A precursor counts when the fallen lines' rate is this much above everyone's. */
const PRECURSOR_FACTOR = 1.3;
/** A group must differ from the other this much (ratio of rates) to be called out. */
const NOTABLE_RATIO = 1.5;
const AGE_BANDS: Array<[string, number, number]> = [['menos de 1 dia', 0, 0], ['1 a 3 dias', 1, 3], ['4 a 7 dias', 4, 7], ['mais de 7 dias', 8, Infinity]];
const VOLUME_BANDS: Array<[string, number, number]> = [['até 20 ligações', 1, 20], ['21 a 40', 21, 40], ['41 a 60', 41, 60], ['mais de 60', 61, Infinity]];

export type Confidence = 'insufficient_data' | 'directional' | 'reliable';
export type DayRow = {
  number_id: string; day: string; age_days: number | null; stealth: boolean; device_profile: boolean; business: boolean; config_estimated: boolean;
  waxum_node: string | null; calls: number; answered: number; short_answered: number; closed_1005: number; lost: boolean; reconnects: number; node_moves: number;
};
export type LastCall = { at: string; answered: boolean; talkSeconds: number | null; outcome: string | null };
export type FallRow = { number_id: string; cause: string; hour: number; context: null | {
  waxumNode?: string; ageHours?: number | null; callsToday?: number; callsSincePairing?: number; canaryManual?: boolean; lastCalls?: LastCall[];
} };
export type CanaryRow = { number_id: string; manual: boolean; fell_after: boolean };
export type SignalRow = { before_fall: boolean; calls: number; ack_errors: number; receipt_ms: number | null };
export type HourRow = { hour: number; calls: number };
export type LearningInput = { days: DayRow[]; falls: FallRow[]; canaries: CanaryRow[]; signals: SignalRow[]; hours: HourRow[] };

export type Group = { label: string; lines: number; calls: number; falls: number; ratePer100: number; confidence: Confidence };
export type Finding = {
  key: string; question: string; answer: string; action: string; confidence: Confidence;
  groups?: Group[]; values?: Record<string, number | string | null>;
};
export type Thresholds = { attentionCalls: number | null; attentionConfidence: Confidence; closed1005Rate: number | null; closed1005Confidence: Confidence };

export const confidenceFor = (lines: number): Confidence => (lines < SMALL_SAMPLE_LINES ? 'insufficient_data' : lines < SOLID_SAMPLE_LINES ? 'directional' : 'reliable');
const weakest = (...levels: Confidence[]): Confidence => (levels.includes('insufficient_data') ? 'insufficient_data' : levels.includes('directional') ? 'directional' : 'reliable');
export const smoothedPer100 = (falls: number, calls: number) => Math.round(((falls + 1) / (calls + 2)) * 10000) / 100;
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);
const fmt = (value: number) => value.toLocaleString('pt-BR', { maximumFractionDigits: 1 });

export function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const base = Math.floor(position);
  const next = sorted[base + 1] ?? sorted[base];
  return Math.round((sorted[base] + (next - sorted[base]) * (position - base)) * 10) / 10;
}

export function group(label: string, rows: DayRow[]): Group {
  const calls = rows.reduce((total, row) => total + row.calls, 0);
  const falls = rows.filter((row) => row.lost).length;
  const lines = new Set(rows.map((row) => row.number_id)).size;
  return { label, lines, calls, falls, ratePer100: smoothedPer100(falls, calls), confidence: confidenceFor(lines) };
}

/** "A cai X× mais que B" when the two groups have enough lines and differ enough; otherwise null. */
function compare(a: Group, b: Group) {
  if (!a.calls || !b.calls) return null;
  const ratio = a.ratePer100 / b.ratePer100;
  if (ratio >= NOTABLE_RATIO) return `${a.label} caíram ${fmt(ratio)}× mais por 100 ligações que ${b.label}`;
  if (1 / ratio >= NOTABLE_RATIO) return `${b.label} caíram ${fmt(1 / ratio)}× mais por 100 ligações que ${a.label}`;
  return null;
}

function bandFinding(key: string, question: string, rows: DayRow[], bands: Array<[string, number, number]>, value: (row: DayRow) => number | null, action: string): Finding {
  const groups = bands.map(([label, min, max]) => group(label, rows.filter((row) => { const v = value(row); return v !== null && v >= min && v <= max; }))).filter((g) => g.calls > 0);
  const usable = groups.filter((g) => g.confidence !== 'insufficient_data');
  const worst = [...usable].sort((a, b) => b.ratePer100 - a.ratePer100)[0];
  const best = [...usable].sort((a, b) => a.ratePer100 - b.ratePer100)[0];
  const answer = worst && best && worst !== best && worst.ratePer100 / best.ratePer100 >= NOTABLE_RATIO
    ? `As linhas caem mais em "${worst.label}" (${fmt(worst.ratePer100)} por 100 ligações) do que em "${best.label}" (${fmt(best.ratePer100)}).`
    : groups.length ? 'Ainda sem diferença clara entre as faixas.' : 'Ainda não há dados para esta pergunta.';
  return { key, question, answer, action, groups, confidence: usable.length >= 2 ? weakest(...usable.map((g) => g.confidence)) : 'insufficient_data' };
}

function pairFinding(key: string, question: string, rows: DayRow[], test: (row: DayRow) => boolean, labels: [string, string], action: string): Finding {
  const yes = group(labels[0], rows.filter(test));
  const no = group(labels[1], rows.filter((row) => !test(row)));
  const confidence = weakest(yes.confidence, no.confidence);
  const said = confidence === 'insufficient_data' ? null : compare(yes, no);
  return { key, question, answer: said ? `${said}.` : (yes.calls && no.calls ? 'Ainda sem diferença clara.' : 'Ainda não há linhas dos dois lados para comparar.'), action, groups: [yes, no], confidence };
}

export function computeFindings(input: LearningInput): { findings: Finding[]; thresholds: Thresholds; sample: Record<string, number> } {
  const { days, falls, canaries, signals, hours } = input;
  // Setup questions only read days whose setup was recorded on the day (not copied afterwards).
  const recorded = days.filter((row) => !row.config_estimated && row.calls > 0);
  const active = days.filter((row) => row.calls > 0);
  const fallLines = new Set(falls.map((fall) => fall.number_id)).size;
  const findings: Finding[] = [];

  // 1. Calls until the fall.
  const sincePairing = falls.map((fall) => fall.context?.callsSincePairing).filter((v): v is number => typeof v === 'number');
  const onFallDay = falls.map((fall) => fall.context?.callsToday).filter((v): v is number => typeof v === 'number');
  const q1 = quantile(sincePairing, 0.25);
  const median = quantile(sincePairing, 0.5);
  const attentionConfidence = confidenceFor(new Set(falls.filter((fall) => typeof fall.context?.callsSincePairing === 'number').map((fall) => fall.number_id)).size);
  findings.push({
    key: 'calls_until_fall', question: 'Com quantas ligações as linhas caem?', confidence: attentionConfidence,
    answer: median === null ? 'Ainda não há quedas com a ficha registrada.' : `Metade das linhas caiu com até ${fmt(median)} ligações desde o pareamento; um quarto, com até ${fmt(q1 ?? 0)}. No dia da queda, a mediana foi de ${fmt(quantile(onFallDay, 0.5) ?? 0)} ligações.`,
    action: q1 === null ? 'Esperar as próximas quedas.' : `Tratar ${fmt(q1)} ligações desde o pareamento como ponto de atenção: o Monitor avisa quando uma linha passa disso.`,
    values: { falls: sincePairing.length, q1, median, q3: quantile(sincePairing, 0.75), medianOnFallDay: quantile(onFallDay, 0.5) },
  });

  // 2. Age since pairing.
  findings.push(bandFinding('age', 'A idade da linha importa?', recorded, AGE_BANDS, (row) => row.age_days, 'Concentrar o volume nas faixas de idade que caem menos e segurar as linhas na faixa que mais cai.'));
  // 3. Volume of the day.
  findings.push(bandFinding('daily_volume', 'O volume de ligações do dia importa?', active, VOLUME_BANDS, (row) => row.calls, 'Ajustar o limite diário para ficar abaixo da faixa em que as linhas mais caem.'));

  // 4. Exit: PC against proxy, and each exit.
  const exitGroups = [...new Set(recorded.map((row) => row.waxum_node ?? 'sem saída'))].map((node) => group(node, recorded.filter((row) => (row.waxum_node ?? 'sem saída') === node)));
  const proxy = pairFinding('exit', 'A saída de internet importa?', recorded, (row) => String(row.waxum_node ?? '').startsWith('proxy-'), ['linhas no proxy', 'linhas nos PCs'], 'Mover as linhas para a saída que cai menos e não lotar um PC só.');
  findings.push({ ...proxy, groups: [...(proxy.groups ?? []), ...exitGroups] });

  // 5. Camouflage and device profile.
  findings.push(pairFinding('stealth', 'A camuflagem ajuda?', recorded, (row) => row.stealth, ['linhas com camuflagem', 'linhas sem camuflagem'], 'Manter a opção que cai menos nas linhas novas.'));
  findings.push(pairFinding('device_profile', 'O perfil de aparelho ajuda?', recorded, (row) => row.device_profile, ['linhas com perfil de aparelho', 'linhas sem perfil'], 'Manter a opção que cai menos nas linhas novas.'));
  findings.push(pairFinding('business', 'WhatsApp Business cai menos?', recorded, (row) => row.business, ['linhas Business', 'linhas comuns'], 'Preferir o tipo de conta que cai menos.'));

  // 6. Canary.
  const flowed = canaries.filter((row) => !row.manual);
  const manual = canaries.filter((row) => row.manual);
  const firstCall = falls.filter((fall) => (fall.context?.callsSincePairing ?? Infinity) <= 1).length;
  const canaryConfidence = weakest(confidenceFor(new Set(flowed.map((row) => row.number_id)).size), confidenceFor(new Set(manual.map((row) => row.number_id)).size));
  findings.push({
    key: 'canary', question: 'O canário funciona?', confidence: canaryConfidence,
    answer: `Das linhas que passaram pelo canário, ${pct(flowed.filter((row) => row.fell_after).length, flowed.length)}% caíram em até 7 dias; das liberadas à mão, ${pct(manual.filter((row) => row.fell_after).length, manual.length)}%. ${firstCall} queda(s) aconteceram na 1ª ligação.`,
    action: 'Se as liberadas à mão caem mais, fazer sempre o canário antes de ligar para leads.',
    values: { canaryPassed: flowed.length, canaryFellAfter: flowed.filter((row) => row.fell_after).length, manualPassed: manual.length, manualFellAfter: manual.filter((row) => row.fell_after).length, fellOnFirstCall: firstCall },
  });

  // 7. What happens before the fall: the last 10 calls against everyone's rates.
  const last = falls.flatMap((fall) => fall.context?.lastCalls ?? []);
  const baseCalls = active.reduce((total, row) => total + row.calls, 0);
  const base1005 = pct(active.reduce((total, row) => total + row.closed_1005, 0), baseCalls);
  const baseAnswered = pct(active.reduce((total, row) => total + row.answered, 0), baseCalls);
  const fall1005 = pct(last.filter((call) => String(call.outcome ?? '').startsWith('waxum_closed:1005')).length, last.length);
  const fallAnswered = pct(last.filter((call) => call.answered).length, last.length);
  const precursorConfidence = confidenceFor(new Set(falls.filter((fall) => fall.context?.lastCalls?.length).map((fall) => fall.number_id)).size);
  const precursor1005 = last.length && fall1005 >= base1005 * PRECURSOR_FACTOR && fall1005 > 0;
  findings.push({
    key: 'precursors', question: 'O que acontece nas ligações antes de cair?', confidence: precursorConfidence,
    answer: last.length ? `Nas 10 ligações antes da queda, ${fmt(fall1005)}% caíram com erro 1005 (média geral ${fmt(base1005)}%) e ${fmt(fallAnswered)}% foram atendidas (média ${fmt(baseAnswered)}%).` : 'Ainda não há quedas com a ficha registrada.',
    action: precursor1005 ? `Pausar a linha quando mais de ${fmt(fall1005)}% das últimas 10 ligações caírem com 1005: o Monitor avisa.` : 'Nenhum sinal claro antes da queda por enquanto.',
    values: { lastCalls: last.length, fall1005, base1005, fallAnswered, baseAnswered },
  });

  // 8. Call signals before the fall.
  const before = signals.find((row) => row.before_fall);
  const others = signals.find((row) => !row.before_fall);
  findings.push({
    key: 'signals', question: 'Os sinais da ligação avisam a queda?', confidence: precursorConfidence,
    answer: before?.calls ? `Nas 24 h antes de uma queda, ${fmt(pct(before.ack_errors, before.calls))}% das ligações tiveram erro na oferta (demais: ${fmt(pct(others?.ack_errors ?? 0, others?.calls ?? 0))}%). O WhatsApp confirmou a oferta em ${fmt(before.receipt_ms ?? 0)} ms (demais: ${fmt(others?.receipt_ms ?? 0)} ms).` : 'Ainda não há ligações com sinais antes de uma queda.',
    action: 'Se a diferença se mantiver, usar o erro na oferta como alerta para pausar a linha.',
    values: { callsBeforeFall: before?.calls ?? 0, ackErrorsBeforeFall: before?.ack_errors ?? 0, receiptMsBeforeFall: before?.receipt_ms ?? null, callsOther: others?.calls ?? 0, ackErrorsOther: others?.ack_errors ?? 0, receiptMsOther: others?.receipt_ms ?? null },
  });

  // 9. PC moves and reconnects.
  const moves = pairFinding('moves', 'Trocar de PC derruba a linha?', active, (row) => row.node_moves > 0, ['dias com troca de PC', 'dias sem troca'], 'Se os dias com troca caem mais, trocar de PC só quando o PC cair, e com calma.');
  const reconnects = pairFinding('reconnects', 'Reconectar muito derruba a linha?', active, (row) => row.reconnects >= 3, ['dias com 3+ reconexões', 'dias com menos'], 'Se cair mais, investigar a internet do PC dessas linhas.');
  findings.push(moves, reconnects);

  // 10. Hour of the day.
  const totalCalls = hours.reduce((total, row) => total + row.calls, 0);
  const byHour = hours.map((row) => ({ hour: row.hour, calls: row.calls, falls: falls.filter((fall) => fall.hour === row.hour).length }))
    .map((row) => ({ ...row, fallShare: pct(row.falls, falls.length), callShare: pct(row.calls, totalCalls) }));
  const hot = [...byHour].filter((row) => row.falls > 0).sort((a, b) => (b.fallShare - b.callShare) - (a.fallShare - a.callShare))[0];
  findings.push({
    key: 'hours', question: 'Em que horário as linhas caem?', confidence: confidenceFor(fallLines),
    answer: hot ? `${hot.hour}h concentra ${fmt(hot.fallShare)}% das quedas e ${fmt(hot.callShare)}% das ligações.` : 'Ainda não há quedas no período.',
    action: hot && hot.fallShare > hot.callShare * NOTABLE_RATIO ? `Reduzir o volume perto das ${hot.hour}h e ver se as quedas acompanham.` : 'As quedas acompanham o volume de cada hora.',
    values: Object.fromEntries(byHour.map((row) => [`${row.hour}h`, `${row.falls} quedas / ${row.calls} ligações`])),
  });

  return {
    findings,
    thresholds: { attentionCalls: q1, attentionConfidence, closed1005Rate: precursor1005 ? fall1005 : null, closed1005Confidence: precursorConfidence },
    sample: { lineDays: active.length, recordedLineDays: recorded.length, lines: new Set(active.map((row) => row.number_id)).size, calls: baseCalls, falls: falls.length, fallLines },
  };
}
