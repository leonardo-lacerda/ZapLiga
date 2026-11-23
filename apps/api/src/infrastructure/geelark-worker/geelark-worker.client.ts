import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

// Formats from docs/provisioning-contract.md section 2 (geelark-worker internal HTTP API).
export type WorkerApp = 'whatsapp' | 'business';
export type WorkerJobStatus = 'running' | 'waiting_input' | 'done' | 'failed' | 'cancelled';
export type WorkerAwaiting = null | 'sms' | 'profile' | 'link_decision' | 'pair_code' | 'manual';

export type WorkerPhone = {
  id: string; name: string; status: 'on' | 'starting' | 'off' | 'expired' | 'unknown';
  android: string;
  proxy: string | null;
  apps: { whatsapp: boolean | null; business: boolean | null };
  busyJobId: string | null;
};

export type WorkerProxy = { typeId: 1 | 2 | 3; server: string; port: number; username: string; password: string };
/** Internal address of the same proxy: the worker asks it for the egress IP before starting the phone. */
export type WorkerProbeProxy = { server: string; port: number; username: string; password: string };

export type WorkerJobMode = 'register' | 'network_check' | 'control';

export type CreateWorkerJob = {
  jobId: string;
  phoneId: string;
  /** network_check: proxy → start → ADB → IP check → power off; no app nor number. */
  mode?: WorkerJobMode;
  app?: WorkerApp;
  countryCode?: string;
  number?: string;
  proxy: WorkerProxy;
  probeProxy?: WorkerProbeProxy;
  /** Empty with `probeProxy`: the worker then expects the IP the probe saw. */
  expectedEgressIps: string[];
  /** IP -> reason: registrations never go out through these (daily limit, quarantine after a ban). */
  blockedEgressIps?: Record<string, string>;
  powerOffWhenDone: boolean;
  /** Clear the app's data before opening it, even with an active account (operator's choice). */
  resetApp?: boolean;
  /** Recreating a job the worker lost (restart): it carries on from where WhatsApp stopped. */
  resume?: boolean;
};

export type WorkerJobInput =
  | { type: 'sms'; code: string }
  | { type: 'resend_sms' }
  | { type: 'call_me' }
  | { type: 'profile'; name: string; photoBase64?: string; photoMime?: 'image/jpeg' | 'image/png' }
  | { type: 'link' }
  | { type: 'finish' }
  | { type: 'pair_code'; code: string }
  /** The operator finished driving the phone by hand: the robot goes on. */
  | { type: 'resume' };

/** Operator's touch on the live screen; x/y are fractions (0-1) of the screenshot. Text is never logged. */
export type WorkerManualAction =
  | { type: 'tap'; x: number; y: number }
  | { type: 'key'; key: 'back' | 'home' | 'scroll_up' | 'scroll_down' }
  | { type: 'text'; text: string };

export type CreateWorkerPhone = { name: string; androidVersion: string; proxy: WorkerProxy };

export type WorkerJob = {
  jobId: string; phoneId: string; mode?: WorkerJobMode; app: WorkerApp | null; number: string | null;
  status: WorkerJobStatus;
  step: string; awaiting: WorkerAwaiting;
  message: string | null; errorCode: string | null; hasScreenshot: boolean;
  egressIp: string | null;
  appVersion?: string | null;
  history: { step: string; at: string; message: string | null }[];
  createdAt: string; updatedAt: string;
};

export type WorkerScreenElement = {
  index: number; class: string; text: string; desc: string; id: string;
  clickable: boolean; scrollable: boolean; editable: boolean; bounds: [number, number, number, number]; blocked: boolean;
};
export type WorkerScreenElements = { width: number; height: number; elements: WorkerScreenElement[] };

