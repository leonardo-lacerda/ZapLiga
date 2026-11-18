import { useEffect, useRef, useState } from 'react';
import { fetchLiveScreen } from './provisioning.api';
import { createObjectUrl, revokeObjectUrl } from './objectUrl';

export const LIVE_SCREEN_REFRESH_MS = 4_000;

type Props = { tenantId: string; jobId: string; refreshMs?: number };

/** Print da tela do phone a cada poucos segundos, enquanto o robô trabalha (só para olhar). */
export function LiveScreen({ tenantId, jobId, refreshMs = LIVE_SCREEN_REFRESH_MS }: Props) {
  const [url, setUrl] = useState('');
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const current = useRef('');

  useEffect(() => {
    let closed = false;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const blob = await fetchLiveScreen(tenantId, jobId);
        if (closed) return;
        const next = createObjectUrl(blob);
        revokeObjectUrl(current.current);
        current.current = next;
        setUrl(next);
        setUpdatedAt(new Date());
        setUnavailable(false);
      } catch {
        // 404 antes de o robô conectar ao phone (ou depois de desligar): só avisa.
        if (!closed) setUnavailable(true);
      } finally { inFlight = false; }
    };
    void load();
    const timer = window.setInterval(() => void load(), refreshMs);
    return () => { closed = true; window.clearInterval(timer); revokeObjectUrl(current.current); current.current = ''; };
  }, [tenantId, jobId, refreshMs]);

  return <figure className="provisioning-screenshot provisioning-live-screen">
    {url
      ? <img src={url} alt="Tela do phone agora" />
      : <div className="provisioning-live-placeholder">{unavailable ? 'A tela aparece quando o robô conectar ao phone.' : 'Carregando a tela do phone…'}</div>}
    <figcaption>{updatedAt
      ? `Tela do phone ao vivo · atualizada às ${updatedAt.toLocaleTimeString('pt-BR')}${unavailable ? ' (sem atualização agora)' : ''}`
      : 'Tela do phone ao vivo'}</figcaption>
  </figure>;
}
