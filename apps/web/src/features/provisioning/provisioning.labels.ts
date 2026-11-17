import type { Job, JobStatus, PhoneStatus, ProvisioningApp } from './provisioning.types';

export const stepLabels: Record<string, string> = {
  queued: 'Na fila, aguardando um phone livre',
  checking_tunnel: 'Conferindo a saída pelo PC',
  setting_network: 'Configurando a rede do phone',
  starting_phone: 'Ligando o phone',
  connecting_adb: 'Conectando ao phone',
  checking_network: 'Conferindo o IP de saída',
  installing_app: 'Instalando o app',
  opening_app: 'Abrindo o app',
  entering_number: 'Digitando o número',
  waiting_sms: 'Aguardando o código SMS',
  verifying: 'Verificando o código',
  waiting_profile: 'Aguardando nome e foto',
  saving_profile: 'Salvando o perfil',
  registered: 'Número registrado no WhatsApp',
  creating_line: 'Criando a linha no ZapLiga',
  opening_link_screen: 'Abrindo a tela de aparelhos conectados',
  waiting_pair_code: 'Gerando o código de conexão',
  entering_pair_code: 'Digitando o código de conexão',
  linking: 'Conectando ao ZapLiga',
  network_ok: 'Internet conferida',
  done: 'Concluído',
  failed: 'Falhou',
  cancelled: 'Cancelado',
};

export const stepLabel = (step: string | null | undefined) => (step ? stepLabels[step] ?? step : '—');

export const isNetworkCheck = (job: Pick<Job, 'mode'>) => job.mode === 'network_check';

/** Título do job nas listas: o número do cadastro, ou "Teste de internet". */
export const jobTitle = (job: Pick<Job, 'mode' | 'number'>) => (isNetworkCheck(job) ? 'Teste de internet' : formatPhone(job.number));

export const statusLabels: Record<JobStatus, string> = {
  running: 'Em andamento',
  waiting_input: 'Aguardando você',
  done: 'Concluído',
  failed: 'Falhou',
  cancelled: 'Cancelado',
};

export const statusTone: Record<JobStatus, string> = {
  running: 'info',
  waiting_input: 'warning',
  done: 'success',
  failed: 'error',
  cancelled: 'neutral',
};

export const phoneStatusLabels: Record<PhoneStatus, string> = {
  on: 'Ligado',
  starting: 'Ligando',
  off: 'Desligado',
  expired: 'Expirado',
  unknown: 'Desconhecido',
};

export const appLabels: Record<ProvisioningApp, string> = { whatsapp: 'WhatsApp', business: 'WhatsApp Business' };

/** Explicação em português para cada `errorCode` do contrato. */
export const errorExplanations: Record<string, { title: string; hint: string }> = {
  egress_offline: { title: 'O PC de saída ficou offline', hint: 'Não foi possível sair para a internet pelo PC escolhido. Confira se ele está ligado e com a Tailscale conectada e tente de novo.' },
  egress_mismatch: { title: 'O IP do phone não bate com o do PC escolhido', hint: 'Por segurança o WhatsApp não foi aberto. Confira a saída do PC escolhido em Admin → Saídas de internet e tente de novo.' },
  no_internet: { title: 'O phone ficou sem internet', hint: 'O phone não conseguiu acessar a internet pelo PC escolhido. Confira a saída e tente de novo.' },
  phone_start_failed: { title: 'O phone não ligou', hint: 'O GeeLark não conseguiu ligar este cloud phone. Tente de novo ou escolha outro phone.' },
  adb_failed: { title: 'Não foi possível controlar o phone', hint: 'A conexão de controle (ADB) com o phone falhou. Tente de novo em alguns minutos.' },
  install_failed: { title: 'O app não foi instalado', hint: 'A instalação do WhatsApp no phone falhou. Tente de novo ou instale o app pelo GeeLark.' },
  unknown_screen: { title: 'Apareceu uma tela que o robô não conhece', hint: 'O WhatsApp mostrou uma tela inesperada. Veja o print abaixo; pode ser preciso ajustar o robô.' },
  number_banned: { title: 'O WhatsApp recusou este número', hint: 'O número parece estar banido ou bloqueado para cadastro. Use outro número.' },
  sms_rejected: { title: 'O WhatsApp não aceitou o código SMS', hint: 'O código foi recusado várias vezes ou expirou. Peça um novo SMS e tente de novo.' },
  timeout: { title: 'O cadastro demorou demais', hint: 'Uma etapa passou do tempo limite (ou ninguém respondeu a tempo). Tente de novo.' },
  pair_failed: { title: 'Não foi possível gerar o código de conexão', hint: 'O número foi registrado, mas a conexão por código falhou. Conecte pelo QR Code em Números.' },
  link_timeout: { title: 'A conexão com o ZapLiga não terminou a tempo', hint: 'O número foi registrado e a linha foi criada em Números. Conecte por lá usando o QR Code.' },
  worker_lost: { title: 'O serviço de cadastro reiniciou', hint: 'O processo foi interrompido no meio e o phone foi desligado. Tente de novo.' },
  cancelled: { title: 'Cadastro cancelado', hint: 'O processo foi interrompido e o phone foi desligado.' },
  internal: { title: 'Erro interno no cadastro', hint: 'Algo deu errado do nosso lado. Tente de novo; se repetir, avise o suporte.' },
};

