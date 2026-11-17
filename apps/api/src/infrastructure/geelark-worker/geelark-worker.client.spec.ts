import { GeelarkWorkerClient, GeelarkWorkerError } from './geelark-worker.client';

describe('GeelarkWorkerClient', () => {
  const originalFetch = global.fetch;
  const originalEnv = { url: process.env.GEELARK_WORKER_URL, token: process.env.GEELARK_WORKER_TOKEN };

  beforeEach(() => {
    process.env.GEELARK_WORKER_URL = 'http://worker.test/';
    process.env.GEELARK_WORKER_TOKEN = 'worker-token';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalEnv.url === undefined) delete process.env.GEELARK_WORKER_URL; else process.env.GEELARK_WORKER_URL = originalEnv.url;
    if (originalEnv.token === undefined) delete process.env.GEELARK_WORKER_TOKEN; else process.env.GEELARK_WORKER_TOKEN = originalEnv.token;
  });

  const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });

  it('authenticates with x-worker-token and sends inputs as JSON', async () => {
    const fetchMock = jest.fn().mockResolvedValue(reply(200, { jobId: 'job-1', status: 'running' }));
    global.fetch = fetchMock as any;

    await new GeelarkWorkerClient().sendInput('job-1', { type: 'sms', code: '123456' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://worker.test/jobs/job-1/input');
    expect(init.headers['x-worker-token']).toBe('worker-token');
    expect(JSON.parse(init.body)).toEqual({ type: 'sms', code: '123456' });
  });

  it('maps worker errors to Portuguese HTTP errors that never echo the request body', async () => {
    global.fetch = jest.fn().mockResolvedValue(reply(409, { error: 'phone_busy', message: 'busy' })) as any;
    const error = await new GeelarkWorkerClient().createJob({ jobId: 'j', phoneId: 'p' } as any).catch((caught) => caught);
    expect(error).toBeInstanceOf(GeelarkWorkerError);
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({ code: 'phone_busy', message: expect.stringContaining('outro cadastro') });

    global.fetch = jest.fn().mockResolvedValue(reply(429, { error: 'worker_full', message: 'full' })) as any;
    await expect(new GeelarkWorkerClient().createJob({} as any)).rejects.toMatchObject({ status: 429 });

    global.fetch = jest.fn().mockResolvedValue(reply(500, { error: 'internal', message: 'boom' })) as any;
    const internal = await new GeelarkWorkerClient().sendInput('j', { type: 'sms', code: '654321' }).catch((caught) => caught);
    expect(internal.getStatus()).toBe(503);
    expect(JSON.stringify(internal.getResponse())).not.toContain('654321');

    global.fetch = jest.fn().mockRejectedValue(Object.assign(new Error('timeout'), { name: 'TimeoutError' })) as any;
    await expect(new GeelarkWorkerClient().listPhones()).rejects.toMatchObject({ status: 504, workerCode: 'worker_timeout' });
  });

  it('returns null for a job or screenshot the worker does not know', async () => {
    global.fetch = jest.fn().mockResolvedValue(reply(404, { error: 'not_found', message: 'no job' })) as any;
    await expect(new GeelarkWorkerClient().getJob('gone')).resolves.toBeNull();
    await expect(new GeelarkWorkerClient().screenshot('gone')).resolves.toBeNull();
  });

  it('refuses to call the worker without a token', async () => {
    delete process.env.GEELARK_WORKER_TOKEN;
    global.fetch = jest.fn() as any;
    await expect(new GeelarkWorkerClient().listPhones()).rejects.toMatchObject({ status: 503, workerCode: 'worker_not_configured' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
