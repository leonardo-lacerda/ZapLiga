import type { AnyRow } from '../../types';
import { Badge, Button, Panel, SectionHeader } from '../../components/ui';
import { DataTable } from '../../components/DataTable';
export function SdrsPage({ sdrs, sdrName, setSdrName, createSdr }: AnyRow) { return <><div className="page-heading"><div><span className="eyebrow">EQUIPE</span><h1>SDRs</h1><p>Cadastre e acompanhe os operadores disponíveis.</p></div><Badge tone="info">{sdrs.length} SDRs</Badge></div><Panel><SectionHeader title="Cadastrar SDR" description="Adicione uma pessoa à equipe de atendimento." /><form className="form-row" onSubmit={createSdr}><input placeholder="Nome do SDR" value={sdrName} onChange={(e) => setSdrName(e.target.value)} required /><Button icon="plus">Cadastrar</Button></form></Panel><DataTable rows={sdrs} columns={['name', 'available']} /></>; }

