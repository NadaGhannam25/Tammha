import type { HandbookExcerpt } from '../handbook/handbook-retrieval';

/**
 * One structured output contract for every AI feature (P13 + future ones).
 * The model must return JSON with ALL keys (empty arrays / "" when not relevant);
 * the server validates, trims and caps everything before anything is stored or returned.
 */
export const PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export const CONFIDENCE = ['LOW', 'MEDIUM', 'HIGH'] as const;

const S = (description: string) => ({ type: 'STRING', description });

/** Gemini `responseSchema` (OpenAPI subset). */
export const GUIDANCE_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: S('2-4 sentence overview of the guidance'),
    answer: S(
      'Direct answer to the question, or empty string when there is no question',
    ),
    recommendations: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: S('Short title'),
          detail: S('What to do and why'),
          priority: { type: 'STRING', enum: [...PRIORITIES] },
        },
        required: ['title', 'detail', 'priority'],
      },
    },
    nextSteps: { type: 'ARRAY', items: S('A concrete next step') },
    taskSuggestions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: S('Task title'),
          description: S('What the task involves'),
          priority: { type: 'STRING', enum: [...PRIORITIES] },
          estimatedDays: {
            type: 'INTEGER',
            description: 'Rough effort in days (0-60)',
          },
          milestone: S('Related milestone title, or empty string'),
        },
        required: [
          'title',
          'description',
          'priority',
          'estimatedDays',
          'milestone',
        ],
      },
    },
    milestoneSuggestions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: S('Milestone title'),
          description: S('What it covers / how to know it is done'),
          suggestedOrder: { type: 'INTEGER', description: '1 = first' },
          suggestedDueDate: S('YYYY-MM-DD, or empty string'),
        },
        required: [
          'title',
          'description',
          'suggestedOrder',
          'suggestedDueDate',
        ],
      },
    },
    handbookReferences: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          excerptId: S('Id of a provided handbook excerpt, e.g. H2'),
          note: S('How this excerpt applies'),
        },
        required: ['excerptId', 'note'],
      },
    },
    risks: { type: 'ARRAY', items: S('A risk or common mistake to avoid') },
    confidence: { type: 'STRING', enum: [...CONFIDENCE] },
  },
  required: [
    'summary',
    'answer',
    'recommendations',
    'nextSteps',
    'taskSuggestions',
    'milestoneSuggestions',
    'handbookReferences',
    'risks',
    'confidence',
  ],
} as const;

export interface GuidanceRecommendation {
  title: string;
  detail: string;
  priority: (typeof PRIORITIES)[number];
}
export interface GuidanceTaskSuggestion {
  /** P16: stable id inside this answer (t1, t2, ...) used to apply the suggestion */
  id: string;
  title: string;
  description: string;
  priority: (typeof PRIORITIES)[number];
  estimatedDays: number | null;
  milestone: string | null;
}
export interface GuidanceMilestoneSuggestion {
  title: string;
  description: string;
  suggestedOrder: number;
  suggestedDueDate: string | null;
}
export interface GuidanceHandbookReference {
  excerptId: string;
  page: number;
  section: string | null;
  /** Taken from the real handbook text (never from the model) */
  quote: string;
  note: string;
}
export interface Guidance {
  summary: string;
  answer: string | null;
  recommendations: GuidanceRecommendation[];
  nextSteps: string[];
  taskSuggestions: GuidanceTaskSuggestion[];
  milestoneSuggestions: GuidanceMilestoneSuggestion[];
  handbookReferences: GuidanceHandbookReference[];
  risks: string[];
  confidence: (typeof CONFIDENCE)[number];
}

export class InvalidGuidanceError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidGuidanceError';
  }
}

const LIMITS = {
  summary: 1200,
  answer: 3000,
  title: 150,
  detail: 800,
  step: 400,
  note: 400,
  quote: 320,
  recommendations: 8,
  nextSteps: 10,
  tasks: 12,
  milestones: 8,
  references: 8,
  risks: 6,
};

