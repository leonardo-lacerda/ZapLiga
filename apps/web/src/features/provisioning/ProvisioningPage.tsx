import { useState } from 'react';
import { Badge, Button, EmptyState, Panel } from '../../components/ui';
import { JobProgress } from './JobProgress';
import { PhonesPanel } from './PhonesPanel';
import { ProvisioningWizard } from './ProvisioningWizard';
import { RecentJobs } from './RecentJobs';
import { StatsPanel } from './StatsPanel';
import type { WizardPrefill } from './provisioning.types';

type Props = {
  tenantId: string;
  /** Usuário logado: habilita "Este PC é meu" no passo de Rede. */
  currentUserId?: string;
  /** Flag `whatsapp_provisioning` ligada e papel leader/super_admin (ver `canUseProvisioning`). */
  allowed: boolean;
  onOpenNumbers: () => void;
  pollIntervalMs?: number;
};

type View = { kind: 'wizard'; prefill?: WizardPrefill; key: number } | { kind: 'job'; jobId: string };

/** `/app/numeros/cadastrar` — assistente de cadastro de WhatsApp em cloud phones do GeeLark. */
export function ProvisioningPage({ tenantId, currentUserId, allowed, onOpenNumbers, pollIntervalMs }: Props) {
  const [view, setView] = useState<View>({ kind: 'wizard', key: 0 });

  const heading = <div className="page-heading">
    <div><span className="eyebrow">WHATSAPP · GEELARK</span><h1>Cadastrar número</h1><p>Cadastra um número de WhatsApp num cloud phone do GeeLark, saindo pelo IP do PC de um atendente.</p></div>
    <div className="provisioning-heading-actions"><Badge tone="purple">Recurso interno</Badge><Button variant="ghost" onClick={onOpenNumbers}>Voltar para Números</Button></div>
  </div>;

  if (!allowed) {
    return <div className="provisioning-page">{heading}<Panel><EmptyState title="Cadastro de WhatsApp não disponível" description="Este recurso interno precisa estar ligado para a empresa (Admin → Recursos da empresa) e é restrito a líderes e administradores da plataforma." /></Panel></div>;
  }

  const newWizard = (prefill?: WizardPrefill) => setView((current) => ({ kind: 'wizard', prefill, key: (current.kind === 'wizard' ? current.key : Date.now()) + 1 }));

  return <div className="provisioning-page">
    {heading}
    {view.kind === 'job'
      ? <JobProgress key={view.jobId} tenantId={tenantId} jobId={view.jobId} pollIntervalMs={pollIntervalMs} onBack={() => newWizard()} onNewJob={newWizard} onOpenNumbers={onOpenNumbers} />
      : <>
        <ProvisioningWizard key={view.key} tenantId={tenantId} currentUserId={currentUserId} prefill={view.prefill} onJobCreated={(job) => setView({ kind: 'job', jobId: job.id })} />
        <RecentJobs tenantId={tenantId} onOpen={(jobId) => setView({ kind: 'job', jobId })} />
      </>}
    <PhonesPanel tenantId={tenantId} onOpenJob={(jobId) => setView({ kind: 'job', jobId })} />
    {view.kind === 'wizard' && <StatsPanel tenantId={tenantId} />}
  </div>;
}
