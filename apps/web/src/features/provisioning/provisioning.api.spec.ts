import { vi } from 'vitest';
import { submitLinkDecision, submitProfile } from './provisioning.api';
import { job } from './provisioning.fixtures';

it('envia o perfil como multipart (name + photo) sem forçar content-type', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(job({ step: 'saving_profile' })), { status: 200, headers: { 'content-type': 'application/json' } }));
  const photo = new File([new Uint8Array(10)], 'perfil.png', { type: 'image/png' });

  const result = await submitProfile('tenant-1', 'job-1', { name: 'Comercial', photo });

  expect(result.step).toBe('saving_profile');
  const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
  expect(url).toBe('http://localhost:3000/api/tenants/tenant-1/provisioning/jobs/job-1/profile');
  expect(init.method).toBe('POST');
  expect(init.body).toBeInstanceOf(FormData);
  const form = init.body as FormData;
  expect(form.get('name')).toBe('Comercial');
  expect((form.get('photo') as File).name).toBe('perfil.png');
  expect(new Headers(init.headers).has('content-type')).toBe(false);
});

it('omite a foto quando o usuário não escolhe uma', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(job()), { status: 200 }));
  await submitProfile('tenant-1', 'job-1', { name: 'Comercial', photo: null });
  const form = (fetchSpy.mock.calls[0][1] as RequestInit).body as FormData;
  expect(form.has('photo')).toBe(false);
});

it('só manda a camuflagem no vínculo quando o admin a liga', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(job()), { status: 200 }));

  await submitLinkDecision('tenant-1', 'job-1', true);
  await submitLinkDecision('tenant-1', 'job-1', true, true);

  expect(fetchSpy.mock.calls.map(([, init]) => (init as RequestInit).body)).toEqual(['{"connect":true}', '{"connect":true,"stealth":true}']);
});
