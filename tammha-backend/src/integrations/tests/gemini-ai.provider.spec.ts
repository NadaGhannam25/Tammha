import { Logger } from '@nestjs/common';
import {
  FetchLike,
  GEMINI_API_BASE,
  GeminiAiTextProvider,
} from '../ai/gemini-ai.provider';
import { AiProviderError } from '../ai/ai.provider';

/** The Gemini adapter against a MOCKED fetch: no request ever leaves the process. */
const KEY = 'AIza-unit-test-key-0123456789';
const config = {
  enabled: true as const,
  provider: 'gemini' as const,
  apiKey: KEY,
  model: 'models/gemini-3.8-flash',
  timeoutMs: 200,
};

function reply(status: number, body: unknown): FetchLike {
  return jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}
const ok = (text: string, extra: object = {}) =>
  reply(200, {
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 321, candidatesTokenCount: 45 },
    ...extra,
  });

async function codeOf(p: Promise<unknown>): Promise<string> {
  const e = await p.catch((x) => x);
  expect(e).toBeInstanceOf(AiProviderError);
  return (e as AiProviderError).code;
}

describe('GeminiAiTextProvider (mocked fetch)', () => {
  const logs: string[] = [];
  beforeEach(() => {
    logs.length = 0;
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((m: unknown) => void logs.push(String(m)));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    expect(logs.join(' ')).not.toContain(KEY);
  });

  it('calls generateContent with the key in a header, system instruction and JSON schema', async () => {
    const fetchFn = ok('{"summary":"x"}');
    const provider = new GeminiAiTextProvider(config, fetchFn);
    const result = await provider.generateText({
      system: 'rules',
      prompt: 'hello',
      maxOutputTokens: 1000,
      temperature: 0.9,
      responseSchema: { type: 'OBJECT' },
    });
    const [url, init] = (fetchFn as jest.Mock).mock.calls[0];
    expect(url).toBe(
      `${GEMINI_API_BASE}/models/gemini-3.8-flash:generateContent`,
    );
    expect(url).not.toContain(KEY);
    expect(init.method).toBe('POST');
    expect(init.headers['x-goog-api-key']).toBe(KEY);
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      systemInstruction: { parts: [{ text: 'rules' }] },
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: {
        maxOutputTokens: 1000,
        responseMimeType: 'application/json',
        responseSchema: { type: 'OBJECT' },
      },
    });
    expect(init.body).not.toContain('temperature'); // deprecated for current models
    expect(result).toEqual({
      text: '{"summary":"x"}',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      finishReason: 'STOP',
      usage: { inputTokens: 321, outputTokens: 45 },
    });
  });

  it.each([
    [429, 'AI_PROVIDER_RATE_LIMITED'],
    [500, 'AI_PROVIDER_UNAVAILABLE'],
    [503, 'AI_PROVIDER_UNAVAILABLE'],
    [400, 'AI_PROVIDER_REJECTED'],
    [403, 'AI_PROVIDER_REJECTED'],
    [404, 'AI_PROVIDER_REJECTED'],
  ])('HTTP %s -> %s', async (status, code) => {
    const provider = new GeminiAiTextProvider(
      config,
      reply(status, { error: { message: `bad key ${KEY}` } }),
    );
    expect(await codeOf(provider.generateText({ prompt: 'x' }))).toBe(code);
  });

  it('blocked prompt, blocked answer, truncated answer, empty answer', async () => {
    const blockedPrompt = new GeminiAiTextProvider(
      config,
      reply(200, { promptFeedback: { blockReason: 'SAFETY' } }),
    );
    expect(await codeOf(blockedPrompt.generateText({ prompt: 'x' }))).toBe(
      'AI_RESPONSE_BLOCKED',
    );
    const blocked = new GeminiAiTextProvider(
      config,
      reply(200, { candidates: [{ finishReason: 'SAFETY' }] }),
    );
    expect(await codeOf(blocked.generateText({ prompt: 'x' }))).toBe(
      'AI_RESPONSE_BLOCKED',
    );
    const truncated = new GeminiAiTextProvider(
      config,
      reply(200, {
        candidates: [
          {
            content: { parts: [{ text: '{"a":' }] },
            finishReason: 'MAX_TOKENS',
          },
        ],
      }),
    );
    expect(await codeOf(truncated.generateText({ prompt: 'x' }))).toBe(
      'AI_RESPONSE_TRUNCATED',
    );
    const empty = new GeminiAiTextProvider(
      config,
      reply(200, {
        candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
      }),
    );
    expect(await codeOf(empty.generateText({ prompt: 'x' }))).toBe(
      'AI_EMPTY_RESPONSE',
    );
  });

  it('times out with AbortController', async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    const provider = new GeminiAiTextProvider(config, hanging);
    const started = Date.now();
    expect(
      await codeOf(provider.generateText({ prompt: 'x', timeoutMs: 50 })),
    ).toBe('AI_PROVIDER_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('network failures become AI_PROVIDER_UNAVAILABLE without leaking details', async () => {
    const provider = new GeminiAiTextProvider(config, async () => {
      throw new Error(`getaddrinfo ENOTFOUND key=${KEY}`);
    });
    const error = await provider.generateText({ prompt: 'x' }).catch((e) => e);
    expect(error.code).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(error.message).toBe('AI_PROVIDER_UNAVAILABLE');
  });
});
