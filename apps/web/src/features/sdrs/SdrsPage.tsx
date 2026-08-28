import type { AnyRow } from '../../types';
import { Badge, Button, Panel, SectionHeader } from '../../components/ui';
import { DataTable } from '../../components/DataTable';
import { LiveTimer } from '../../components/LiveTimer';

export function SdrsPage({ sdrs, sdrName, setSdrName, createSdr }: AnyRow) {
  return <><div className="page-heading"><div><span className="eyebrow">EQUIPE</span><h1>SDRs</h1><p>Cadastre e acompanhe os operadores, chamadas e pausas.</p></div><Badge tone="info">{sdrs.length} SDRs</Badge></div><Panel><SectionHeader title="Cadastrar SDR" description="Adicione uma pessoa à equipe de atendimento." /><form className="form-row" onSubmit={createSdr}><input placeholder="Nome do SDR" value={sdrName} onChange={(e) => setSdrName(e.target.value)} required /><Button icon="plus">Cadastrar</Button></form></Panel><div className="sdr-state-grid">{sdrs.map((sdr: AnyRow) => <div className="sdr-state-card" key={sdr.id}><div><strong>{sdr.name}</strong><small>{sdr.state === 'post_call' && sdr.pause_lead_name ? `Pós-atendimento de ${sdr.pause_lead_name}` : 'Sem pausa em andamento'}</small></div><Badge tone={sdr.state === 'post_call' ? 'warning' : sdr.available ? 'success' : 'neutral'}>{sdr.state === 'post_call' ? <><span>Pós-atendimento · </span><LiveTimer startedAt={sdr.pause_started_at} /></> : sdr.available ? 'Disponível' : 'Offline'}</Badge></div>)}</div><DataTable rows={sdrs} columns={['name', 'state', 'available']} /></>;
}
