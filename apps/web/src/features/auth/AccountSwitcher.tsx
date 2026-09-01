import { FormEvent, useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/ui';
import type { SavedAccount } from './AuthProvider';

type Props = {
  accounts: SavedAccount[];
  currentName?: string;
  currentTenantName?: string;
  busy?: boolean;
  hasActiveCall?: boolean;
  onSwitch: (accountId: string) => Promise<void>;
  onAdd: (email: string, password: string) => Promise<void>;
  onRemove: (accountId: string) => Promise<void>;
};

export function AccountSwitcher({ accounts, currentName, currentTenantName, busy = false, hasActiveCall = false, onSwitch, onAdd, onRemove }: Props) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const active = accounts.find((account) => account.current);

  useEffect(() => {
    const close = (event: MouseEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const run = async (action: () => Promise<void>) => {
    setWorking(true); setMessage('');
    try { await action(); setOpen(false); return true; } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); return false; } finally { setWorking(false); }
  };

  const switchAccount = (account: SavedAccount) => {
    if (account.current) return;
    if (hasActiveCall && !window.confirm('Há uma chamada ou pós-atendimento em andamento. Deseja trocar de conta mesmo assim?')) return;
    void run(() => onSwitch(account.id));
  };

  const submitAdd = async (event: FormEvent) => {
    event.preventDefault();
    const added = await run(() => onAdd(email, password));
    if (added) { setEmail(''); setPassword(''); setAdding(false); }
  };

  return <div className="account-switcher" ref={root}>
    <button className="workspace-switcher" type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen((value) => !value); setMessage(''); }} disabled={busy}>
      <span className="workspace-avatar">{(currentTenantName || currentName || 'Z').slice(0, 1).toUpperCase()}</span>
      <span className="workspace-switcher-copy"><strong>{currentTenantName || 'Minha operação'}</strong><small>{currentName || 'Conta ZapLiga'}</small></span>
      <Icon name="chevron" size={14} />
    </button>
    {open && <div className="account-switcher-menu" role="dialog" aria-label="Trocar conta">
      <div className="account-switcher-heading"><strong>Contas conectadas</strong><small>Troque sem fazer login novamente</small></div>
      <div className="account-list">
        {accounts.map((account) => <div className={`account-row${account.current ? ' current' : ''}`} key={account.id}>
          <button type="button" className="account-row-main" onClick={() => switchAccount(account)} disabled={working || account.current}>
            <span className="account-avatar">{account.name.slice(0, 1).toUpperCase()}</span>
            <span><strong>{account.name}</strong><small>{account.email}</small></span>
            {account.current && <span className="account-current"><Icon name="check" size={13} /> Atual</span>}
          </button>
          {!account.current && <button type="button" className="account-remove" aria-label={`Remover ${account.name}`} onClick={() => { if (window.confirm(`Remover ${account.name} deste navegador?`)) void run(() => onRemove(account.id)); }} disabled={working}><Icon name="close" size={14} /></button>}
        </div>)}
      </div>
      {message && <div className="account-switcher-message" role="alert">{message}</div>}
      {!adding ? <button type="button" className="account-switcher-action" onClick={() => { setAdding(true); setMessage(''); }} disabled={working}><Icon name="plus" size={15} /> Adicionar outra conta</button> : <form className="account-add-form" onSubmit={(event) => void submitAdd(event)}>
        <strong>Entrar uma vez</strong>
        <small>Use as credenciais da outra conta ZapLiga.</small>
        <input type="email" placeholder="E-mail" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required />
        <input type="password" placeholder="Senha" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        <div><button type="button" className="account-add-cancel" onClick={() => { setAdding(false); setMessage(''); }}>Cancelar</button><button type="submit" className="account-add-submit" disabled={working}>{working ? 'Validando…' : 'Adicionar conta'}</button></div>
      </form>}
      <small className="account-switcher-note">As contas ficam vinculadas somente a este navegador.</small>
    </div>}
  </div>;
}
