import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Icon } from '../../components/ui';

export type DialogOptions = {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** Pede um texto: o diálogo devolve o texto em vez de `true`. */
  input?: { label: string; initial?: string; mustEqual?: string; maxLength?: number };
};

type Pending = DialogOptions & { resolve: (value: string | boolean | null) => void };

/**
 * Confirmação e pergunta no lugar de `window.confirm` / `window.prompt`, com o visual do app:
 * `const ok = await ask({...})` devolve `true` (ou o texto digitado, com `input`) e `null` se a
 * pessoa cancelar. Com `input.mustEqual`, o botão só libera quando o texto digitado bate.
 */
export function useDialog(): [ReactNode, (options: DialogOptions) => Promise<string | boolean | null>] {
  const [pending, setPending] = useState<Pending | null>(null);
  const ask = useCallback((options: DialogOptions) => new Promise<string | boolean | null>((resolve) => setPending({ ...options, resolve })), []);
  const close = (value: string | boolean | null) => { pending?.resolve(value); setPending(null); };
  return [pending ? <Dialog key={pending.title} options={pending} onClose={close} /> : null, ask];
}

function Dialog({ options, onClose }: { options: DialogOptions; onClose: (value: string | boolean | null) => void }) {
  const [text, setText] = useState(options.input?.initial ?? '');
  const field = useRef<HTMLInputElement>(null);
  const confirmButton = useRef<HTMLDivElement>(null);
  const { input } = options;
  const value = text.trim();
  const ready = !input || (input.mustEqual !== undefined ? value === input.mustEqual : value.length > 0);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    // Só ao abrir: foco no campo (texto selecionado) ou no botão principal.
    if (field.current) field.current.select();
    else confirmButton.current?.querySelector('button')?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closeRef.current(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const submit = () => { if (ready) onClose(input ? value : true); };

  return <div className="modal-backdrop" onClick={() => onClose(null)}>
    <div className="modal-card provisioning-dialog" role="dialog" aria-modal="true" aria-labelledby="provisioning-dialog-title" onClick={(event) => event.stopPropagation()}>
      <button className="modal-close" onClick={() => onClose(null)} aria-label="Fechar"><Icon name="close" /></button>
      <h2 id="provisioning-dialog-title">{options.title}</h2>
      <div className="provisioning-dialog-body">{options.body}</div>
      {input && <label className="field">
        <span>{input.label}</span>
        <input ref={field} value={text} maxLength={input.maxLength ?? 60} onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') submit(); }} autoComplete="off" />
      </label>}
      <div className="provisioning-inline-actions" ref={confirmButton}>
        <Button variant={options.danger ? 'danger' : 'primary'} onClick={submit} disabled={!ready}>{options.confirmLabel}</Button>
        <Button variant="ghost" onClick={() => onClose(null)}>Voltar</Button>
      </div>
    </div>
  </div>;
}
