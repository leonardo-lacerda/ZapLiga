import { ApiError, apiFetch, json, refreshAccessToken } from '../../services/api';
import type { CreateJob, EgressList, EgressNode, Job, Phone } from './provisioning.types';

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