/** Model text -> validated Guidance. Throws InvalidGuidanceError when unusable. */
export function parseGuidance(
  raw: string,
  excerpts: HandbookExcerpt[],
): Guidance {
  let data: unknown;
  try {
    data = JSON.parse(stripFences(raw));
  } catch {
    throw new InvalidGuidanceError('not JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new InvalidGuidanceError('not an object');
  }
  const d = data as Record<string, unknown>;
  const summary = text(d.summary, LIMITS.summary);
  if (!summary) throw new InvalidGuidanceError('summary missing');

  const byId = new Map(excerpts.map((e) => [e.id, e]));
  const seen = new Set<string>();
  const handbookReferences = list(d.handbookReferences, LIMITS.references * 2)
    .map((r) => {
      const ref = r as Record<string, unknown>;
      const id = text(ref?.excerptId, 10).toUpperCase();
      const excerpt = byId.get(id);
      // only excerpts that were really sent; the quote comes from the handbook itself
      if (!excerpt || seen.has(id)) return null;
      seen.add(id);
      return {
        excerptId: id,
        page: excerpt.page,
        section: excerpt.heading,
        quote: clip(excerpt.text, LIMITS.quote),
        note: text(ref.note, LIMITS.note),
      };
    })
    .filter((r): r is GuidanceHandbookReference => r !== null)
    .slice(0, LIMITS.references);

  return {
    summary,
    answer: text(d.answer, LIMITS.answer) || null,
    recommendations: list(d.recommendations, LIMITS.recommendations)
      .map((r) => {
        const x = r as Record<string, unknown>;
        const title = text(x?.title, LIMITS.title);
        if (!title) return null;
        return {
          title,
          detail: text(x.detail, LIMITS.detail),
          priority: oneOf(x.priority, PRIORITIES, 'MEDIUM'),
        };
      })
      .filter((r): r is GuidanceRecommendation => r !== null),
    nextSteps: list(d.nextSteps, LIMITS.nextSteps)
      .map((s) => text(s, LIMITS.step))
      .filter(Boolean),
    taskSuggestions: list(d.taskSuggestions, LIMITS.tasks)
      .map((t) => {
        const x = t as Record<string, unknown>;
        const title = text(x?.title, LIMITS.title);
        if (!title) return null;
        const days = Number(x.estimatedDays);
        return {
          id: '',
          title,
          description: text(x.description, LIMITS.detail),
          priority: oneOf(x.priority, PRIORITIES, 'MEDIUM'),
          estimatedDays:
            Number.isFinite(days) && days >= 0
              ? Math.min(60, Math.round(days))
              : null,
          milestone: text(x.milestone, LIMITS.title) || null,
        };
      })
      .filter((t): t is GuidanceTaskSuggestion => t !== null)
      .map((t, i) => ({ ...t, id: `t${i + 1}` })),
    milestoneSuggestions: list(d.milestoneSuggestions, LIMITS.milestones)
      .map((m, i) => {
        const x = m as Record<string, unknown>;
        const title = text(x?.title, LIMITS.title);
        if (!title) return null;
        const order = Number(x.suggestedOrder);
        const due = text(x.suggestedDueDate, 10);
        return {
          title,
          description: text(x.description, LIMITS.detail),
          suggestedOrder: Number.isInteger(order) && order > 0 ? order : i + 1,
          suggestedDueDate: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : null,
        };
      })
      .filter((m): m is GuidanceMilestoneSuggestion => m !== null),
    handbookReferences,
    risks: list(d.risks, LIMITS.risks)
      .map((s) => text(s, LIMITS.step))
      .filter(Boolean),
    confidence: oneOf(d.confidence, CONFIDENCE, 'MEDIUM'),
  };
}

function stripFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
}

function list(value: unknown, max: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // remove control characters; keep line breaks
  return clip(
    value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim(),
    max,
  );
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  const v = typeof value === 'string' ? (value.toUpperCase() as T) : fallback;
  return allowed.includes(v) ? v : fallback;
}
