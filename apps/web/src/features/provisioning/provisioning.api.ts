import { ApiError, apiFetch, json, refreshAccessToken } from '../../services/api';
import type { CreateJob, CreatePhone, EgressList, EgressNode, Job, Phone, ProvisioningStats } from './provisioning.types';

const base = (tenantId: string) => `/api/tenants/${encodeURIComponent(tenantId)}/provisioning`;
const jobPath = (tenantId: string, jobId: string) => `${base(tenantId)}/jobs/${encodeURIComponent(jobId)}`;

export const fetchEgressNodes = async (tenantId: string): Promise<EgressList> => {
  const body = await json(`${base(tenantId)}/egress`);
  return { items: Array.isArray(body?.items) ? body.items : [], configured: body?.configured !== false };
};

/** Liga o PC a uma pessoa (null desliga); devolve o PC já com `isMine` calculado para quem chamou. */
export const assignEgressNode = (tenantId: string, node: string, userId: string | null): Promise<EgressNode> =>
  json(`${base(tenantId)}/egress/${encodeURIComponent(node)}`, { method: 'PUT', body: JSON.stringify({ userId }) });

export const fetchPhones = async (tenantId: string): Promise<Phone[]> => {
  const body = await json(`${base(tenantId)}/phones`);
  return Array.isArray(body?.items) ? body.items : [];
};

/** Cria o cloud phone no GeeLark (desligado) já saindo pelo PC; o GeeLark testa essa internet antes de criar. */
export const createPhone = (tenantId: string, input: CreatePhone): Promise<Phone> =>
  json(`${base(tenantId)}/phones`, { method: 'POST', body: JSON.stringify(input) });

/** Desliga o phone no GeeLark; se houver um cadastro nele, o worker cancela antes. */
export const stopPhone = (tenantId: string, phoneId: string): Promise<Phone> =>
  json(`${base(tenantId)}/phones/${encodeURIComponent(phoneId)}/stop`, { method: 'POST' });

const phonePath = (tenantId: string, phoneId: string) => `${base(tenantId)}/phones/${encodeURIComponent(phoneId)}`;

export const renamePhone = (tenantId: string, phoneId: string, name: string): Promise<Phone> =>
  json(`${phonePath(tenantId, phoneId)}/rename`, { method: 'POST', body: JSON.stringify({ name }) });

/** "Aparelho novo": outra marca, modelo e número do SIM (o WhatsApp do telefone é apagado). */
export const newDevicePhone = (tenantId: string, phoneId: string): Promise<Phone> =>
  json(`${phonePath(tenantId, phoneId)}/new-device`, { method: 'POST' });

export const deletePhone = (tenantId: string, phoneId: string): Promise<{ ok: boolean }> =>
  json(phonePath(tenantId, phoneId), { method: 'DELETE' });

export const createJob = (tenantId: string, input: CreateJob): Promise<Job> =>
  json(`${base(tenantId)}/jobs`, { method: 'POST', body: JSON.stringify(input) });

export const fetchRecentJobs = async (tenantId: string, limit = 10): Promise<Job[]> => {
  const body = await json(`${base(tenantId)}/jobs?limit=${limit}`);
  return Array.isArray(body?.items) ? body.items : [];
};

export const fetchJob = (tenantId: string, jobId: string): Promise<Job> => json(jobPath(tenantId, jobId));

export const submitSmsCode = (tenantId: string, jobId: string, code: string): Promise<Job> =>
  json(`${jobPath(tenantId, jobId)}/sms`, { method: 'POST', body: JSON.stringify({ code }) });

export const submitProfile = (tenantId: string, jobId: string, input: { name: string; photo?: File | null }): Promise<Job> => {
  const form = new FormData();
  form.append('name', input.name);
  if (input.photo) form.append('photo', input.photo, input.photo.name);
  // Sem content-type manual: o navegador define o boundary do multipart.
  return json(`${jobPath(tenantId, jobId)}/profile`, { method: 'POST', body: form });
};

export const submitLinkDecision = (tenantId: string, jobId: string, connect: boolean): Promise<Job> =>
  json(`${jobPath(tenantId, jobId)}/link`, { method: 'POST', body: JSON.stringify({ connect }) });

export const cancelJob = (tenantId: string, jobId: string): Promise<Job> =>
  json(`${jobPath(tenantId, jobId)}/cancel`, { method: 'POST' });

/** "Reenviar SMS" (sms) ou "Receber por ligação" (voice), só enquanto o cadastro espera o SMS. */
export const requestNewCode = (tenantId: string, jobId: string, method: 'sms' | 'voice'): Promise<Job> =>
  json(`${jobPath(tenantId, jobId)}/resend`, { method: 'POST', body: JSON.stringify({ method }) });

/** Toque do operador na tela ao vivo: x/y em proporção (0 a 1) da imagem. */
export type ManualAction =
  | { type: 'tap'; x: number; y: number }
  | { type: 'key'; key: 'back' | 'home' | 'scroll_up' | 'scroll_down' }
  | { type: 'text'; text: string };

/** Só funciona com o robô parado esperando alguém; senão a API responde 409 (robot_busy). */
export const sendManualAction = (tenantId: string, jobId: string, action: ManualAction): Promise<{ ok: boolean }> =>
  json(`${jobPath(tenantId, jobId)}/manual`, { method: 'POST', body: JSON.stringify(action) });

/** "Assumir o controle": o robô para na próxima tela e espera você mexer no phone. */
export const takeOverJob = (tenantId: string, jobId: string): Promise<Job> =>
  json(`${jobPath(tenantId, jobId)}/takeover`, { method: 'POST' });

/** "Devolver ao robô" depois de mexer no phone numa tela que ele não conhece. */
export const resumeRobot = (tenantId: string, jobId: string): Promise<Job> =>
  json(`${jobPath(tenantId, jobId)}/resume`, { method: 'POST' });

/** Tela do phone agora (image/png), enquanto o job roda. */
export const fetchLiveScreen = async (tenantId: string, jobId: string, signal?: AbortSignal): Promise<Blob> => {
  const path = `${jobPath(tenantId, jobId)}/screen`;
  let response = await apiFetch(path, { signal });
  if (response.status === 401 && await refreshAccessToken()) response = await apiFetch(path, { signal });
  if (!response.ok) throw new ApiError(response.status, {});
  return response.blob();
};

/** Print da tela do phone (image/png), buscado com a autenticação do app. */
export const fetchJobScreenshot = async (tenantId: string, jobId: string, signal?: AbortSignal): Promise<Blob> => {
  const path = `${jobPath(tenantId, jobId)}/screenshot`;
  let response = await apiFetch(path, { signal });
  if (response.status === 401 && await refreshAccessToken()) response = await apiFetch(path, { signal });
  if (!response.ok) throw new ApiError(response.status, {});
  return response.blob();
};

/** Código de erro de uma resposta da API (`{ code }`, `{ message: { code } }` ou `{ error }`). */
export const apiErrorCode = (error: unknown): string | undefined => {
  if (!(error instanceof ApiError)) return undefined;
  if (error.code) return error.code;
  const details = error.details as { error?: unknown } | undefined;
  return typeof details?.error === 'string' ? details.error : undefined;
};

/** Números dos cadastros terminados nos últimos `days` dias. */
export const fetchStats = (tenantId: string, days = 30): Promise<ProvisioningStats> =>
  json(`${base(tenantId)}/stats?days=${days}`);
