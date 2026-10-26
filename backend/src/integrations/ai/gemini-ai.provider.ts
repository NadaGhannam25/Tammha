import { Logger } from '@nestjs/common';
import { AiConfig } from '../integrations.config';
import {
  AiProviderError,
  AiTextProvider,
  AiTextRequest,
  AiTextResult,
} from './ai.provider';

type EnabledAiConfig = Extract<AiConfig, { enabled: true }>;
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const GEMINI_API_BASE =
  'https://generativelanguage.googleapis.com/v1beta';

/** Finish reasons that mean the answer was withheld by the provider's safety systems. */
const BLOCKED_FINISH = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
]);

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/**
 * Gemini adapter (P13) for models.generateContent (REST, v1beta).
 * - The API key travels in the `x-goog-api-key` header (never in the URL, never logged).
 * - Hard timeout with AbortController (AI_REQUEST_TIMEOUT_MS).
 * - JSON mode: generationConfig.responseMimeType + responseSchema.
 * - Sampling parameters (temperature, top_p, top_k) are not sent: deprecated for current models.
 * - Errors become AiProviderError codes; provider messages are not propagated.
 */
export class GeminiAiTextProvider implements AiTextProvider {
  readonly name = 'gemini' as const;
  readonly model: string;
  private readonly logger = new Logger('Gemini');

  constructor(
    private readonly config: EnabledAiConfig,
    private readonly fetchFn: FetchLike = (url, init) =>
      fetch(url, init) as unknown as ReturnType<FetchLike>,
  ) {
    this.model = config.model.replace(/^models\//, '');
  }

  isEnabled() {
    return true;
  }

  async generateText(request: AiTextRequest): Promise<AiTextResult> {
    const body = {
      ...(request.system && {
        systemInstruction: { parts: [{ text: request.system }] },
      }),
      contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
      generationConfig: {
        ...(request.maxOutputTokens && {
          maxOutputTokens: request.maxOutputTokens,
        }),
        ...(request.responseSchema && {
          responseMimeType: 'application/json',
          responseSchema: request.responseSchema,
        }),
      },
    };

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      request.timeoutMs ?? this.config.timeoutMs,
    );
    let status = 0;
    let payload: GeminiResponse;
    try {
      const res = await this.fetchFn(
        `${GEMINI_API_BASE}/models/${encodeURIComponent(this.model)}:generateContent`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': this.config.apiKey,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      status = res.status;
      if (!res.ok) throw this.httpError(res.status);
      payload = (await res.json()) as GeminiResponse;
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      if ((error as Error)?.name === 'AbortError') {
        this.logger.warn('request timed out');
        throw new AiProviderError('AI_PROVIDER_TIMEOUT');
      }
      this.logger.warn(`network error: ${(error as Error)?.name ?? 'Error'}`);
      throw new AiProviderError('AI_PROVIDER_UNAVAILABLE', status || undefined);
    } finally {
      clearTimeout(timeout);
    }

    if (payload.promptFeedback?.blockReason) {
      throw new AiProviderError('AI_RESPONSE_BLOCKED');
    }
    const candidate = payload.candidates?.[0];
    const finishReason = candidate?.finishReason;
    if (finishReason && BLOCKED_FINISH.has(finishReason)) {
      throw new AiProviderError('AI_RESPONSE_BLOCKED');
    }
    if (finishReason === 'MAX_TOKENS') {
      throw new AiProviderError('AI_RESPONSE_TRUNCATED');
    }
    const text = (candidate?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    if (!text) throw new AiProviderError('AI_EMPTY_RESPONSE');

    return {
      text,
      provider: 'gemini',
      model: this.model,
      finishReason,
      usage: {
        inputTokens: payload.usageMetadata?.promptTokenCount,
        outputTokens: payload.usageMetadata?.candidatesTokenCount,
      },
    };
  }

  private httpError(status: number): AiProviderError {
    // status code only: the response body may echo the request
    this.logger.warn(`provider answered HTTP ${status}`);
    if (status === 429)
      return new AiProviderError('AI_PROVIDER_RATE_LIMITED', status);
    if (status === 408 || status >= 500) {
      return new AiProviderError('AI_PROVIDER_UNAVAILABLE', status);
    }
    // 400/401/403/404: bad key, unknown model or rejected request (configuration problem)
    return new AiProviderError('AI_PROVIDER_REJECTED', status);
  }
}
