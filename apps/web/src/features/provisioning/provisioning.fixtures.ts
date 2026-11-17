import type { EgressNode, Job, Phone } from './provisioning.types';

export const API = 'http://localhost:3000/api/tenants/tenant-1/provisioning';

export const egressNode = (overrides: Partial<EgressNode> = {}): EgressNode => ({
  node: 'a55241de-0000-4000-8000-000000000001', label: 'Ana', pcName: 'PC da Ana', online: true, publicIps: [], userId: 'user-1', userName: 'Ana', isMine: true, ...overrides,
});

export const phone = (overrides: Partial<Phone> = {}): Phone => ({
  id: 'phone-2', name: 'Phone 2', status: 'off', android: 'Android 12', proxy: 'socks5 209.50.229.249:1080',
  apps: { whatsapp: true, business: false }, busyJobId: null, ...overrides,
});

let clock = Date.parse('2026-11-17T12:00:00Z');
/** Cada job novo tem `updatedAt` maior que o anterior (o hook descarta respostas mais antigas). */
export const job = (overrides: Partial<Job> = {}): Job => {
  clock += 1000;
  const at = new Date(clock).toISOString();
  return {
    id: 'job-1', egressNode: 'a55241de-0000-4000-8000-000000000001', geelarkPhoneId: 'phone-2', phoneName: 'Phone 2', app: 'whatsapp',
    number: '5511987654321', status: 'running', step: 'starting_phone', awaiting: null, message: null, errorCode: null,
    hasScreenshot: false, egressIp: null, history: [{ step: 'queued', at, message: null }, { step: 'starting_phone', at, message: null }],
    linked: false, numberId: null, createdBy: 'user-1', createdAt: '2026-11-17T12:00:00.000Z', updatedAt: at, ...overrides,
  };
};

export const historyOf = (...steps: string[]) => steps.map((step, index) => ({ step, at: new Date(Date.parse('2026-11-17T12:00:00Z') + index * 1000).toISOString(), message: null }));
