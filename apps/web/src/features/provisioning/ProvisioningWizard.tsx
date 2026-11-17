import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Badge, Button, Icon, Panel } from '../../components/ui';
import { EgressPicker } from './EgressPicker';
import { PhonePicker } from './PhonePicker';
import { apiErrorCode, assignEgressNode, createJob, fetchEgressNodes, fetchPhones } from './provisioning.api';
import { appLabels, createErrorMessages, digitsOnly, formatPhoneParts, validatePhoneNumber } from './provisioning.labels';
import type { EgressList, Job, Phone, ProvisioningApp, WizardPrefill } from './provisioning.types';

type Step = 0 | 1 | 2 | 3;
const steps = ['Rede (IP)', 'Telefone', 'App', 'Número'] as const;

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

type Props = { tenantId: string; currentUserId?: string; prefill?: WizardPrefill; onJobCreated: (job: Job) => void };

export function ProvisioningWizard({ tenantId, currentUserId, prefill, onJobCreated }: Props) {
  const [step, setStep] = useState<Step>(0);
  const [egress, setEgress] = useState<EgressList | null>(null);
  const [egressLoading, setEgressLoading] = useState(false);
  const [egressError, setEgressError] = useState('');
  const [phones, setPhones] = useState<Phone[] | null>(null);
  const [phonesLoading, setPhonesLoading] = useState(false);
  const [phonesError, setPhonesError] = useState('');
  const [egressNode, setEgressNode] = useState(prefill?.egressNode ?? '');
  const [phoneId, setPhoneId] = useState(prefill?.phoneId ?? '');
  const [app, setApp] = useState<ProvisioningApp>(prefill?.app ?? 'whatsapp');
  const [countryCode, setCountryCode] = useState(prefill?.countryCode ?? '55');
  const [number, setNumber] = useState(prefill?.number ?? '');
  const [powerOffWhenDone, setPowerOffWhenDone] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [numberTouched, setNumberTouched] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState('');

  const loadEgress = useCallback(async () => {
    setEgressLoading(true); setEgressError('');
    try {
      const next = await fetchEgressNodes(tenantId);
      setEgress(next);
      // Mantém a escolha se ainda estiver online; senão pré-seleciona o PC do usuário (online).
      setEgressNode((current) => {
        if (current && next.items.some((node) => node.node === current && node.online)) return current;
        return next.items.find((node) => node.isMine && node.online)?.node ?? '';
      });
    } catch (error) { setEgressError(errorText(error)); }
    finally { setEgressLoading(false); }
  }, [tenantId]);

  // Um PC tem no máximo uma pessoa (marcar como meu tira de quem tinha); uma pessoa pode ter mais de um PC.
  const claimEgress = async (node: string) => {
    if (!currentUserId) return;
    setClaiming(true); setClaimError('');
    try {
      const updated = await assignEgressNode(tenantId, node, currentUserId);
      setEgress((current) => current && { ...current, items: current.items.map((item) => item.node === node ? updated : item) });
    } catch (error) { setClaimError(errorText(error)); }
    finally { setClaiming(false); }
  };

  const loadPhones = useCallback(async () => {
    setPhonesLoading(true); setPhonesError('');
    try {
      const next = await fetchPhones(tenantId);
      setPhones(next);
      setPhoneId((current) => next.some((phone) => phone.id === current && !phone.busyJobId && phone.status !== 'expired') ? current : '');
    } catch (error) { setPhonesError(errorText(error)); }
    finally { setPhonesLoading(false); }
  }, [tenantId]);

  useEffect(() => { void loadEgress(); }, [loadEgress]);
  useEffect(() => { if (step === 1 && !phones && !phonesLoading && !phonesError) void loadPhones(); }, [step, phones, phonesLoading, phonesError, loadPhones]);

  const selectedNode = egress?.items.find((node) => node.node === egressNode && node.online);
  const selectedPhone = phones?.find((phone) => phone.id === phoneId && !phone.busyJobId && phone.status !== 'expired');
  const numberError = validatePhoneNumber(countryCode, number);
  const canContinue = step === 0 ? Boolean(egress?.configured && selectedNode)
    : step === 1 ? Boolean(selectedPhone)
      : step === 2 ? Boolean(app)
        : !numberError;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setNumberTouched(true);
    if (!selectedNode || !selectedPhone || numberError) return;
    setSubmitting(true); setSubmitError('');
    try {
      const job = await createJob(tenantId, { egressNode: selectedNode.node, geelarkPhoneId: selectedPhone.id, app, countryCode: digitsOnly(countryCode), number: digitsOnly(number), powerOffWhenDone });
      onJobCreated(job);
    } catch (error) {
      const code = apiErrorCode(error);
      setSubmitError((code && createErrorMessages[code]) || errorText(error));
      if (code === 'egress_offline' || code === 'egress_not_configured') { setStep(0); void loadEgress(); }
      if (code === 'phone_busy') { setStep(1); void loadPhones(); }
    } finally { setSubmitting(false); }
  };

  const next = () => { if (canContinue && step < 3) setStep((step + 1) as Step); };
  const back = () => { if (step > 0) setStep((step - 1) as Step); };

  return <Panel className="provisioning-wizard">
    <div className="wizard-heading">
      <div><span className="eyebrow">NOVO CADASTRO</span><h2>{steps[step]}</h2><p>{[
        'Escolha o PC do atendente pelo qual o phone vai sair para a internet. O cadastro só começa com o PC online.',
        'Escolha o cloud phone do GeeLark onde o WhatsApp será cadastrado.',
        'Escolha qual app cadastrar neste phone.',
        'Informe o número que vai receber o SMS de confirmação.',
      ][step]}</p></div>
      <span className="wizard-count">Passo {step + 1} de {steps.length}</span>
    </div>
    <ol className="wizard-steps provisioning-steps" aria-label="Etapas do cadastro">
      {steps.map((label, index) => <li key={label} className={index === step ? 'is-current' : index < step ? 'is-done' : ''}>
        <button type="button" disabled={index >= step} onClick={() => setStep(index as Step)}><span>{index < step ? <Icon name="check" size={11} /> : index + 1}</span><small>{label}</small></button>
      </li>)}
    </ol>

    {submitError && <div className="alert" role="alert"><Icon name="alert" size={17} /><span>{submitError}</span><button type="button" onClick={() => setSubmitError('')} aria-label="Fechar erro"><Icon name="close" size={16} /></button></div>}

    <form onSubmit={(event) => { if (step === 3) void submit(event); else { event.preventDefault(); next(); } }}>
      {step === 0 && <EgressPicker egress={egress} loading={egressLoading} error={egressError} selected={egressNode} onSelect={setEgressNode} onRefresh={() => void loadEgress()} onClaim={currentUserId ? (node) => void claimEgress(node) : undefined} claiming={claiming} claimError={claimError} />}
      {step === 1 && <PhonePicker phones={phones} loading={phonesLoading} error={phonesError} selected={phoneId} onSelect={setPhoneId} onRefresh={() => void loadPhones()} />}
      {step === 2 && <div className="choice-list" role="radiogroup" aria-label="App">
        {(['whatsapp', 'business'] as const).map((option) => {
          const installed = selectedPhone?.apps?.[option];
          return <button type="button" role="radio" aria-checked={app === option} key={option} className={`choice-card${app === option ? ' is-selected' : ''}`} onClick={() => setApp(option)}>
            <span className="pick-icon"><Icon name="phone" size={15} /></span>
            <span className="pick-copy"><strong>{appLabels[option]}</strong><small>{installed === true ? 'Já instalado neste phone' : installed === false ? 'Será instalado automaticamente' : 'Instalação conferida quando o phone ligar'}</small></span>
            {installed === true ? <Badge tone="success">instalado</Badge> : <span className="choice-radio" />}
          </button>;
        })}
      </div>}
      {step === 3 && <div className="provisioning-step-body">
        <div className="provisioning-number-grid">
          <label>
            <span>País</span>
            <span className="provisioning-cc"><em>+</em><input aria-label="Código do país" value={countryCode} inputMode="numeric" maxLength={3} onChange={(event) => setCountryCode(digitsOnly(event.target.value).slice(0, 3))} /></span>
          </label>
          <label>
            <span>Número (com DDD)</span>
            <input aria-label="Número" value={number} inputMode="tel" autoComplete="off" placeholder="Ex.: 11 98765-4321" onChange={(event) => setNumber(event.target.value.replace(/[^\d\s().-]/g, ''))} onBlur={() => setNumberTouched(true)} />
          </label>
        </div>
        {digitsOnly(number) && !numberError && <p className="form-hint">O WhatsApp vai enviar o SMS para <strong>{formatPhoneParts(countryCode, number)}</strong>.</p>}
        {numberTouched && numberError && <p className="provisioning-field-error" role="alert">{numberError}</p>}
        <label className="check-card provisioning-check">
          <input type="checkbox" checked={powerOffWhenDone} onChange={(event) => setPowerOffWhenDone(event.target.checked)} />
          <span className="pick-copy"><strong>Desligar o phone ao terminar</strong><small>Phone ligado é cobrado por minuto no GeeLark.</small></span>
        </label>
        <div className="provisioning-summary">
          <span>Rede: <strong>{selectedNode?.label ?? '—'}</strong></span>
          <span>Phone: <strong>{selectedPhone?.name ?? '—'}</strong></span>
          <span>App: <strong>{appLabels[app]}</strong></span>
        </div>
      </div>}

      <div className="wizard-footer">
        <Button type="button" variant="ghost" onClick={back} disabled={step === 0 || submitting}>Voltar</Button>
        {step < 3
          ? <Button type="submit" disabled={!canContinue}>Continuar</Button>
          : <Button type="submit" icon="play" disabled={submitting || !selectedNode || !selectedPhone}>{submitting ? 'Iniciando…' : 'Iniciar cadastro'}</Button>}
      </div>
    </form>
  </Panel>;
}
