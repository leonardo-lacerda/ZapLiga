import { useEffect, useState } from 'react';
import type { AnyRow } from '../../types';
import { Badge, Button, Icon, Panel, SectionHeader } from '../../components/ui';
import { json } from '../../services/api';

const percent = (value: unknown) => value == null ? '—' : `${Math.round(Number(value) * 100)}%`;
const bandLabel = (value: string, kind: 'team' | 'volume') => kind === 'team'
  ? ({ '1_5': 'Equipe de 1–5', '6_20': 'Equipe de 6–20', '21_plus': 'Equipe de 21+' }[value] ?? value)
  : ({ '20_99': '20–99 chamadas', '100_499': '100–499 chamadas', '500_plus': '500+ chamadas' }[value] ?? value);

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
      const [nextConsent, nextData] = await Promise.all([
        json(`/api/tenants/${tenantId}/benchmarks/consent`),
        json(`/api/tenants/${tenantId}/benchmarks/cohorts`),
      ]);
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
      setConfirmed(false); setMessage('Participação ativada. Os próximos agregados poderão incluir esta operação.'); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const revoke = async () => {
    setBusy(true); setError(''); setMessage('');
    try { await json(`/api/tenants/${tenantId}/benchmarks/consent/revoke`, { method: 'POST', body: JSON.stringify({ reason: 'Revogado pelo operador na central de benchmarks' }) }); setMessage('Participação revogada. Novos processamentos compartilhados foram bloqueados.'); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  if (!enabled) return <Panel><div className="benchmarks-empty"><Icon name="lock" size={22} /><strong>Benchmarks ainda não habilitados</strong><p>Esta capacidade só aparece quando a empresa e a governança estiverem prontas para participação agregada.</p></div></Panel>;
  if (loading && !consent) return <div className="benchmarks-page"><div className="benchmarks-loading">Verificando participação e privacidade…</div></div>;

  const policy = consent?.policy ?? {};
  const optedIn = consent?.status === 'opt_in';
  const pendingApproval = data?.status === 'pending_legal_approval' || policy.consentApproved === false;
  return <div className="benchmarks-page">
    <div className="benchmarks-heading"><div><span className="eyebrow">BENCHMARK PRIVADO</span><h1>Operações semelhantes, sem ranking</h1><p>Veja faixas agregadas de empresas que escolheram participar, sem expor nenhum cliente individual.</p></div><Badge tone={optedIn ? 'success' : 'info'}>{optedIn ? 'Participação ativa' : 'Participação opcional'}</Badge></div>
    {(error || message) && <div className={`benchmarks-notice ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>{error || message}</div>}
    <Panel className="benchmarks-consent-panel"><div className="benchmarks-consent-copy"><Icon name="lock" size={18} /><div><strong>Controle de participação</strong><p>Somente métricas agregadas, percentis e faixas de volume entram no benchmark. Não compartilhamos nomes, telefones, leads, textos, campanhas ou identificadores da sua empresa.</p><small>Versão da finalidade: {policy.termsVersion ?? '—'} · mínimo de {policy.minimumTenants ?? 5} empresas por coorte</small></div></div>{optedIn ? <div className="benchmarks-consent-actions"><Badge tone="success">Opt-in registrado</Badge><Button variant="secondary" onClick={() => void revoke()} disabled={busy}>Revogar participação</Button></div> : pendingApproval ? <div className="benchmarks-pending"><Icon name="info" size={15} /><span>Infraestrutura pronta, mas o texto jurídico e a finalidade ainda aguardam aprovação. Nenhum benchmark está sendo processado.</span></div> : <div className="benchmarks-optin"><label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> Li a finalidade e autorizo o uso de métricas agregadas para benchmark privado.</label><Button onClick={() => void optIn()} disabled={!confirmed || busy}>{busy ? 'Registrando…' : 'Participar do benchmark'}</Button></div>}</Panel>
    {optedIn && data?.status === 'ready' && <><Panel><SectionHeader eyebrow="COORTES ELEGÍVEIS" title="Faixas de operações semelhantes" description={`Cada coorte exige pelo menos ${policy.minimumTenants ?? 5} empresas e ${policy.minimumCallsPerTenant ?? 20} chamadas por empresa. Extremos são aparados antes da exibição.`} /><div className="benchmarks-grid">{(data.items ?? []).map((item: AnyRow) => <article className="benchmark-card" key={item.cohortKey}><div className="benchmark-card-heading"><strong>{bandLabel(item.teamSizeBand, 'team')}</strong><Badge tone="info">{bandLabel(item.volumeBand, 'volume')}</Badge></div><span>{item.eligibleTenants} empresas · {item.calls} chamadas agregadas</span><div className="benchmark-metrics"><div><small>Atendimento p25</small><strong>{percent(item.answerRate?.p25)}</strong></div><div><small>Mediana</small><strong>{percent(item.answerRate?.median)}</strong></div><div><small>Atendimento p75</small><strong>{percent(item.answerRate?.p75)}</strong></div><div><small>Média aparada</small><strong>{percent(item.answerRate?.trimmedMean)}</strong></div></div></article>)}</div></Panel><Panel className="benchmarks-methodology"><SectionHeader eyebrow="METODOLOGIA" title="Como ler este benchmark" description="O benchmark é uma referência descritiva para contexto, não uma promessa de resultado nem uma comparação nominal entre clientes." /><div className="benchmarks-methodology-grid"><div><strong>Coorte</strong><span>Porte da equipe e volume total no mesmo período.</span></div><div><strong>Privacidade</strong><span>Mínimo de empresas, sem IDs no retorno e sem ranking individual.</span></div><div><strong>Estatística</strong><span>Faixa p25–p75 e média aparada para reduzir extremos identificáveis.</span></div><div><strong>Revogação</strong><span>Opt-out impede novos processamentos compartilhados.</span></div></div></Panel></>}
    {optedIn && data?.status === 'insufficient_data' && <Panel><div className="benchmarks-empty-inline"><Icon name="chart" size={18} /><strong>Ainda não há uma coorte segura para exibir</strong><span>É preciso atingir os mínimos de empresas elegíveis e chamadas por operação.</span></div></Panel>}
  </div>;
}
