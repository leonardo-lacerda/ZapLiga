// New camouflage per line (docs/device-profile.md): chosen by the ZapLiga admin, line by line.
export const DEVICE_PROFILE_LABEL = 'Camuflagem da linha';
export const DEVICE_PROFILE_HINT = 'A nova camuflagem (#5) faz a linha entrar como o celular da Multilogin em que o número foi registrado. A troca só vale no próximo QR ou código; até lá a linha segue como está.';
export const DEVICE_PROFILE_OPTION_TODAY = 'Como está hoje';
export const DEVICE_PROFILE_OPTION_NEW = 'Nova camuflagem (#5)';
export const DEVICE_PROFILE_PHONE_LABEL = 'Celular da Multilogin';
export const DEVICE_PROFILE_PHONE_PLACEHOLDER = 'Escolha o celular do número';
export const DEVICE_PROFILE_CREATE_HINT = 'Só para números registrados num celular da Multilogin. A linha já nasce com a nova camuflagem.';
export const DEVICE_PROFILE_STATE_COPY: Record<string, { label: string; tone: string }> = {
  pending: { label: 'Vale no próximo pareamento', tone: 'warning' },
  active: { label: 'Ativa', tone: 'success' },
  leaving: { label: 'Ativa até o próximo pareamento', tone: 'warning' },
};