export const errorExplanation = (code: string | null | undefined) =>
  (code && errorExplanations[code]) || { title: 'O cadastro não foi concluído', hint: 'Tente de novo. Se o erro se repetir, avise o suporte.' };

export const EGRESS_NOT_CONFIGURED = 'A saída pelos PCs dos atendentes ou o proxy do cadastro não estão configurados no servidor.';

/** Mensagens para os erros de `POST jobs` (antes de o job existir). */
export const createErrorMessages: Record<string, string> = {
  egress_offline: 'O PC escolhido ficou offline. Escolha outro PC online.',
  egress_not_configured: EGRESS_NOT_CONFIGURED,
  phone_busy: 'Este phone já está em outro cadastro. Escolha outro phone.',
  worker_full: 'Já há cadastros demais em andamento. Aguarde um terminar e tente de novo.',
};

export const isJobFinished = (job: Pick<Job, 'status'> | null | undefined) =>
  Boolean(job && (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled'));

export const isJobActive = (job: Pick<Job, 'status'> | null | undefined) =>
  Boolean(job && (job.status === 'running' || job.status === 'waiting_input'));

export const digitsOnly = (value: string) => value.replace(/\D/g, '');

/** Aceita "123456", "123-456", "123 456" (inclusive colado) e devolve até 6 dígitos. */
export const normalizeSmsCode = (value: string) => digitsOnly(value).slice(0, 6);

/** Divide o número completo do job em país + número (para exibir e para "Tentar de novo"). */
export const splitJobNumber = (full: string | null | undefined) => {
  const raw = digitsOnly(full ?? '');
  if (raw.startsWith('55') && (raw.length === 12 || raw.length === 13)) return { countryCode: '55', number: raw.slice(2) };
  return { countryCode: '', number: raw };
};

/** ("55", "11987654321") → "+55 11 98765-4321" (formato amigável só para exibição). */
export const formatPhoneParts = (countryCode: string, number: string) => {
  const cc = digitsOnly(countryCode);
  const local = digitsOnly(number);
  if (!local) return '—';
  const pretty = cc === '55' && (local.length === 10 || local.length === 11)
    ? `${local.slice(0, 2)} ${local.slice(2, -4)}-${local.slice(-4)}`
    : local;
  return cc ? `+${cc} ${pretty}` : pretty;
};

/** Número completo do job ("5511987654321") → "+55 11 98765-4321". */
export const formatPhone = (full: string | null | undefined) => {
  const { countryCode, number } = splitJobNumber(full);
  if (!number) return '—';
  return countryCode ? formatPhoneParts(countryCode, number) : `+${number}`;
};

/** Valida país + número antes de `POST jobs`. Devolve a mensagem de erro ou null. */
export const validatePhoneNumber = (countryCode: string, number: string): string | null => {
  const cc = digitsOnly(countryCode);
  const local = digitsOnly(number);
  if (!cc || cc.length > 3) return 'Informe o código do país (ex.: 55).';
  if (!local) return 'Informe o número.';
  if (cc === '55') {
    if (local.length > 11 && local.startsWith('55')) return 'Digite o número sem o código do país (+55).';
    if (local.length !== 10 && local.length !== 11) return 'Para o Brasil, informe DDD + número (10 ou 11 dígitos).';
  } else if (local.length < 4 || cc.length + local.length > 15) {
    return 'Número inválido para este país.';
  }
  return null;
};

export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

/** Foto de perfil: só JPEG/PNG até 2 MB. Devolve a mensagem de erro ou null. */
export const validateProfilePhoto = (file: File): string | null => {
  if (file.type !== 'image/jpeg' && file.type !== 'image/png') return 'A foto precisa ser JPEG ou PNG.';
  if (file.size > MAX_PHOTO_BYTES) return 'A foto precisa ter no máximo 2 MB.';
  return null;
};

/** Quem vê o recurso: flag `whatsapp_provisioning` ligada e papel leader/super_admin. */
export const canUseProvisioning = (input: { flags: Record<string, unknown> | null | undefined; role?: string | null; isSuperAdmin?: boolean }) =>
  Boolean(input.flags?.whatsapp_provisioning) && (Boolean(input.isSuperAdmin) || input.role === 'leader');

export const formatTime = (iso: string | null | undefined) => {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

export const formatDateTime = (iso: string | null | undefined) => {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};
