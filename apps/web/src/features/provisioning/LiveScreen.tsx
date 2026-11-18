import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { Button } from '../../components/ui';
import { fetchLiveScreen, sendManualAction, type ManualAction } from './provisioning.api';
import { createObjectUrl, revokeObjectUrl } from './objectUrl';

export const LIVE_SCREEN_REFRESH_MS = 4_000;

type Props = {
  tenantId: string;
  jobId: string;
  refreshMs?: number;
  /** O robô está parado esperando alguém: o operador pode tocar no phone pela imagem. */
  controllable?: boolean;
};

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Posição do clique em proporção da imagem (0 a 1): o phone converte para os pixels dele. */
export const tapPosition = (event: Pick<MouseEvent, 'clientX' | 'clientY'>, box: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>) => {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return { x: clamp((event.clientX - box.left) / box.width), y: clamp((event.clientY - box.top) / box.height) };
};

/** Print da tela do phone a cada poucos segundos; com `controllable`, clicar nele toca no phone. */
export function LiveScreen({ tenantId, jobId, refreshMs = LIVE_SCREEN_REFRESH_MS, controllable = false }: Props) {
  const [url, setUrl] = useState('');
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState('');
  const [text, setText] = useState('');
  const current = useRef('');
  const closed = useRef(false);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const blob = await fetchLiveScreen(tenantId, jobId);
      if (closed.current) return;
      const next = createObjectUrl(blob);
      revokeObjectUrl(current.current);
      current.current = next;
      setUrl(next);
      setUpdatedAt(new Date());
      setUnavailable(false);
    } catch {
      // 404 antes de o robô conectar ao phone (ou depois de desligar): só avisa.
      if (!closed.current) setUnavailable(true);
    } finally { inFlight.current = false; }
  }, [tenantId, jobId]);

  useEffect(() => {
    closed.current = false;
    void load();
    const timer = window.setInterval(() => void load(), refreshMs);
    return () => { closed.current = true; window.clearInterval(timer); revokeObjectUrl(current.current); current.current = ''; };
  }, [load, refreshMs]);

  const act = async (action: ManualAction) => {
    if (sending) return false;
    setSending(true);
    setActionError('');
    try {
      await sendManualAction(tenantId, jobId, action);
      inFlight.current = false; // o print novo tem de sair agora, mesmo com outro pedido no ar
      await load();
      return true;
    } catch (error) {
      if (!closed.current) setActionError(errorText(error));
      return false;
    } finally { if (!closed.current) setSending(false); }
  };

  const tap = (event: MouseEvent<HTMLButtonElement>) => {
    // Enter/Espaço também disparam click, mas sem posição: tocaria no canto da tela.
    if (event.detail === 0) return;
    const image = event.currentTarget.querySelector('img');
    if (!image) return;
    void act({ type: 'tap', ...tapPosition(event, image.getBoundingClientRect()) });
  };

  const typeText = async (event: FormEvent) => {
    event.preventDefault();
    if (!text) return;
    if (await act({ type: 'text', text })) setText('');
  };

  const image = url ? <img src={url} alt="Tela do phone agora" /> : null;
  return <figure className={`provisioning-screenshot provisioning-live-screen${controllable ? ' is-controllable' : ''}`}>
    {!image
      ? <div className="provisioning-live-placeholder">{unavailable ? 'A tela aparece quando o robô conectar ao phone.' : 'Carregando a tela do phone…'}</div>
      : controllable
        ? <button type="button" className="provisioning-live-touch" onClick={tap} disabled={sending} aria-label="Tocar na tela do phone (clique no ponto desejado)">{image}</button>
        : image}
    <figcaption>{updatedAt
      ? `Tela do phone ao vivo · atualizada às ${updatedAt.toLocaleTimeString('pt-BR')}${unavailable ? ' (sem atualização agora)' : ''}`
      : 'Tela do phone ao vivo'}</figcaption>
    {controllable && url && <div className="provisioning-live-controls">
      <span className="form-hint">{sending ? 'Enviando ao phone…' : 'Clique na tela para tocar no phone.'}</span>
      <div className="provisioning-inline-actions">
        <Button variant="secondary" onClick={() => void act({ type: 'key', key: 'back' })} disabled={sending}>Voltar no phone</Button>
        <Button variant="secondary" onClick={() => void act({ type: 'key', key: 'home' })} disabled={sending}>Tela inicial</Button>
        <Button variant="secondary" onClick={() => void act({ type: 'key', key: 'scroll_up' })} disabled={sending}>Rolar para cima</Button>
        <Button variant="secondary" onClick={() => void act({ type: 'key', key: 'scroll_down' })} disabled={sending}>Rolar para baixo</Button>
      </div>
      <form className="provisioning-live-text" onSubmit={(event) => void typeText(event)}>
        <input aria-label="Texto para digitar no phone" placeholder="Toque num campo do phone e digite aqui" value={text} maxLength={200} onChange={(event) => setText(event.target.value)} />
        <Button type="submit" variant="secondary" disabled={sending || !text}>Digitar</Button>
      </form>
      {actionError && <div className="alert" role="alert"><span>{actionError}</span></div>}
    </div>}
  </figure>;
}
