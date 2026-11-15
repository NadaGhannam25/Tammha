/**
 * Handbook AI: fixed-topic summary and task extraction — output contracts, prompts and
 * server-side checks.
 *
 * SUMMARY: the AI fills exactly SEVEN fixed topics (ids and titles never change). Each topic
 * says whether the handbook covers it (`found`) and, when it does, a short summary plus
 * points that quote the handbook with page numbers. The server:
 *  - always returns the seven topics in the fixed order (a topic the model left out, or
 *    marked found without content, is returned as found: false — the UI shows
 *    "لا توجد نتائج" / "No results found");
 *  - keeps only page numbers that exist in the text it sent and checks every quote:
 *      quote found on a cited page  -> verified
 *      quote found on other pages   -> pages corrected, verified
 *      quote not found / no quote   -> verified: false, pages dropped
 *  - refuses an answer that is not JSON or has no `topics` list (InvalidExplanationError
 *    -> 502 AI_INVALID_RESPONSE, nothing stored), so a malformed answer is never shown.
 *
 * TASKS: the AI proposes tasks taken from the handbook (each with a quote). Tasks whose
 * quote is not found in the handbook text are dropped, so every suggestion can be traced
 * back to the handbook. Nothing is created: the team leader applies selected suggestions
 * with POST /projects/:projectId/ai-task-suggestions/apply.
 *
 * Grading information in a handbook is reference information only: Tammha never grades.
 */
export const SUMMARY_PROMPT_VERSION = 'handbook-summary-1';
export const HANDBOOK_TASKS_PROMPT_VERSION = 'handbook-tasks-1';

export const HANDBOOK_TOPICS = [
  {
    id: 'OVERVIEW',
    ar: 'نبذة عن الدليل',
    en: 'Handbook Overview',
    hint: 'what the handbook is, its purpose and academic scope',
  },
  {
    id: 'REPORT_STRUCTURE',
    ar: 'هيكل تقرير مشروع التخرج',
    en: 'Graduation Report Structure',
    hint: 'required chapters, sections, report structure and organisational requirements',
  },
  {
    id: 'GRADING',
    ar: 'توزيع الدرجات ومعايير التقييم',
    en: 'Grading Distribution and Evaluation Criteria',
    hint: 'grade distribution, percentages and assessment criteria exactly as stated (reference only)',
  },
  {
    id: 'SUBMISSION',
    ar: 'متطلبات التسليم',
    en: 'Submission Requirements',
    hint: 'deliverables, submission method, deadlines and formatting instructions',
  },
  {
    id: 'PROPOSAL',
    ar: 'مقترح المشروع (Proposal)',
    en: 'Project Proposal',
    hint: 'proposal requirements, content, submission expectations',
  },
  {
    id: 'WEEKLY_REPORTS',
    ar: 'التقارير الأسبوعية',
    en: 'Weekly Reports',
    hint: 'weekly / progress reporting requirements, frequency, content, submission',
  },
  {
    id: 'FINAL_DEFENSE',
    ar: 'المناقشة النهائية',
    en: 'Final Defense',
    hint: 'final presentation / defense, attendance, evaluation session instructions',
  },
] as const;
export type HandbookTopicId = (typeof HANDBOOK_TOPICS)[number]['id'];
const TOPIC_IDS = HANDBOOK_TOPICS.map((t) => t.id) as string[];

const S = (description: string) => ({ type: 'STRING', description });
const PAGES = {
  type: 'ARRAY',
  items: { type: 'INTEGER' },
  description: 'Page numbers ([Page N] markers) where this appears',
};
const POINT = {
  type: 'OBJECT',
  properties: {
    text: S('One piece of information explained in simple words'),
    pages: PAGES,
    quote: S(
      'A short exact quote (3-25 words) copied verbatim from those pages, in the language of the handbook',
    ),
  },
  required: ['text', 'pages', 'quote'],
};

