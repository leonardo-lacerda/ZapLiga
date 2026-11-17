import { KeyboardEvent, useState } from 'react';
import { Button, Icon } from '../../components/ui';
import { ANDROID_VERSIONS, type AndroidVersion } from './provisioning.types';

export type NewPhoneInput = { name: string; androidVersion: AndroidVersion; testNetwork: boolean };

type Props = {
  defaultName: string;
  /** Nome do PC escolhido no passo de Rede: o phone já nasce saindo pela internet dele. */
  pcLabel: string;
  onSubmit: (input: NewPhoneInput) => Promise<boolean>;
  onCancel: () => void;
};

/** Cria um cloud phone no GeeLark sem sair do ZapLiga, já com a rede do PC escolhido. */
export function NewPhoneForm({ defaultName, pcLabel, onSubmit, onCancel }: Props) {
  const [name, setName] = useState(defaultName);
  const [androidVersion, setAndroidVersion] = useState<AndroidVersion>('Android 12');
  const [testNetwork, setTestNetwork] = useState(true);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try { await onSubmit({ name: name.trim(), androidVersion, testNetwork }); } finally { setBusy(false); }
  };

  // Fica dentro do <form> do assistente: não pode ser outro <form>, e o Enter aqui cria o phone em vez de avançar o passo.
  const onEnter = (event: KeyboardEvent) => { if (event.key === 'Enter') { event.preventDefault(); void submit(); } };

  return <div className="provisioning-new-phone" role="group" aria-label="Novo telefone">
    <h3>Novo telefone no GeeLark</h3>
    <div className="provisioning-new-phone-fields">
      <label className="field"><span>Nome</span><input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} onKeyDown={onEnter} /></label>
      <label className="field"><span>Sistema</span>
        <select value={androidVersion} onChange={(event) => setAndroidVersion(event.target.value as AndroidVersion)}>
          {ANDROID_VERSIONS.map((version) => <option key={version} value={version}>{version}</option>)}
        </select>
      </label>
    </div>
    <p className="form-hint"><Icon name="activity" size={14} /> Internet: sai pelo <strong>{pcLabel}</strong> desde o primeiro boot. O GeeLark testa essa conexão antes de criar o telefone.</p>
    <label className="provisioning-switch">
      <input type="checkbox" role="switch" checked={testNetwork} onChange={(event) => setTestNetwork(event.target.checked)} />
      <span>Testar a internet logo depois (liga o telefone por uns 2 minutos e confere o IP lá dentro)</span>
    </label>
    <p className="form-hint">O telefone é criado desligado. A cobrança é por minuto, só enquanto ele estiver ligado.</p>
    <div className="provisioning-inline-actions">
      <Button type="button" icon="plus" onClick={() => void submit()} disabled={busy || !name.trim()}>{busy ? 'Criando no GeeLark…' : 'Criar telefone'}</Button>
      <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>Cancelar</Button>
    </div>
  </div>;
}
