const connectedStatuses = new Set(['connected', 'online', 'ready', 'authenticated', 'logged_in']);

const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '');

export const normalizeWaxumStatus = (payload: any) => {
  const session = payload?.session ?? {};
  const rawStatus = String(payload?.status ?? session?.status ?? '').toLowerCase();
  const connected = Boolean(payload?.is_logged_in ?? session?.is_logged_in)
    || connectedStatuses.has(rawStatus);
  const phone = digits(payload?.phone_number ?? session?.phone_number) || null;

  return {
    connected,
    phone,
    status: connected ? 'connected' : rawStatus || 'disconnected',
  };
};