/** Gemini `responseSchema` (OpenAPI subset) for the summary. */
export const SUMMARY_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    topics: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING', enum: TOPIC_IDS },
          found: {
            type: 'BOOLEAN',
            description:
              'false when the handbook says nothing about this topic',
          },
          summary: S('2-5 sentences; empty when found is false'),
          points: { type: 'ARRAY', items: POINT },
        },
        required: ['id', 'found', 'summary', 'points'],
      },
    },
  },
  required: ['topics'],
};

export const SUMMARY_SYSTEM_INSTRUCTION = [
  'You are Tammha, an assistant that summarises university graduation-project handbooks for students.',
  'Use ONLY the handbook text you are given. Never invent requirements, chapters, numbers, dates, ' +
    'percentages, grades or rules, and never add advice that is not in the handbook.',
  'Fill exactly these seven topics (one entry per id, in this order): ' +
    HANDBOOK_TOPICS.map((t) => `${t.id} = ${t.hint}`).join('; ') +
    '.',
  'If the handbook does not cover a topic, return it with found: false, an empty summary and no points. ' +
    'Grading information is copied only as reference information; do not evaluate anyone.',
  'Every point must cite the page numbers ([Page N] markers) where it appears and give a short quote copied ' +
    'exactly from those pages. Use clear, formal language. Return JSON only.',
].join('\n');

/** Gemini `responseSchema` for handbook task extraction. */
export const HANDBOOK_TASKS_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    tasks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: S('Short task title (imperative)'),
          description: S('What to do, based on the handbook'),
          priority: { type: 'STRING', enum: ['HIGH', 'MEDIUM', 'LOW'] },
          estimatedDays: { type: 'INTEGER' },
          pages: PAGES,
          quote: S(
            'Exact quote (3-25 words) from the handbook that requires this task',
          ),
        },
        required: [
          'title',
          'description',
          'priority',
          'estimatedDays',
          'pages',
          'quote',
        ],
      },
    },
  },
  required: ['tasks'],
};

export const HANDBOOK_TASKS_SYSTEM_INSTRUCTION = [
  'You are Tammha, an assistant that turns a university graduation-project handbook into project tasks.',
  'Propose only tasks that the handbook text requires or clearly describes (deliverables, report chapters, ' +
    'submissions, proposal, weekly reports, defense preparation, formatting work). Never invent requirements.',
  'Each task cites the page numbers ([Page N] markers) and an exact quote from the handbook that requires it.',
  'Do not repeat tasks listed as existing. Return 0-15 tasks; return an empty list when the handbook contains ' +
    'no actionable requirements. Return JSON only.',
].join('\n');

// ==========================================================
// Types
// ==========================================================

export interface CheckedPoint {
  text: string;
  pages: number[];
  quote: string | null;
  verified: boolean;
}
export interface SummaryTopic {
  id: HandbookTopicId;
  title: { ar: string; en: string };
  found: boolean;
  summary: string;
  points: CheckedPoint[];
  pages: number[];
}
export interface HandbookSummary {
  topics: SummaryTopic[];
  stats: {
    topics: number;
    foundTopics: number;
    points: number;
    verifiedPoints: number;
  };
}
export interface HandbookTaskSuggestion {
  id: string;
  title: string;
  description: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  estimatedDays: number | null;
  pages: number[];
  quote: string;
}

export class InvalidExplanationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidExplanationError';
  }
}

// ==========================================================
// Prompt helpers
// ==========================================================

/** Splits stored text (pages separated by \f) and keeps whole pages within the budget. */
export function handbookPagesForPrompt(
  extractedText: string,
  maxChars: number,
): {
  pages: { page: number; text: string }[];
  pageCount: number;
  truncated: boolean;
} {
  const all = extractedText.split('\f');
  const pages: { page: number; text: string }[] = [];
  let used = 0;
  for (let i = 0; i < all.length; i++) {
    const text = all[i].trim();
    if (!text) continue;
    if (used + text.length > maxChars && pages.length > 0) {
      return { pages, pageCount: all.length, truncated: true };
    }
    pages.push({ page: i + 1, text: text.slice(0, maxChars) });
    used += text.length;
  }
  return { pages, pageCount: all.length, truncated: false };
}

