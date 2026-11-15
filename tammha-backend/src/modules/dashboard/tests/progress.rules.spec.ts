import {
  calculateProgress,
  calculateReadiness,
  DEFAULT_REQUIRED_DOCUMENT_CATEGORIES,
  emptyStats,
  parseRequiredDocumentCategories,
  ProjectStats,
  requiredDocumentStatuses,
} from '../progress/progress.rules';

const REQUIRED = DEFAULT_REQUIRED_DOCUMENT_CATEGORIES; // PROPOSAL, REPORT, PRESENTATION

function stats(fill: (s: ProjectStats) => void): ProjectStats {
  const s = emptyStats();
  fill(s);
  return s;
}
function addDoc(s: ProjectStats, category: string, status: string, n = 1) {
  const cat = ((s.documents.byCategory as any)[category] ??= {});
  cat[status] = (cat[status] ?? 0) + n;
  (s.documents.byStatus as any)[status] += n;
  s.documents.total += n;
}
const work = (total: number, completed: number, overdue = 0) => ({
  total,
  completed,
  open: total - completed,
  overdue,
  cancelled: 0,
});

describe('Project progress (deterministic)', () => {
  it('a new project with nothing done is 0%', () => {
    const p = calculateProgress(emptyStats(), REQUIRED);
    expect(p.percent).toBe(0);
    // empty tasks/milestones are left out; required documents always count
    expect(p.components.map((c) => [c.key, c.included])).toEqual([
      ['TASKS', false],
      ['MILESTONES', false],
      ['REQUIRED_DOCUMENTS_APPROVED', true],
    ]);
  });

  it('weights 50/30/20 with every component in use', () => {
    const s = stats((s) => {
      Object.assign(s.tasks, work(10, 5)); // 50%
      Object.assign(s.milestones, work(4, 1)); // 25%
      addDoc(s, 'PROPOSAL', 'APPROVED'); // 1/3 approved
      addDoc(s, 'REPORT', 'UNDER_REVIEW');
    });
    const p = calculateProgress(s, REQUIRED);
    // 50*0.5 + 30*0.25 + 20*(1/3) = 25 + 7.5 + 6.67 = 39.17
    expect(p.percent).toBe(39);
    expect(p.components.map((c) => c.contribution)).toEqual([25, 7.5, 6.7]);
    expect(p.components.map((c) => c.effectiveWeight)).toEqual([50, 30, 20]);
  });

  it('a component without items is left out and the others are scaled', () => {
    const s = stats((s) => Object.assign(s.tasks, work(4, 4))); // no milestones
    const p = calculateProgress(s, REQUIRED);
    // tasks 50/70 of 100 = 71.4 points, documents 20/70 = 28.6 points x 0
    expect(p.percent).toBe(71);
    expect(p.components[0].effectiveWeight).toBe(71.4);
    expect(p.components[1].included).toBe(false);
  });

  it('everything done = 100%', () => {
    const s = stats((s) => {
      Object.assign(s.tasks, work(3, 3));
      Object.assign(s.milestones, work(2, 2));
      for (const c of REQUIRED) addDoc(s, c, 'APPROVED');
    });
    expect(calculateProgress(s, REQUIRED).percent).toBe(100);
  });

  it('same input, same output', () => {
    const s = stats((s) => Object.assign(s.tasks, work(7, 3)));
    expect(calculateProgress(s, REQUIRED)).toEqual(
      calculateProgress(s, REQUIRED),
    );
  });
});