/** HttpException carrying the worker's own error code (`phone_busy`, `not_found`...). */
export class GeelarkWorkerError extends HttpException {
  constructor(readonly workerCode: string, message: string, status: number) {
    super({ statusCode: status, code: workerCode, message }, status);
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Portuguese message shown to the operator for each worker error. */
const messageFor = (status: number, code: string, workerMessage: string | null) => {
  if (code === 'phone_busy') return 'Este telefone já está em outro cadastro. Aguarde ele terminar ou cancele-o.';
  if (code === 'worker_draining') return 'O cadastrador está sendo atualizado e terminando os cadastros em andamento. Tente novamente em alguns minutos.';
  if (code === 'worker_full') return 'O cadastrador já está com o máximo de cadastros simultâneos. Tente novamente em alguns minutos.';
  if (code === 'not_awaiting') return 'O cadastro não está aguardando essa informação agora. Atualize a página.';
  if ((code === 'robot_busy' || code === 'device_error') && workerMessage) return workerMessage;
  // The worker's own Portuguese text says what GeeLark refused (proxy check, balance...).
  if ((code === 'egress_offline' || code === 'geelark_error') && workerMessage) return workerMessage;
  // Phone actions (rename, new device, delete): the worker says what GeeLark refused.
  if (['geelark_busy', 'phone_on', 'daily_limit', 'not_supported'].includes(code) && workerMessage) return workerMessage;
  if (status === 404) return 'Cadastro ou telefone não encontrado no cadastrador.';
  if (status === 401 || status === 403) return 'O cadastrador recusou a autenticação da API. Verifique GEELARK_WORKER_TOKEN.';
  if (status === 400 || status === 422) return workerMessage ? `Dados recusados pelo cadastrador: ${workerMessage}` : 'Dados recusados pelo cadastrador.';
  return 'O cadastrador de WhatsApp está indisponível no momento. Tente novamente em instantes.';
};

/** Status the API answers with: worker 4xx keep their meaning, everything else is 502/503. */
const statusFor = (status: number) => {
  if ([400, 404, 409, 422, 429].includes(status)) return status === 422 ? HttpStatus.BAD_REQUEST : status;
  if (status === 401 || status === 403) return HttpStatus.BAD_GATEWAY;
  return HttpStatus.SERVICE_UNAVAILABLE;
};

/**
 * Typed client for the internal geelark-worker (no public port). Every route but
 * /health needs the `x-worker-token` header. Request bodies may carry the SMS or
 * pairing code: they are never logged and never copied into error messages.
 */
@Injectable()
export class GeelarkWorkerClient {
  private get baseUrl() { return (process.env.GEELARK_WORKER_URL?.trim() || 'http://geelark-worker:8080').replace(/\/$/, ''); }
  private get token() { return process.env.GEELARK_WORKER_TOKEN?.trim() ?? ''; }

  get configured() { return Boolean(this.token); }

  private async request(path: string, init: { method?: string; body?: unknown; timeoutMs?: number; auth?: boolean } = {}): Promise<Response> {
    if (init.auth !== false && !this.token) {
      throw new GeelarkWorkerError('worker_not_configured', 'O cadastrador de WhatsApp não está configurado (GEELARK_WORKER_TOKEN).', HttpStatus.SERVICE_UNAVAILABLE);
    }
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.auth === false ? {} : { 'x-worker-token': this.token }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = (error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError';
      throw new GeelarkWorkerError(timedOut ? 'worker_timeout' : 'worker_unreachable', timedOut ? 'O cadastrador demorou demais para responder. Tente novamente.' : messageFor(503, 'worker_unreachable', null), timedOut ? HttpStatus.GATEWAY_TIMEOUT : HttpStatus.SERVICE_UNAVAILABLE);
    }
    if (response.ok) return response;
    let code = `http_${response.status}`;
    let workerMessage: string | null = null;
    try {
      const body = await response.json() as { error?: unknown; message?: unknown };
      if (typeof body?.error === 'string' && body.error) code = body.error;
      if (typeof body?.message === 'string' && body.message) workerMessage = body.message.slice(0, 300);
    } catch { /* non-JSON error body */ }
    if (response.status === 404 && code === `http_404`) code = 'not_found';
    throw new GeelarkWorkerError(code, messageFor(response.status, code, workerMessage), statusFor(response.status));
  }

  private async json<T>(path: string, init: Parameters<GeelarkWorkerClient['request']>[1] = {}) {
    return (await (await this.request(path, init)).json()) as T;
  }

  async health() { return this.json<{ ok: boolean }>('/health', { auth: false, timeoutMs: 5_000 }); }

  async listPhones() { return (await this.json<{ items?: WorkerPhone[] }>('/phones', { timeoutMs: 30_000 })).items ?? []; }

  /** Creates a cloud phone (off) already behind the proxy; GeeLark tests the proxy first (409 egress_offline). */
  async createPhone(phone: CreateWorkerPhone) { return this.json<WorkerPhone>('/phones', { method: 'POST', body: phone, timeoutMs: 60_000 }); }

  async stopPhone(phoneId: string) { return this.json<{ ok: boolean }>(`/phones/${encodeURIComponent(phoneId)}/stop`, { method: 'POST', timeoutMs: 30_000 }); }

  async renamePhone(phoneId: string, name: string) { return this.json<{ ok: boolean; name: string }>(`/phones/${encodeURIComponent(phoneId)}/rename`, { method: 'POST', body: { name }, timeoutMs: 30_000 }); }

  /** "Aparelho novo": the worker powers the phone off first (up to 90 s), then GeeLark resets its identity. */
  async newDevice(phoneId: string) { return this.json<{ ok: boolean }>(`/phones/${encodeURIComponent(phoneId)}/new-device`, { method: 'POST', timeoutMs: 150_000 }); }

  async deletePhone(phoneId: string) { return this.json<{ ok: boolean }>(`/phones/${encodeURIComponent(phoneId)}`, { method: 'DELETE', timeoutMs: 150_000 }); }

  async createJob(job: CreateWorkerJob) { return this.json<WorkerJob>('/jobs', { method: 'POST', body: job, timeoutMs: 30_000 }); }

  /** `null` when the worker does not know the job (e.g. it restarted). */
  async getJob(jobId: string) {
    try {
      return await this.json<WorkerJob>(`/jobs/${encodeURIComponent(jobId)}`);
    } catch (error) {
      if (error instanceof GeelarkWorkerError && error.getStatus() === HttpStatus.NOT_FOUND) return null;
      throw error;
    }
  }

  async sendInput(jobId: string, input: WorkerJobInput) {
    return this.json<WorkerJob>(`/jobs/${encodeURIComponent(jobId)}/input`, { method: 'POST', body: input, timeoutMs: 30_000 });
  }

  /** "Assumir o controle": the robot stops at the next screen and waits (awaiting=manual). */
  async takeOver(jobId: string) { return this.json<WorkerJob>(`/jobs/${encodeURIComponent(jobId)}/takeover`, { method: 'POST', timeoutMs: 30_000 }); }

  async manualAction(jobId: string, action: WorkerManualAction) {
    return this.json<{ ok: boolean }>(`/jobs/${encodeURIComponent(jobId)}/manual`, { method: 'POST', body: action, timeoutMs: 30_000 });
  }

  /** Elements on the phone screen right now (text, id, bounds, blocked), or `null` without a live phone. */
  async screenElements(jobId: string) {
    try {
      return await this.json<WorkerScreenElements>(`/jobs/${encodeURIComponent(jobId)}/elements`, { timeoutMs: 20_000 });
    } catch (error) {
      if (error instanceof GeelarkWorkerError && error.getStatus() === HttpStatus.NOT_FOUND) return null;
      throw error;
    }
  }

  async cancelJob(jobId: string) { return this.json<WorkerJob>(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', timeoutMs: 30_000 }); }

  /**
   * The phone screen right now (short cache in the worker), or `null` when the job has no live phone.
   * PNG by default; `jpegWidth` asks for a reduced JPEG (the MCP sends it to Claude).
   */
  async liveScreen(jobId: string, jpegWidth?: number) {
    const query = jpegWidth ? `?format=jpeg&w=${Math.floor(jpegWidth)}` : '';
    try {
      const response = await this.request(`/jobs/${encodeURIComponent(jobId)}/screen${query}`, { timeoutMs: 20_000 });
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof GeelarkWorkerError && error.getStatus() === HttpStatus.NOT_FOUND) return null;
      throw error;
    }
  }

  /** PNG bytes of the last phone screen, or `null` when the worker has none. */
  async screenshot(jobId: string) {
    try {
      const response = await this.request(`/jobs/${encodeURIComponent(jobId)}/screenshot`, { timeoutMs: 20_000 });
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof GeelarkWorkerError && error.getStatus() === HttpStatus.NOT_FOUND) return null;
      throw error;
    }
  }
}