function handbookBlock(
  pages: { page: number; text: string }[],
  truncated: boolean,
) {
  return [
    truncated
      ? 'NOTE: only the first part of the handbook fits; use only what is below.'
      : '',
    '--- HANDBOOK TEXT ---',
    ...pages.map((p) => `[Page ${p.page}]\n${p.text}`),
    '--- END OF HANDBOOK ---',
  ];
}

export function buildSummaryPrompt(input: {
  title: string;
  language: 'ar' | 'en';
  pages: { page: number; text: string }[];
  truncated: boolean;
}): string {
  const lang = input.language === 'ar' ? 'Arabic' : 'English';
  return [
    `TASK: HANDBOOK SUMMARY — summarise the handbook "${input.title}" in ${lang} into the seven fixed topics.`,
    `Write summaries and point texts in ${lang}; keep every quote in the handbook's own language.`,
    ...handbookBlock(input.pages, input.truncated),
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildHandbookTasksPrompt(input: {
  title: string;
  language: 'ar' | 'en';
  pages: { page: number; text: string }[];
  truncated: boolean;
  existingTasks: string[];
}): string {
  const lang = input.language === 'ar' ? 'Arabic' : 'English';
  return [
    `TASK: HANDBOOK TASKS — propose project tasks required by the handbook "${input.title}". Write titles and descriptions in ${lang}.`,
    input.existingTasks.length
      ? `EXISTING TASKS (do not repeat):\n${input.existingTasks
          .slice(0, 100)
          .map((t) => `- ${t}`)
          .join('\n')}`
      : 'EXISTING TASKS: none',
    ...handbookBlock(input.pages, input.truncated),
  ]
    .filter(Boolean)
    .join('\n');
}

// ==========================================================
// Checks
// ==========================================================

/** Lower-case, no diacritics / tatweel / punctuation, unified Arabic letters, single spaces. */
export function normalizeForMatch(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ًͯ-ٰٟـ]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const clip = (v: unknown, max: number) =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(
      raw
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/, ''),
    );
  } catch {
    throw new InvalidExplanationError('not JSON');
  }
}

/** Page / quote checker bound to the pages that were sent to the model. */
function quoteChecker(pages: { page: number; text: string }[]) {
  const pageText = new Map(
    pages.map((p) => [p.page, normalizeForMatch(p.text)]),
  );
  const toPages = (v: unknown) =>
    [
      ...new Set(
        (Array.isArray(v) ? v : [])
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && pageText.has(n)),
      ),
    ]
      .sort((a, b) => a - b)
      .slice(0, 10);
  const check = (
    pagesIn: unknown,
    quoteIn: unknown,
  ): { pages: number[]; quote: string | null; verified: boolean } => {
    let pagesOut = toPages(pagesIn);
    const quote = clip(quoteIn, 300) || null;
    const needle = quote ? normalizeForMatch(quote) : '';
    if (needle.length < 6) return { pages: [], quote, verified: false };
    if (pagesOut.some((n) => pageText.get(n)!.includes(needle))) {
      return { pages: pagesOut, quote, verified: true };
    }
    pagesOut = [...pageText.entries()]
      .filter(([, t]) => t.includes(needle))
      .map(([n]) => n)
      .slice(0, 10);
    // found elsewhere -> corrected pages; not found -> never show a wrong page
    return { pages: pagesOut, quote, verified: pagesOut.length > 0 };
  };
  return { check, toPages };
}

/**
 * Parses and checks the summary against the pages that were sent. Always returns the
 * seven fixed topics in order. Throws InvalidExplanationError for a malformed answer.
 */
