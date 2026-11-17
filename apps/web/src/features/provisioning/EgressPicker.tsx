import { Badge, Button, EmptyState, Icon } from '../../components/ui';
import { EGRESS_NOT_CONFIGURED } from './provisioning.labels';
import type { EgressList, EgressNode } from './provisioning.types';

type Props = {
  egress: EgressList | null;
  loading: boolean;
  error: string;
  selected: string;
  onSelect: (node: string) => void;
  onRefresh: () => void;
};

/** Segunda linha do cartão: o PC quando o rótulo é a pessoa, e os IPs só quando a API os informa. */
const detailOf = (node: EgressNode) => {
  const parts: string[] = [];
  if (node.pcName && node.pcName !== node.label) parts.push(node.pcName);
  if (node.publicIps.length) parts.push(node.publicIps.join(' · '));
  return parts.join(' · ');
};

/** Passo 0: PC do atendente pelo qual o phone sai para a internet (o IP do cadastro é o desse PC). */
export function EgressPicker({ egress, loading, error, selected, onSelect, onRefresh }: Props) {
  if (loading && !egress) return <p className="subtle">Carregando os PCs dos atendentes…</p>;
  if (error && !egress) return <div className="alert" role="alert"><Icon name="alert" size={17} /><span>{error}</span><Button variant="ghost" icon="refresh" onClick={onRefresh}>Tentar de novo</Button></div>;
  if (!egress) return null;
  if (!egress.configured) {
    return <div className="alert" role="alert"><Icon name="lock" size={17} /><span><strong>{EGRESS_NOT_CONFIGURED}</strong> Sem isso o cadastro não pode começar. Peça ao administrador da plataforma para conectar a Tailscale em Admin → Saídas de internet e definir o proxy do cadastro no servidor.</span></div>;
  }

  const mine = egress.items.filter((node) => node.isMine);
  const mineOnline = mine.some((node) => node.online);
  const anyOnline = egress.items.some((node) => node.online);

  return <div className="provisioning-step-body">
    {mine.length > 0 && !mineOnline && <div className="alert alert-warning" role="status"><Icon name="alert" size={17} /><span><strong>Seu PC não está online.</strong> Ligue-o (com a Tailscale conectada) e clique em Atualizar, ou escolha o PC de outra pessoa que esteja online.</span></div>}
    {!mine.length && egress.items.length > 0 && <p className="form-hint">Nenhum PC está ligado a você. Escolha um PC online da operação.</p>}
    {egress.items.length > 0 && !anyOnline && <div className="alert" role="alert"><Icon name="alert" size={17} /><span>Nenhum PC está online agora. Sem um PC online o cadastro não começa.</span></div>}
    <div className="choice-list" role="radiogroup" aria-label="PCs dos atendentes">
      {egress.items.map((node) => {
        const isSelected = selected === node.node;
        const detail = detailOf(node);
        return <button
          type="button"
          role="radio"
          aria-checked={isSelected}
          key={node.node}
          className={`choice-card${isSelected ? ' is-selected' : ''}${node.online ? '' : ' is-disabled'}`}
          disabled={!node.online}
          onClick={() => onSelect(node.node)}
        >
          <span className="pick-icon"><Icon name="activity" size={15} /></span>
          <span className="pick-copy">
            <strong>{node.label}{node.isMine && <> <Badge tone="purple">você</Badge></>}</strong>
            {detail && <small>{detail}</small>}
          </span>
          {node.online ? <span className="choice-radio" /> : <Badge>offline</Badge>}
        </button>;
      })}
      {!egress.items.length && <EmptyState title="Nenhum PC de atendente com vaga de saída" description="Instale a saída num PC em Admin → Saídas de internet e clique em Atualizar." />}
    </div>
    <div className="provisioning-inline-actions"><Button type="button" variant="ghost" icon="refresh" onClick={onRefresh} disabled={loading}>{loading ? 'Atualizando…' : 'Atualizar'}</Button></div>
  </div>;
}
