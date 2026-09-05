import { useEffect, useState } from 'react';
import type { AnyRow } from '../../types';
import { Badge, Button, Icon, Panel, SectionHeader } from '../../components/ui';
import { EmptyGuide, FeatureOff, HowItWorks, LoadingBlock, Notice, PageIntro, TechnicalDetails } from '../../components/guide';
import { json } from '../../services/api';

const percent = (value: unknown) => value == null ? '—' : `${Math.round(Number(value) * 100)}%`;
const teamBand: Record<string, string> = { '1_5': 'Equipes de 1 a 5 pessoas', '6_20': 'Equipes de 6 a 20 pessoas', '21_plus': 'Equipes com mais de 20 pessoas' };
const volumeBand: Record<string, string> = { '20_99': '20 a 99 chamadas', '100_499': '100 a 499 chamadas', '500_plus': '500 chamadas ou mais' };
const dateOnly = (value?: string) => value ? new Date(value).toLocaleDateString('pt-BR') : '—';

export function BenchmarksPage({ tenantId, enabled }: { tenantId: string; enabled: boolean }) {
  const [consent, setConsent] = useState<AnyRow | null>(null);
  const [data, setData] = useState<AnyRow | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = async () => {
    if (!enabled || !tenantId) return;
    setLoading(true);
    try {
      const [nextConsent, nextData] = await Promise.all([json(`/api/tenants/${tenantId}/benchmarks/consent`), json(`/api/tenants/${tenantId}/benchmarks/cohorts`)]);
      setConsent(nextConsent); setData(nextData); setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [tenantId, enabled]);

  const optIn = async () => {
    if (!confirmed || !consent?.policy?.termsVersion) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await json(`/api/tenants/${tenantId}/benchmarks/consent/opt-in`, { method: 'POST', body: JSON.stringify({ termsVersion: consent.policy.termsVersion, purposes: consent.policy.purposes }) });
      setConfirmed(false); setMessage('Participação ativada. Suas métricas agregadas passam a entrar nos próximos cálculos, e você já pode ver as faixas abaixo.'); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const revoke = async () => {
    if (!window.confirm('Sair do benchmark? Suas métricas deixam de entrar nos próximos cálculos e você deixa de ver as faixas.')) return;
    setBusy(true); setError(''); setMessage('');
    try { await json(`/api/tenants/${tenantId}/benchmarks/consent/revoke`, { method: 'POST', body: JSON.stringify({ reason: 'Revogado pelo operador na página de benchmarks' }) }); setMessage('Você saiu do benchmark. Nenhum cálculo novo usa os dados desta empresa.'); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  if (!enabled) return <FeatureOff title="Benchmarks ainda não estão ligados para esta empresa" description="Com benchmarks, você compara a sua taxa de atendimento com a faixa de empresas de porte parecido, sem ranking e sem expor nenhuma empresa. A participação é opcional." />;
  if (loading && !consent) return <LoadingBlock>Verificando participação e privacidade…</LoadingBlock>;

  const policy = consent?.policy ?? {};
  const optedIn = consent?.status === 'opt_in';
  const pendingApproval = data?.status === 'pending_legal_approval' || policy.consentApproved === false;
  const items: AnyRow[] = data?.items ?? [];

  return <div className="guide-page benchmarks-page">
    <PageIntro
      eyebrow="OPERAÇÃO"
      title="Benchmarks privados"
      purpose="Compare a sua taxa de atendimento com a faixa de empresas parecidas com a sua. Não há ranking nem nomes: só faixas agregadas. Você escolhe se participa e pode sair quando quiser."
      aside={<Badge tone={optedIn ? 'success' : 'neutral'}><i className="badge-dot" />{optedIn ? 'Participando' : pendingApproval ? 'Em preparação' : 'Não participa'}</Badge>}
    />
    {error && <Notice tone="error" onClose={() => setError('')}>{error}</Notice>}
    {message && <Notice tone="success" onClose={() => setMessage('')}>{message}</Notice>}

    {pendingApproval ? <Panel className="readiness readiness-wait">
      <span className="readiness-icon"><Icon name="clock" size={18} /></span>
      <div><strong>O benchmark ainda está em preparação</strong><p>A tecnologia está pronta, mas o termo de participação ainda não foi aprovado. Enquanto isso, nenhum dado de nenhuma empresa é usado. Assim que o termo for liberado, a opção de participar aparece aqui.</p></div>
    </Panel> : optedIn ? <Panel className="readiness readiness-ok">
      <span className="readiness-icon"><Icon name="check" size={18} /></span>
      <div><strong>Sua empresa participa do benchmark</strong><p>Entram no cálculo apenas totais e taxas. Nunca entram nomes, telefones, leads, textos de conversa, nomes de campanha ou qualquer identificador da sua empresa.</p><small>Termo {policy.termsVersion ?? '—'} · cada faixa reúne no mínimo {policy.minimumTenants ?? 5} empresas</small></div>
      <Button variant="ghost" onClick={() => void revoke()} disabled={busy}>Sair do benchmark</Button>
    </Panel> : <Panel className="consent-panel">
      <div className="consent-copy"><span className="readiness-icon"><Icon name="lock" size={18} /></span><div><strong>Participar é opcional e reversível</strong><p>Ao participar, a sua taxa de atendimento entra, de forma anônima, em uma faixa junto com pelo menos {policy.minimumTenants ?? 5} outras empresas do mesmo porte. Em troca, você vê onde a sua operação está em relação a essa faixa. Nunca compartilhamos nomes, telefones, leads, textos ou identificadores.</p></div></div>
      <div className="consent-actions">
        <label className="check-inline"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> Entendi e autorizo o uso de métricas agregadas da minha empresa no benchmark privado.</label>
        <Button onClick={() => void optIn()} disabled={!confirmed || busy}>{busy ? 'Registrando…' : 'Participar do benchmark'}</Button>
      </div>
    </Panel>}

    {optedIn && data?.status === 'ready' && <Panel>
      <SectionHeader title="Faixas de empresas parecidas" description={`Período: ${dateOnly(data?.period?.from)} a ${dateOnly(data?.period?.to)}. Cada faixa mostra onde fica a metade do meio das empresas: de p25 (um quarto atende menos que isto) até p75 (um quarto atende mais).`} />
      <div className="two-column">{items.map((item: AnyRow) => {
        const p25 = Number(item.answerRate?.p25 ?? 0) * 100; const p75 = Number(item.answerRate?.p75 ?? 0) * 100; const median = Number(item.answerRate?.median ?? 0) * 100;
        return <article className="cohort-card" key={item.cohortKey}>
          <div className="cohort-head"><strong>{teamBand[item.teamSizeBand] ?? item.teamSizeBand}</strong><Badge tone="info">{volumeBand[item.volumeBand] ?? item.volumeBand}</Badge></div>
          <small>{item.eligibleTenants} empresas · {item.calls} chamadas somadas</small>
          <div className="range-bar" aria-label={`Taxa de atendimento entre ${Math.round(p25)}% e ${Math.round(p75)}%, mediana ${Math.round(median)}%`}>
            <span className="range-fill" style={{ left: `${p25}%`, width: `${Math.max(1, p75 - p25)}%` }} />
            <span className="range-median" style={{ left: `${median}%` }} />
          </div>
          <div className="range-labels"><span>p25 <strong>{percent(item.answerRate?.p25)}</strong></span><span>mediana <strong>{percent(item.answerRate?.median)}</strong></span><span>p75 <strong>{percent(item.answerRate?.p75)}</strong></span></div>
          <p className="subtle">Metade das empresas deste grupo atende entre {percent(item.answerRate?.p25)} e {percent(item.answerRate?.p75)} das chamadas. Média sem extremos: {percent(item.answerRate?.trimmedMean)}.</p>
        </article>;
      })}</div>
    </Panel>}
    {optedIn && data?.status === 'insufficient_data' && <Panel><EmptyGuide icon="users" title="Ainda não há um grupo grande o bastante" text={`Uma faixa só aparece quando reúne pelo menos ${policy.minimumTenants ?? 5} empresas com ${policy.minimumCallsPerTenant ?? 20} chamadas ou mais cada. Isso garante que ninguém seja identificável. Volte em alguns dias.`} /></Panel>}

    <Panel>
      <SectionHeader title="Como isto funciona" />
      <HowItWorks items={[
        { icon: 'users', title: 'Grupos por porte', text: 'As empresas são agrupadas por tamanho de equipe e volume de chamadas no período. Você é comparado com quem opera em escala parecida.' },
        { icon: 'lock', title: 'Ninguém é identificável', text: `Cada faixa precisa de no mínimo ${policy.minimumTenants ?? 5} empresas. Valores extremos são aparados e nenhum identificador sai da sua conta.` },
        { icon: 'chart', title: 'Referência, não nota', text: 'A faixa mostra o que é comum no seu porte. Não é meta nem promessa: serve para saber se há espaço para melhorar.' },
      ]} />
      <TechnicalDetails><p className="subtle">Metodologia: coortes por porte de equipe e volume; apenas taxas agregadas, percentis (p25, mediana, p75) e média aparada; sem ranking nominal. Sair do benchmark bloqueia novos processamentos com os dados desta empresa. {data?.methodology ?? ''}</p></TechnicalDetails>
    </Panel>
  </div>;
}
