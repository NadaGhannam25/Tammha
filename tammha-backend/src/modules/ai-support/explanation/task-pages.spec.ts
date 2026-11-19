import { taskPagesForPrompt } from './handbook-summary.schema';

describe('taskPagesForPrompt (pages sent for task extraction)', () => {
  const text = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].join('\f');

  it('sends only the pages the summary cites and the pages around them', () => {
    const r = taskPagesForPrompt(text, [1, 5], 10_000);
    expect(r.pages.map((p) => p.page)).toEqual([1, 2, 4, 5, 6]);
    expect(r.pageCount).toBe(6);
    expect(r.truncated).toBe(true);
  });

  it('without a summary, sends the first pages up to the limit', () => {
    const r = taskPagesForPrompt(text, [], 10_000);
    expect(r.pages.map((p) => p.page)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.truncated).toBe(false);
  });

  it('ignores page numbers that do not exist', () => {
    const r = taskPagesForPrompt(text, [99], 10_000);
    expect(r.pages.map((p) => p.page)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
