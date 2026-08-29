import { useRef, useState } from 'react';
import { Button, Panel, SectionHeader } from '../../components/ui';
import { EmptyState } from '../../components/ui';
import { downloadSvgAsPng } from './metrics-chart-export';
import { formatBucketLabel, formatNumber, formatPercent, formatSecondsShort } from './metrics.format';
import type { MetricsTrendGranularity, MetricsTrendPoint } from './metrics.types';

type SeriesKey = 'callsMade' | 'callsAnswered' | 'answerRate' | 'uniqueLeadsWorked' | 'positiveResults' | 'connectedSeconds';

const SERIES: { key: SeriesKey; label: string; format: (value: number) => string }[] = [
  { key: 'callsMade', label: 'Chamadas', format: formatNumber },
  { key: 'callsAnswered', label: 'Atendidas', format: formatNumber },
  { key: 'answerRate', label: 'Taxa de atendimento', format: formatPercent },
  { key: 'uniqueLeadsWorked', label: 'Leads únicos', format: formatNumber },
  { key: 'positiveResults', label: 'Resultados positivos', format: formatNumber },
  { key: 'connectedSeconds', label: 'Tempo conectado', format: formatSecondsShort },
];

const WIDTH = 640;
const HEIGHT = 220;
const PAD_LEFT = 42;
const PAD_RIGHT = 12;
const PAD_TOP = 16;
const PAD_BOTTOM = 28;

export function ActivityTrendChart({ trends, granularity }: { trends: MetricsTrendPoint[]; granularity: MetricsTrendGranularity }) {
  const [seriesKey, setSeriesKey] = useState<SeriesKey>('callsMade');
  const series = SERIES.find((item) => item.key === seriesKey)!;
  const svgRef = useRef<SVGSVGElement>(null);

  if (!trends.length) {
    return <Panel>
      <SectionHeader eyebrow="EVOLUÇÃO" title="Atividade ao longo do período" />
      <EmptyState title="Sem chamadas no período" description="Ajuste os filtros ou o intervalo de datas." />
    </Panel>;
  }

  const values = trends.map((point) => point[seriesKey]);
  const maxValue = Math.max(1, ...values);
  const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const xFor = (index: number) => PAD_LEFT + (trends.length === 1 ? plotWidth / 2 : (index / (trends.length - 1)) * plotWidth);
  const yFor = (value: number) => PAD_TOP + plotHeight - (value / maxValue) * plotHeight;

  const points = trends.map((point, index) => `${xFor(index)},${yFor(point[seriesKey])}`).join(' ');
  const areaPoints = `${PAD_LEFT},${PAD_TOP + plotHeight} ${points} ${xFor(trends.length - 1)},${PAD_TOP + plotHeight}`;
  const gridLines = [0, 0.25, 0.5, 0.75, 1];
  const labelStep = Math.max(1, Math.ceil(trends.length / 8));

  return <Panel>
    <SectionHeader
      eyebrow="EVOLUÇÃO" title="Atividade ao longo do período"
      description={`Granularidade: ${granularity === 'hour' ? 'por hora' : granularity === 'day' ? 'por dia' : 'por semana'}`}
      action={<Button variant="ghost" onClick={() => svgRef.current && downloadSvgAsPng(svgRef.current, `atividade-${series.key}.png`)}>Exportar imagem</Button>}
    />
    <div className="metrics-chart-legend" role="group" aria-label="Série exibida no gráfico">
      {SERIES.map((option) => <button key={option.key} type="button" className={option.key === seriesKey ? 'active' : ''} onClick={() => setSeriesKey(option.key)}>{option.label}</button>)}
    </div>
    <svg ref={svgRef} className="metrics-chart-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`Gráfico de linha: ${series.label} por período. Use a tabela abaixo para os valores exatos.`}>
      {gridLines.map((fraction) => {
        const y = PAD_TOP + plotHeight * (1 - fraction);
        return <g key={fraction}>
          <line x1={PAD_LEFT} x2={WIDTH - PAD_RIGHT} y1={y} y2={y} stroke="var(--border-subtle)" strokeWidth={1} />
          <text x={PAD_LEFT - 6} y={y + 3} textAnchor="end" fontSize={9} fill="var(--subtle)">{series.format(Math.round(maxValue * fraction))}</text>
        </g>;
      })}
      <polygon points={areaPoints} fill="var(--primary-soft)" opacity={0.7} />
      <polyline points={points} fill="none" stroke="var(--primary)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {trends.map((point, index) => <circle key={point.bucket} cx={xFor(index)} cy={yFor(point[seriesKey])} r={2.5} fill="var(--primary)" />)}
      {trends.map((point, index) => index % labelStep === 0 && <text key={`label-${point.bucket}`} x={xFor(index)} y={HEIGHT - 8} textAnchor="middle" fontSize={9} fill="var(--subtle)">{formatBucketLabel(point.bucket, granularity)}</text>)}
    </svg>
    <details className="metrics-alt-table">
      <summary>Ver como tabela</summary>
      <div className="table-container table-scroll">
        <table>
          <thead><tr><th>Período</th><th>Chamadas</th><th>Atendidas</th><th>Taxa de atendimento</th><th>Leads únicos</th><th>Resultados positivos</th><th>Tempo conectado</th></tr></thead>
          <tbody>{trends.map((point) => <tr key={point.bucket}>
            <td>{formatBucketLabel(point.bucket, granularity)}</td>
            <td>{formatNumber(point.callsMade)}</td>
            <td>{formatNumber(point.callsAnswered)}</td>
            <td>{formatPercent(point.answerRate)}</td>
            <td>{formatNumber(point.uniqueLeadsWorked)}</td>
            <td>{formatNumber(point.positiveResults)}</td>
            <td>{formatSecondsShort(point.connectedSeconds)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </details>
  </Panel>;
}
