import {
  buildSummaryPrompt,
  HANDBOOK_TOPICS,
  handbookPagesForPrompt,
  InvalidExplanationError,
  normalizeForMatch,
  parseHandbookTasks,
  parseSummary,
} from './handbook-summary.schema';

const PAGES = [
  { page: 1, text: 'دليل مشروع التخرج يوضح متطلبات المشروع.' },
  { page: 2, text: 'The final report must not exceed 80 pages.' },
  {
    page: 3,
    text: 'Weekly reports are submitted every Sunday by the team leader.',
  },
];

describe('handbook summary schema', () => {
  it('the seven topic ids and titles are fixed', () => {
    expect(HANDBOOK_TOPICS.map((t) => t.id)).toEqual([
      'OVERVIEW',
      'REPORT_STRUCTURE',
      'GRADING',
      'SUBMISSION',
      'PROPOSAL',
      'WEEKLY_REPORTS',
      'FINAL_DEFENSE',
    ]);
    expect(HANDBOOK_TOPICS.map((t) => t.ar)).toEqual([
      'نبذة عن الدليل',
      'هيكل تقرير مشروع التخرج',
      'توزيع الدرجات ومعايير التقييم',
      'متطلبات التسليم',
      'مقترح المشروع (Proposal)',
      'التقارير الأسبوعية',
      'المناقشة النهائية',
    ]);
  });

  it('returns all seven topics in order, missing ones as not found', () => {
    const out = parseSummary(
      JSON.stringify({
        topics: [
          {
            id: 'WEEKLY_REPORTS',
            found: true,
            summary: 'Every Sunday.',
            points: [
              {
                text: 'Weekly',
                pages: [1],
                quote: 'Weekly reports are submitted every Sunday',
              },
            ],
          },
          {
            id: 'OVERVIEW',
            found: true,
            summary: 'Overview',
            points: [
              {
                text: 'Arabic quote',
                pages: [1],
                quote: 'دليل مشروع التخرج يوضح',
              },
            ],
          },
          { id: 'OVERVIEW', found: false, summary: '', points: [] }, // duplicate ignored
        ],
      }),
      PAGES,
    );
    expect(out.topics.map((t) => t.id)).toEqual(
      HANDBOOK_TOPICS.map((t) => t.id),
    );
    expect(out.topics[0]).toMatchObject({
      found: true,
      points: [{ pages: [1], verified: true }],
    });
    // page corrected from 1 to 3
    expect(out.topics[5].points[0]).toMatchObject({
      pages: [3],
      verified: true,
    });
    expect(out.topics.filter((t) => t.found)).toHaveLength(2);
    expect(out.stats).toEqual({
      topics: 7,
      foundTopics: 2,
      points: 2,
      verifiedPoints: 2,
    });
  });

  it('malformed answers are refused', () => {
    expect(() => parseSummary('not json', PAGES)).toThrow(
      InvalidExplanationError,
    );
    expect(() => parseSummary('{"sections": []}', PAGES)).toThrow(
      InvalidExplanationError,
    );
    expect(() =>
      parseSummary('```json\n{"topics": []}\n```', PAGES),
    ).not.toThrow();
  });

  it('task extraction keeps only verifiable, new tasks', () => {
    const { suggestions, dropped } = parseHandbookTasks(
      JSON.stringify({
        tasks: [
          {
            title: 'Limit the report length',
            description: 'x',
            priority: 'URGENT',
            estimatedDays: 0,
            pages: [2],
            quote: 'final report must not exceed 80 pages',
          },
          {
            title: 'Invented',
            description: 'x',
            priority: 'LOW',
            estimatedDays: 2,
            pages: [2],
            quote: 'publish three journal papers',
          },
          {
            title: 'Send weekly reports',
            description: 'x',
            priority: 'LOW',
            estimatedDays: 2,
            pages: [3],
            quote: 'Weekly reports are submitted every Sunday',
          },
        ],
      }),
      PAGES,
      ['send   WEEKLY reports'],
    );
    expect(suggestions).toEqual([
      expect.objectContaining({
        id: 't1',
        title: 'Limit the report length',
        priority: 'MEDIUM',
        estimatedDays: null,
        pages: [2],
      }),
    ]);
    expect(dropped).toEqual({ unverified: 1, duplicates: 1 });
    expect(() => parseHandbookTasks('[]', PAGES, [])).toThrow(
      InvalidExplanationError,
    );
  });

  it('prompt helpers', () => {
    expect(normalizeForMatch('الإدارةُ  والمكتبة!')).toBe('الاداره والمكتبه');
    const { pages, truncated } = handbookPagesForPrompt('a\fbb\fccc', 3);
    expect(pages.map((p) => p.page)).toEqual([1, 2]);
    expect(truncated).toBe(true);
    const prompt = buildSummaryPrompt({
      title: 'H',
      language: 'ar',
      pages,
      truncated,
    });
    expect(prompt.startsWith('TASK: HANDBOOK SUMMARY')).toBe(true);
    expect(prompt).toContain('in Arabic');
    expect(prompt).toContain('[Page 2]');
  });
});
