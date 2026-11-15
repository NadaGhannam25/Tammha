import { Logger, ServiceUnavailableException } from '@nestjs/common';

const bucketApi = {
  upload: jest.fn(),
  remove: jest.fn(),
  createSignedUrl: jest.fn(),
  createSignedUrls: jest.fn(),
};
const from = jest.fn(() => bucketApi);
const createClient = jest.fn(() => ({ storage: { from } }));
jest.mock('@supabase/supabase-js', () => ({
  createClient: (...a: unknown[]) => createClient(...(a as [])),
}));

import {
  DOCUMENTS_BUCKET,
  fetchWithTimeout,
  STORAGE_REQUEST_TIMEOUT_MS,
  SupabaseStorageService,
} from '../supabase-storage.service';

const SECRET = 'sb_secret_UNIT-TEST-SECRET-MUST-NEVER-LEAK';

describe('SupabaseStorageService (unit, Supabase client mocked)', () => {
  let service: SupabaseStorageService;
  let logged: string[];

  beforeEach(() => {
    jest.clearAllMocks();
    logged = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((msg: unknown) => {
      logged.push(String(msg));
    });
    const config = {
      getOrThrow: (key: string) =>
        ({
          SUPABASE_URL: 'https://unit.supabase.co',
          SUPABASE_SECRET_KEY: SECRET,
        })[key],
    };
    service = new SupabaseStorageService(config as any);
  });

  afterEach(() => jest.restoreAllMocks());

  it('creates a server client with the secret key and no session persistence', () => {
    expect(createClient).toHaveBeenCalledWith(
      'https://unit.supabase.co',
      SECRET,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        global: { fetch: expect.any(Function) },
      },
    );
  });

  it('always uses the private "project-documents" bucket', async () => {
    bucketApi.upload.mockResolvedValue({ error: null });
    await service.upload('p/f/o', Buffer.from('x'), 'application/pdf');
    expect(DOCUMENTS_BUCKET).toBe('project-documents');
    expect(from).toHaveBeenCalledWith('project-documents');
  });

  it('uploads with upsert: false (never overwrites)', async () => {
    bucketApi.upload.mockResolvedValue({ error: null });
    await service.upload('p/f/o', Buffer.from('x'), 'text/plain');
    expect(bucketApi.upload).toHaveBeenCalledWith('p/f/o', Buffer.from('x'), {
      contentType: 'text/plain',
      upsert: false,
    });
  });

  it('maps Storage errors to 503 STORAGE_ERROR without exposing details or the key', async () => {
    bucketApi.upload.mockResolvedValue({
      error: {
        message: 'new row violates row-level security policy (internal detail)',
      },
    });
    const error = await service
      .upload('p/f/o', Buffer.from('x'), 'text/plain')
      .catch((e) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    const body = JSON.stringify(error.getResponse());
    expect(body).toContain('STORAGE_ERROR');
    expect(body).not.toContain('row-level');
    expect(body).not.toContain(SECRET);
    expect(logged.join('\n')).toContain('row-level'); // details stay in the server log
    expect(logged.join('\n')).not.toContain(SECRET);
  });

  it('removes many paths in one request; nothing to remove = no request', async () => {
    bucketApi.remove.mockResolvedValue({ error: null });
    await service.remove([]);
    expect(bucketApi.remove).not.toHaveBeenCalled();
    await service.remove(['a/b/c', 'a/b/d']);
    expect(bucketApi.remove).toHaveBeenCalledWith(['a/b/c', 'a/b/d']);
  });

  it('signs one path for 1 hour', async () => {
    bucketApi.createSignedUrl.mockResolvedValue({
      data: { signedUrl: 'https://s/1' },
      error: null,
    });
    await expect(service.createSignedUrl('a/b/c')).resolves.toBe('https://s/1');
    expect(bucketApi.createSignedUrl).toHaveBeenCalledWith('a/b/c', 3600);
  });

  it('signs many paths in one request and keeps the input order', async () => {
    bucketApi.createSignedUrls.mockResolvedValue({
      data: [
        { path: 'b', signedUrl: 'https://s/b', error: null },
        { path: 'a', signedUrl: 'https://s/a', error: null },
      ],
      error: null,
    });
    await expect(service.createSignedUrls(['a', 'b'])).resolves.toEqual([
      'https://s/a',
      'https://s/b',
    ]);
    expect(bucketApi.createSignedUrls).toHaveBeenCalledTimes(1);
  });

  it('a missing object in a batch is an error, not a silent hole', async () => {
    bucketApi.createSignedUrls.mockResolvedValue({
      data: [{ path: 'a', signedUrl: null, error: 'Object not found' }],
      error: null,
    });
    await expect(service.createSignedUrls(['a'])).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('gives the Supabase client a fetch with a request timeout', () => {
    const options = (createClient.mock.calls[0] as unknown[])[2] as {
      global?: { fetch?: unknown };
    };
    expect(typeof options.global?.fetch).toBe('function');
    expect(STORAGE_REQUEST_TIMEOUT_MS).toBe(120_000);
  });

  describe('fetchWithTimeout', () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason),
        );
      });

    it('aborts a request that does not answer in time', async () => {
      await expect(
        fetchWithTimeout(20, hanging)('https://unit.supabase.co/x'),
      ).rejects.toMatchObject({ name: 'TimeoutError' });
    });

    it('keeps a signal passed by the caller', async () => {
      const controller = new AbortController();
      const call = fetchWithTimeout(60_000, hanging)(
        'https://unit.supabase.co/x',
        {
          signal: controller.signal,
        },
      );
      controller.abort(new Error('caller aborted'));
      await expect(call).rejects.toThrow('caller aborted');
    });

    it('passes answers through unchanged', async () => {
      const ok = new Response('fine');
      const base = jest.fn(async () => ok) as unknown as typeof fetch;
      await expect(
        fetchWithTimeout(1000, base)('https://unit.supabase.co/x', {
          method: 'POST',
        }),
      ).resolves.toBe(ok);
      expect((base as jest.Mock).mock.calls[0][1]).toMatchObject({
        method: 'POST',
      });
    });
  });
});
