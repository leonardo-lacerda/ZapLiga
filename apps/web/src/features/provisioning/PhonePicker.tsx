import { Badge, Button, EmptyState, Icon } from '../../components/ui';
import { phoneStatusLabels } from './provisioning.labels';
import type { Phone } from './provisioning.types';

type Props = {
  phones: Phone[] | null;
  loading: boolean;
  error: string;
  selected: string;
  onSelect: (phoneId: string) => void;
  onRefresh: () => void;
};

const statusTone: Record<string, string> = { on: 'success', starting: 'info', off: 'neutral', expired: 'error', unknown: 'neutral' };

const appState = (installed: boolean | null) => installed === true ? 'instalado' : installed === false ? 'não instalado' : 'desconhecido';

/** Passo 1: cloud phones do GeeLark. Phone ocupado por outro cadastro (ou expirado) não pode ser escolhido. */
export function PhonePicker({ phones, loading, error, selected, onSelect, onRefresh }: Props) {
  if (loading && !phones) return <p className="subtle">Carregando os phones do GeeLark…</p>;
  if (error && !phones) return <div className="alert" role="alert"><Icon name="alert" size={17} /><span>{error}</span><Button variant="ghost" icon="refresh" onClick={onRefresh}>Tentar de novo</Button></div>;
  if (!phones) return null;

  return <div className="provisioning-step-body">
    <div className="provisioning-phone-grid" role="radiogroup" aria-label="Cloud phones do GeeLark">
      {phones.map((phone) => {
        const busy = Boolean(phone.busyJobId);
        const expired = phone.status === 'expired';
        const isSelected = selected === phone.id;
        return <button
          type="button"
          role="radio"
          aria-checked={isSelected}
          key={phone.id}
          className={`provisioning-phone-card${isSelected ? ' is-selected' : ''}`}
          disabled={busy || expired}
          onClick={() => onSelect(phone.id)}
        >
          <span className="provisioning-phone-head">
            <strong>{phone.name}</strong>
            <Badge tone={statusTone[phone.status] ?? 'neutral'}>{phoneStatusLabels[phone.status] ?? phone.status}</Badge>
          </span>
          <small>{phone.android || 'Android —'}</small>
          <small>Rede: {phone.proxy || 'sem proxy configurado'}</small>
          <small>WhatsApp: {appState(phone.apps?.whatsapp ?? null)} · Business: {appState(phone.apps?.business ?? null)}</small>
          {busy && <span className="provisioning-phone-busy"><Icon name="clock" size={12} /> Em uso por outro cadastro</span>}
          {expired && !busy && <span className="provisioning-phone-busy"><Icon name="alert" size={12} /> Phone expirado no GeeLark</span>}
        </button>;
      })}
      {!phones.length && <div className="full-span"><EmptyState title="Nenhum cloud phone encontrado" description="Crie um phone no GeeLark e clique em Atualizar." /></div>}
    </div>
    <div className="provisioning-inline-actions"><Button type="button" variant="ghost" icon="refresh" onClick={onRefresh} disabled={loading}>{loading ? 'Atualizando…' : 'Atualizar'}</Button></div>
  </div>;
}
