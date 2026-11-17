import { FormEvent, useState } from 'react';
import { Button } from '../../components/ui';
import { normalizeSmsCode } from './provisioning.labels';

/** `onSubmit` devolve `true` quando o código foi aceito pela API (o campo é limpo). */
type Props = { onSubmit: (code: string) => Promise<boolean>; disabled?: boolean };

/** Código SMS de 6 dígitos; aceita colar "123456", "123-456" ou "123 456". */
export function SmsCodeInput({ onSubmit, disabled = false }: Props) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (code.length !== 6 || busy) return;
    setBusy(true);
    try { if (await onSubmit(code)) setCode(''); } finally { setBusy(false); }
  };

  return <form className="provisioning-sms-form" onSubmit={(event) => void submit(event)}>
    <label>
      <span>Código SMS</span>
      <input
        aria-label="Código SMS"
        className="provisioning-sms-input"
        value={code.length > 3 ? `${code.slice(0, 3)}-${code.slice(3)}` : code}
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="000-000"
        maxLength={11}
        disabled={disabled || busy}
        onChange={(event) => setCode(normalizeSmsCode(event.target.value))}
        onPaste={(event) => { event.preventDefault(); setCode(normalizeSmsCode(event.clipboardData.getData('text'))); }}
        autoFocus
      />
    </label>
    <Button type="submit" icon="check" disabled={disabled || busy || code.length !== 6}>{busy ? 'Enviando…' : 'Enviar código'}</Button>
  </form>;
}