export function parseSummary(
  raw: string,
  pages: { page: number; text: string }[],
): HandbookSummary {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untrusted model JSON, checked field by field below
  const data = parseJson(raw) as any;
  if (!data || typeof data !== 'object' || !Array.isArray(data.topics)) {
    throw new InvalidExplanationError('no topics list');
  }
  const { check } = quoteChecker(pages);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byId = new Map<string, any>();
  for (const t of data.topics.slice(0, 20)) {
    if (t && typeof t.id === 'string' && !byId.has(t.id)) byId.set(t.id, t);
  }
  let points = 0;
  let verifiedPoints = 0;
  const topics: SummaryTopic[] = HANDBOOK_TOPICS.map((def) => {
    const t = byId.get(def.id);
    const base = {
      id: def.id,
      title: { ar: def.ar, en: def.en },
    };
    if (!t || t.found !== true) {
      return { ...base, found: false, summary: '', points: [], pages: [] };
    }
    const list: CheckedPoint[] = (Array.isArray(t.points) ? t.points : [])
      .slice(0, 20)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((p: any) => {
        const text = clip(p?.text, 600);
        if (!text) return null;
        return { text, ...check(p?.pages, p?.quote) };
      })
      .filter((p: CheckedPoint | null): p is CheckedPoint => !!p);
    const summary = clip(t.summary, 1500);
    if (!summary && list.length === 0) {
      return { ...base, found: false, summary: '', points: [], pages: [] };
    }
    points += list.length;
    verifiedPoints += list.filter((p) => p.verified).length;
    return {
      ...base,
      found: true,
      summary,
      points: list,
      pages: [...new Set(list.flatMap((p) => p.pages))].sort((a, b) => a - b),
    };
  });
  return {
    topics,
    stats: {
      topics: topics.length,
      foundTopics: topics.filter((t) => t.found).length,
      points,
      verifiedPoints,
    },
  };
}

const normTitle = (t: string) =>
  t.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Parses handbook task suggestions. Drops tasks without a verifiable quote and tasks whose
 * title repeats another suggestion or an existing task. Throws InvalidExplanationError for
 * a malformed answer; an empty list is a valid answer.
 */
export function parseHandbookTasks(
  raw: string,
  pages: { page: number; text: string }[],
  existingTitles: string[],
): {
  suggestions: HandbookTaskSuggestion[];
  dropped: { unverified: number; duplicates: number };
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untrusted model JSON
  const data = parseJson(raw) as any;
  if (!data || typeof data !== 'object' || !Array.isArray(data.tasks)) {
    throw new InvalidExplanationError('no tasks list');
  }
  const { check } = quoteChecker(pages);
  const seen = new Set(existingTitles.map(normTitle));
  const suggestions: HandbookTaskSuggestion[] = [];
  let unverified = 0;
  let duplicates = 0;
  for (const t of data.tasks.slice(0, 30)) {
    const title = clip(t?.title, 200);
    if (title.length < 3) continue;
    const ref = check(t?.pages, t?.quote);
    if (!ref.verified || !ref.quote) {
      unverified++;
      continue;
    }
    if (seen.has(normTitle(title))) {
      duplicates++;
      continue;
    }
    seen.add(normTitle(title));
    const days = Number(t?.estimatedDays);
    suggestions.push({
      id: `t${suggestions.length + 1}`,
      title,
      description: clip(t?.description, 2000),
      priority: ['HIGH', 'MEDIUM', 'LOW'].includes(t?.priority)
        ? t.priority
        : 'MEDIUM',
      estimatedDays:
        Number.isInteger(days) && days >= 1 && days <= 365 ? days : null,
      pages: ref.pages,
      quote: ref.quote,
    });
    if (suggestions.length >= 15) break;
  }
  return { suggestions, dropped: { unverified, duplicates } };
}
