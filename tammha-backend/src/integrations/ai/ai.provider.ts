/**
 * Port for AI text generation (P10 port, extended in P13).
 * AI output is advisory text only. Scores such as Project Readiness stay rule-based
 * (src/modules/dashboard/progress) and never come from this provider.
 */
export const AI_TEXT_PROVIDER = Symbol('AI_TEXT_PROVIDER');

/** Gemini is the only AI provider of the backend. */
export type AiProviderId = 'gemini';

export interface AiTextRequest {
  /** Instructions for the model (role, rules, output contract) */
  system?: string;
  /** The user's question plus the context the feature chooses to send */
  prompt: string;
  maxOutputTokens?: number;
  /** @deprecated ignored by current Gemini models (sampling parameters are deprecated) */
  temperature?: number;
  /** P13: ask for JSON matching this schema (OpenAPI-subset schema, Gemini `responseSchema`) */
  responseSchema?: Record<string, unknown>;
  /** P13: overrides AI_REQUEST_TIMEOUT_MS for this call */
  timeoutMs?: number;
}

export interface AiTextResult {
  text: string;
  provider: AiProviderId;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Provider reason the generation stopped (e.g. STOP, MAX_TOKENS) */
  finishReason?: string;
}

export interface AiTextProvider {
  readonly name: AiProviderId | 'disabled';
  /** Model ID used for requests (null when disabled) */
  readonly model: string | null;
  isEnabled(): boolean;
  generateText(request: AiTextRequest): Promise<AiTextResult>;
}

/**
 * P13: safe, typed provider failure. `code` is stable and secret-free; the provider's
 * own message is never included (it can echo prompts or configuration).
 */
export type AiProviderErrorCode =
  | 'AI_PROVIDER_TIMEOUT'
  | 'AI_PROVIDER_UNAVAILABLE'
  | 'AI_PROVIDER_RATE_LIMITED'
  | 'AI_PROVIDER_REJECTED'
  | 'AI_RESPONSE_BLOCKED'
  | 'AI_RESPONSE_TRUNCATED'
  | 'AI_EMPTY_RESPONSE';

export class AiProviderError extends Error {
  constructor(
    readonly code: AiProviderErrorCode,
    /** HTTP status from the provider, when there was one */
    readonly providerStatus?: number,
  ) {
    super(code);
    this.name = 'AiProviderError';
  }
}
