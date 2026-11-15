/**
 * AI support limits and handbook settings (P13). All optional, validated at startup.
 */
export interface AiSupportSettings {
  /** Requests per user per rolling hour */
  userHourlyLimit: number;
  /** Requests per user per rolling 24 h */
  userDailyLimit: number;
  /** Requests per project per rolling 24 h (all members together) */
  projectDailyLimit: number;
  /** Upper bound for the model's answer */
  maxOutputTokens: number;
  /** Characters of handbook text sent with one request */
  handbookMaxChars: number;
  /** Handbook excerpts sent with one request */
  handbookMaxExcerpts: number;
  /** Largest handbook PDF an admin can upload */
  handbookMaxFileMb: number;
  /** Characters of handbook text sent to explain a whole handbook (whole pages) */
  handbookExplainMaxChars: number;
  /** Upper bound for the answer of a handbook summary / task extraction */
  explainMaxOutputTokens: number;
}

export const AI_SUPPORT_DEFAULTS: AiSupportSettings = {
  userHourlyLimit: 10,
  userDailyLimit: 30,
  projectDailyLimit: 60,
  maxOutputTokens: 4096,
  handbookMaxChars: 8000,
  handbookMaxExcerpts: 8,
  handbookMaxFileMb: 20,
  handbookExplainMaxChars: 150000,
  explainMaxOutputTokens: 8192,
};

export function readAiSupportSettings(env: Record<string, unknown>): {
  settings: AiSupportSettings;
  errors: string[];
} {
  const errors: string[] = [];
  const int = (key: string, min: number, max: number, fallback: number) => {
    const raw = typeof env[key] === 'string' ? (env[key] as string).trim() : '';
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      errors.push(`${key} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return n;
  };
  const d = AI_SUPPORT_DEFAULTS;
  return {
    settings: {
      userHourlyLimit: int('AI_USER_HOURLY_LIMIT', 1, 1000, d.userHourlyLimit),
      userDailyLimit: int('AI_USER_DAILY_LIMIT', 1, 10000, d.userDailyLimit),
      projectDailyLimit: int(
        'AI_PROJECT_DAILY_LIMIT',
        1,
        10000,
        d.projectDailyLimit,
      ),
      maxOutputTokens: int(
        'AI_MAX_OUTPUT_TOKENS',
        256,
        32768,
        d.maxOutputTokens,
      ),
      handbookMaxChars: int(
        'AI_HANDBOOK_MAX_CHARS',
        1000,
        60000,
        d.handbookMaxChars,
      ),
      handbookMaxExcerpts: int(
        'AI_HANDBOOK_MAX_EXCERPTS',
        1,
        20,
        d.handbookMaxExcerpts,
      ),
      handbookMaxFileMb: int(
        'HANDBOOK_MAX_FILE_MB',
        1,
        50,
        d.handbookMaxFileMb,
      ),
      handbookExplainMaxChars: int(
        'AI_HANDBOOK_EXPLAIN_MAX_CHARS',
        10000,
        400000,
        d.handbookExplainMaxChars,
      ),
      explainMaxOutputTokens: int(
        'AI_EXPLAIN_MAX_OUTPUT_TOKENS',
        1024,
        32768,
        d.explainMaxOutputTokens,
      ),
    },
    errors,
  };
}
