// Formatos da API pública de provisioning (docs/provisioning-contract.md, seções 1 e 3).

export type ProvisioningApp = 'whatsapp' | 'business';

/** register = cadastro completo; network_check = só liga o phone e confere a internet (IP do PC). */
export type JobMode = 'register' | 'network_check';

export type JobStatus = 'running' | 'waiting_input' | 'done' | 'failed' | 'cancelled';

export type JobAwaiting = null | 'sms' | 'profile' | 'link_decision' | 'pair_code';

export type JobStep =
  | 'queued' | 'checking_tunnel' | 'setting_network' | 'starting_phone' | 'connecting_adb' | 'checking_network'
  | 'installing_app' | 'opening_app' | 'entering_number' | 'waiting_sms' | 'verifying'
  | 'waiting_profile' | 'saving_profile' | 'registered' | 'creating_line' | 'opening_link_screen'
  | 'waiting_pair_code' | 'entering_pair_code' | 'linking' | 'network_ok' | 'done' | 'failed' | 'cancelled';

export type JobErrorCode =
  | 'egress_offline' | 'egress_mismatch' | 'no_internet' | 'phone_start_failed' | 'adb_failed'
  | 'install_failed' | 'unknown_screen' | 'number_banned' | 'sms_rejected' | 'timeout'
  | 'pair_failed' | 'link_timeout' | 'worker_lost' | 'cancelled' | 'internal';

/** PC de atendente usado como saída (docs/provisioning-contract.md, seção 4). */
export type EgressNode = {
  /** Id do PC (estável; a vaga edge-N pode mudar). */
  node: string;
  /** Pessoa ligada ao PC, ou o nome do PC. */
  label: string;
  /** Nome do PC em Admin → Saídas de internet. */
  pcName?: string;
  online: boolean;
  /** Vazio: o IP do PC é descoberto pelo worker no início do cadastro. */
  publicIps: string[];
  userId: string | null;
  userName: string | null;
  isMine: boolean;
};

export type EgressList = { items: EgressNode[]; configured: boolean };

export type PhoneStatus = 'on' | 'starting' | 'off' | 'expired' | 'unknown';

export type Phone = {
  id: string;
  name: string;
  status: PhoneStatus;
  android: string;
  proxy: string | null;
  apps: { whatsapp: boolean | null; business: boolean | null };
  busyJobId: string | null;
};

export type JobHistoryEntry = { step: JobStep | string; at: string; message: string | null };

export type Job = {
  id: string;
  egressNode: string;
  geelarkPhoneId: string;
  phoneName: string | null;
  /** Ausente nas respostas antigas = register. */
  mode?: JobMode;
  /** null no teste de internet. */
  app: ProvisioningApp | null;
  /** Número completo (país + número), só dígitos; null no teste de internet. */
  number: string | null;
  status: JobStatus;
  step: JobStep | string;
  awaiting: JobAwaiting;
  message: string | null;
  errorCode: JobErrorCode | string | null;
  hasScreenshot: boolean;
  egressIp: string | null;
  history: JobHistoryEntry[];
  linked: boolean;
  numberId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateJob = {
  egressNode: string;
  geelarkPhoneId: string;
  mode?: JobMode;
  app?: ProvisioningApp;
  countryCode?: string;
  number?: string;
  powerOffWhenDone?: boolean;
};

/** Android 10 fica de fora: o GeeLark não libera ADB nele. */
export const ANDROID_VERSIONS = ['Android 12', 'Android 13', 'Android 14', 'Android 15', 'Android 16', 'Android 11'] as const;
export type AndroidVersion = typeof ANDROID_VERSIONS[number];

/** O phone nasce saindo pela internet do PC escolhido no passo de Rede. */
export type CreatePhone = { name: string; androidVersion: AndroidVersion; egressNode: string };

/** Valores para reabrir o assistente já preenchido ("Tentar de novo"). */
export type WizardPrefill = Partial<{ egressNode: string; phoneId: string; app: ProvisioningApp; countryCode: string; number: string }>;