describe('Project readiness (rule-based, explainable)', () => {
  const ready = () =>
    stats((s) => {
      Object.assign(s.tasks, work(5, 5));
      Object.assign(s.milestones, work(3, 3));
      for (const c of REQUIRED) addDoc(s, c, 'APPROVED');
    });

  it('empty project: NOT_READY, only the "nothing to fix" rules score', () => {
    const r = calculateReadiness(emptyStats(), REQUIRED);
    // FEEDBACK_ADDRESSED (10) + NO_OVERDUE_WORK (5)
    expect(r.score).toBe(15);
    expect(r.level).toBe('NOT_READY');
    expect(r.aiUsed).toBe(false);
    expect(r.method).toBe('RULE_BASED');
    expect(r.missing).toEqual([
      'Plan the project work as tasks',
      'Add the project milestones',
      'Upload: PROPOSAL, REPORT, PRESENTATION',
      'Get supervisor approval for: PROPOSAL, REPORT, PRESENTATION',
    ]);
  });

  it('weights add up to 100 and every criterion explains itself', () => {
    const r = calculateReadiness(ready(), REQUIRED);
    expect(r.criteria.reduce((sum, c) => sum + c.weight, 0)).toBe(100);
    expect(r.criteria.every((c) => c.detail.length > 0)).toBe(true);
  });

  it('all criteria met: READY with score 100 and no next steps', () => {
    const r = calculateReadiness(ready(), REQUIRED);
    expect(r).toMatchObject({ score: 100, level: 'READY', missing: [] });
    expect(r.criteria.every((c) => c.met && c.action === null)).toBe(true);
  });

  it('an open change request blocks READY and is explained', () => {
    const s = ready();
    addDoc(s, 'DESIGN', 'CHANGES_REQUESTED');
    const r = calculateReadiness(s, REQUIRED);
    const c = r.criteria.find((x) => x.key === 'FEEDBACK_ADDRESSED')!;
    expect(c).toMatchObject({
      met: false,
      detail: '1 document with requested changes or rejected',
    });
    // 4 docs, 1 needs changes -> 10 * 3/4 = 7.5 points
    expect(c.points).toBe(7.5);
    expect(r.level).toBe('ALMOST_READY');
    expect(r.score).toBe(98); // 97.5 rounded, never 100 unless READY
  });

  it('overdue work removes the 5 points', () => {
    const s = ready();
    s.tasks.overdue = 0;
    s.milestones.overdue = 1;
    s.milestones.open = 1;
    s.milestones.completed = 2;
    const r = calculateReadiness(s, REQUIRED);
    const c = r.criteria.find((x) => x.key === 'NO_OVERDUE_WORK')!;
    expect(c).toMatchObject({ met: false, points: 0 });
    expect(c.detail).toBe('0 overdue tasks, 1 overdue milestone');
  });

  it('partial credit is proportional', () => {
    const s = stats((s) => {
      Object.assign(s.tasks, work(4, 2)); // 25 * 0.5 = 12.5
      Object.assign(s.milestones, work(2, 1)); // 20 * 0.5 = 10
      addDoc(s, 'PROPOSAL', 'APPROVED'); // submitted 15*1/3=5, approved 25*1/3=8.33
      addDoc(s, 'REPORT', 'SUBMITTED'); // submitted -> 15*2/3=10
    });
    const r = calculateReadiness(s, REQUIRED);
    const points = Object.fromEntries(r.criteria.map((c) => [c.key, c.points]));
    expect(points).toEqual({
      TASKS_COMPLETED: 12.5,
      MILESTONES_COMPLETED: 10,
      REQUIRED_DOCUMENTS_SUBMITTED: 10,
      REQUIRED_DOCUMENTS_APPROVED: 8.3,
      FEEDBACK_ADDRESSED: 10,
      NO_OVERDUE_WORK: 5,
    });
    expect(r.score).toBe(56); // 55.83
    expect(r.level).toBe('IN_PROGRESS');
  });
});

describe('Required documents', () => {
  it('the most advanced status represents a category', () => {
    const s = stats((s) => {
      addDoc(s, 'REPORT', 'REJECTED');
      addDoc(s, 'REPORT', 'UNDER_REVIEW');
      addDoc(s, 'PROPOSAL', 'CHANGES_REQUESTED');
    });
    expect(requiredDocumentStatuses(s, REQUIRED)).toEqual([
      { category: 'PROPOSAL', status: 'CHANGES_REQUESTED', documentCount: 1 },
      { category: 'REPORT', status: 'UNDER_REVIEW', documentCount: 2 },
      { category: 'PRESENTATION', status: 'MISSING', documentCount: 0 },
    ]);
  });

  it('REQUIRED_DOCUMENT_CATEGORIES parsing', () => {
    expect(parseRequiredDocumentCategories('').categories).toEqual(REQUIRED);
    expect(parseRequiredDocumentCategories(undefined).categories).toEqual(
      REQUIRED,
    );
    expect(
      parseRequiredDocumentCategories(' report, code ,REPORT').categories,
    ).toEqual(['REPORT', 'CODE']);
    expect(parseRequiredDocumentCategories('REPORT,THESIS').error).toMatch(
      /REQUIRED_DOCUMENT_CATEGORIES/,
    );
    expect(parseRequiredDocumentCategories(' , ').error).toBeDefined();
  });
});
