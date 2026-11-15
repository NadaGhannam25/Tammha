import {
  DocumentCategory,
  MilestoneStatus,
  SubmissionStatus,
  TaskStatus,
} from '@prisma/client';

/**
 * Project Progress and Project Readiness — deterministic, rule-based calculations.
 *
 * Pure functions only: the same numbers always give the same result, every point
 * is explained, and no AI model is involved. Inputs come from aggregate counts
 * (see ProjectMetricsService), so a dashboard never loads individual rows to score.
 */

export const PROGRESS_VERSION = 'progress-v1';
export const READINESS_VERSION = 'readiness-v1';

/** Default required documents (override with REQUIRED_DOCUMENT_CATEGORIES). */
export const DEFAULT_REQUIRED_DOCUMENT_CATEGORIES: DocumentCategory[] = [
  DocumentCategory.PROPOSAL,
  DocumentCategory.REPORT,
  DocumentCategory.PRESENTATION,
];

export const OPEN_TASK_STATUSES: TaskStatus[] = [
  TaskStatus.TODO,
  TaskStatus.IN_PROGRESS,
  TaskStatus.IN_REVIEW,
  TaskStatus.BLOCKED,
];
export const CLOSED_MILESTONE_STATUSES: MilestoneStatus[] = [
  MilestoneStatus.COMPLETED,
  MilestoneStatus.CANCELLED,
];
/** Waiting for the supervisor. */
export const AWAITING_REVIEW_STATUSES: SubmissionStatus[] = [
  SubmissionStatus.SUBMITTED,
  SubmissionStatus.UNDER_REVIEW,
];
/** Supervisor asked for changes: open until the students upload a new version. */
export const NEEDS_CHANGES_STATUSES: SubmissionStatus[] = [
  SubmissionStatus.CHANGES_REQUESTED,
  SubmissionStatus.REJECTED,
];

/** When a category has several documents, the most advanced status represents it. */
const STATUS_RANK: SubmissionStatus[] = [
  SubmissionStatus.APPROVED,
  SubmissionStatus.UNDER_REVIEW,
  SubmissionStatus.SUBMITTED,
  SubmissionStatus.UPLOADED,
  SubmissionStatus.CHANGES_REQUESTED,
  SubmissionStatus.REJECTED,
];

// ---------------------------------------------------------------------------
// Input: aggregate counts for one project
// ---------------------------------------------------------------------------

export interface WorkCounts {
  /** All items except CANCELLED */
  total: number;
  completed: number;
  open: number;
  overdue: number;
  cancelled: number;
}

export interface ProjectStats {
  tasks: WorkCounts & { byStatus: Record<TaskStatus, number> };
  milestones: WorkCounts;
  documents: {
    total: number;
    byStatus: Record<SubmissionStatus, number>;
    /** category -> status -> count */
    byCategory: Partial<
      Record<DocumentCategory, Partial<Record<SubmissionStatus, number>>>
    >;
  };
}

export function emptyStats(): ProjectStats {
  const work = (): WorkCounts => ({
    total: 0,
    completed: 0,
    open: 0,
    overdue: 0,
    cancelled: 0,
  });
  return {
    tasks: {
      ...work(),
      byStatus: Object.fromEntries(
        Object.values(TaskStatus).map((s) => [s, 0]),
      ) as Record<TaskStatus, number>,
    },
    milestones: work(),
    documents: {
      total: 0,
      byStatus: Object.fromEntries(
        Object.values(SubmissionStatus).map((s) => [s, 0]),
      ) as Record<SubmissionStatus, number>,
      byCategory: {},
    },
  };
}

// ---------------------------------------------------------------------------
// Required documents
// ---------------------------------------------------------------------------

export type RequiredDocumentState = SubmissionStatus | 'MISSING';

export interface RequiredDocumentStatus {
  category: DocumentCategory;
  status: RequiredDocumentState;
  documentCount: number;
}

export function requiredDocumentStatuses(
  stats: ProjectStats,
  required: DocumentCategory[],
): RequiredDocumentStatus[] {
  return required.map((category) => {
    const counts = stats.documents.byCategory[category] ?? {};
    const documentCount = Object.values(counts).reduce(
      (sum, n) => sum + (n ?? 0),
      0,
    );
    const best = STATUS_RANK.find((s) => (counts[s] ?? 0) > 0);
    return { category, status: best ?? 'MISSING', documentCount };
  });
}

/**
 * REQUIRED_DOCUMENT_CATEGORIES: comma-separated DocumentCategory values.
 * Empty / unset -> defaults. Returns an error message for invalid input.
 */
export function parseRequiredDocumentCategories(
  raw: string | undefined | null,
): { categories: DocumentCategory[]; error?: string } {
  const text = (raw ?? '').trim();
  if (!text) return { categories: [...DEFAULT_REQUIRED_DOCUMENT_CATEGORIES] };
  const items = text
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const valid = Object.values(DocumentCategory) as string[];
  const invalid = items.filter((i) => !valid.includes(i));
  if (items.length === 0 || invalid.length > 0) {
    return {
      categories: [...DEFAULT_REQUIRED_DOCUMENT_CATEGORIES],
      error: `REQUIRED_DOCUMENT_CATEGORIES must be a comma-separated list of: ${valid.join(', ')}`,
    };
  }
  return { categories: [...new Set(items)] as DocumentCategory[] };
}

// ---------------------------------------------------------------------------
// Progress (how much of the planned work is done)
// ---------------------------------------------------------------------------

export const PROGRESS_WEIGHTS = {
  TASKS: 50,
  MILESTONES: 30,
  REQUIRED_DOCUMENTS_APPROVED: 20,
} as const;

export interface ProgressComponent {
  key: keyof typeof PROGRESS_WEIGHTS;
  label: string;
  weight: number;
  /** Weight after leaving out empty components (sums to 100) */
  effectiveWeight: number;
  done: number;
  total: number;
  percent: number;
  /** Points this component adds to the overall percent */
  contribution: number;
  included: boolean;
}

export interface ProgressResult {
  percent: number;
  components: ProgressComponent[];
  formula: string;
  version: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function calculateProgress(
  stats: ProjectStats,
  required: DocumentCategory[],
): ProgressResult {
  const approvedRequired = requiredDocumentStatuses(stats, required).filter(
    (d) => d.status === SubmissionStatus.APPROVED,
  ).length;

  const raw = [
    {
      key: 'TASKS' as const,
      label: 'Completed tasks',
      done: stats.tasks.completed,
      total: stats.tasks.total,
    },
    {
      key: 'MILESTONES' as const,
      label: 'Completed milestones',
      done: stats.milestones.completed,
      total: stats.milestones.total,
    },
    {
      key: 'REQUIRED_DOCUMENTS_APPROVED' as const,
      label: 'Approved required documents',
      done: approvedRequired,
      total: required.length,
    },
  ];

  // A component with nothing planned (e.g. no milestones yet) is left out and the
  // other weights are scaled up, so an unused feature does not block progress.
  const includedWeight = raw
    .filter((c) => c.total > 0)
    .reduce((sum, c) => sum + PROGRESS_WEIGHTS[c.key], 0);

  const components: ProgressComponent[] = raw.map((c) => {
    const weight = PROGRESS_WEIGHTS[c.key];
    const included = c.total > 0 && includedWeight > 0;
    const ratio = c.total > 0 ? c.done / c.total : 0;
    const effectiveWeight = included ? (weight / includedWeight) * 100 : 0;
    return {
      ...c,
      weight,
      effectiveWeight: round1(effectiveWeight),
      percent: Math.round(ratio * 100),
      contribution: round1(effectiveWeight * ratio),
      included,
    };
  });

  const exact = components.reduce(
    (sum, c) =>
      sum +
      (c.included
        ? (PROGRESS_WEIGHTS[c.key] / includedWeight) * 100 * (c.done / c.total)
        : 0),
    0,
  );

  return {
    percent: Math.min(100, Math.round(exact)),
    components,
    formula:
      'percent = sum(weight x done/total) over components that have items; ' +
      'weights: tasks 50, milestones 30, approved required documents 20 (cancelled items excluded)',
    version: PROGRESS_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Readiness (is the project ready for final submission / defense?)
// ---------------------------------------------------------------------------

export const READINESS_WEIGHTS = {
  TASKS_COMPLETED: 25,
  MILESTONES_COMPLETED: 20,
  REQUIRED_DOCUMENTS_SUBMITTED: 15,
  REQUIRED_DOCUMENTS_APPROVED: 25,
  FEEDBACK_ADDRESSED: 10,
  NO_OVERDUE_WORK: 5,
} as const;

export type ReadinessKey = keyof typeof READINESS_WEIGHTS;
export type ReadinessLevel =
  'NOT_READY' | 'IN_PROGRESS' | 'ALMOST_READY' | 'READY';

export interface ReadinessCriterion {
  key: ReadinessKey;
  label: string;
  weight: number;
  /** 0..1 share of the criterion that is fulfilled */
  ratio: number;
  points: number;
  met: boolean;
  detail: string;
  /** What to do next (null when met) */
  action: string | null;
}

export interface ReadinessResult {
  score: number;
  level: ReadinessLevel;
  criteria: ReadinessCriterion[];
  missing: string[];
  requiredDocuments: RequiredDocumentStatus[];
  method: 'RULE_BASED';
  aiUsed: false;
  version: string;
  levels: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function calculateReadiness(
  stats: ProjectStats,
  required: DocumentCategory[],
): ReadinessResult {
  const docs = requiredDocumentStatuses(stats, required);
  const missingDocs = docs.filter((d) => d.status === 'MISSING');
  const notApproved = docs.filter(
    (d) => d.status !== SubmissionStatus.APPROVED,
  );
  const needsChanges = NEEDS_CHANGES_STATUSES.reduce(
    (sum, s) => sum + stats.documents.byStatus[s],
    0,
  );
  const overdue = stats.tasks.overdue + stats.milestones.overdue;

  const ratio = (done: number, total: number) => (total > 0 ? done / total : 0);

  const criteria: Omit<ReadinessCriterion, 'weight' | 'points'>[] = [
    {
      key: 'TASKS_COMPLETED',
      label: 'All tasks completed',
      ratio: ratio(stats.tasks.completed, stats.tasks.total),
      met: stats.tasks.total > 0 && stats.tasks.open === 0,
      detail:
        stats.tasks.total === 0
          ? 'No tasks have been created yet'
          : `${stats.tasks.completed} of ${plural(stats.tasks.total, 'task')} completed`,
      action:
        stats.tasks.total === 0
          ? 'Plan the project work as tasks'
          : `Complete ${plural(stats.tasks.open, 'remaining task')}`,
    },
    {
      key: 'MILESTONES_COMPLETED',
      label: 'All milestones completed',
      ratio: ratio(stats.milestones.completed, stats.milestones.total),
      met: stats.milestones.total > 0 && stats.milestones.open === 0,
      detail:
        stats.milestones.total === 0
          ? 'No milestones have been created yet'
          : `${stats.milestones.completed} of ${plural(stats.milestones.total, 'milestone')} completed`,
      action:
        stats.milestones.total === 0
          ? 'Add the project milestones'
          : `Complete ${plural(stats.milestones.open, 'remaining milestone')}`,
    },
    {
      key: 'REQUIRED_DOCUMENTS_SUBMITTED',
      label: 'Required documents submitted',
      ratio: ratio(docs.length - missingDocs.length, docs.length),
      met: missingDocs.length === 0,
      detail: `${docs.length - missingDocs.length} of ${docs.length} required documents uploaded`,
      action: `Upload: ${missingDocs.map((d) => d.category).join(', ')}`,
    },
    {
      key: 'REQUIRED_DOCUMENTS_APPROVED',
      label: 'Required documents approved by the supervisor',
      ratio: ratio(docs.length - notApproved.length, docs.length),
      met: notApproved.length === 0,
      detail: `${docs.length - notApproved.length} of ${docs.length} required documents approved`,
      action: `Get supervisor approval for: ${notApproved.map((d) => d.category).join(', ')}`,
    },
    {
      key: 'FEEDBACK_ADDRESSED',
      label: 'Supervisor change requests addressed',
      // Each document with requested changes or a rejection is an open item until a new
      // version is uploaded (P08 resets it to SUBMITTED).
      ratio:
        needsChanges === 0
          ? 1
          : ratio(stats.documents.total - needsChanges, stats.documents.total),
      met: needsChanges === 0,
      detail:
        needsChanges === 0
          ? 'No open change requests'
          : `${plural(needsChanges, 'document')} with requested changes or rejected`,
      action: `Upload a new version of ${plural(needsChanges, 'document')} with requested changes`,
    },
    {
      key: 'NO_OVERDUE_WORK',
      label: 'No overdue tasks or milestones',
      ratio: overdue === 0 ? 1 : 0,
      met: overdue === 0,
      detail:
        overdue === 0
          ? 'Nothing is overdue'
          : `${plural(stats.tasks.overdue, 'overdue task')}, ${plural(stats.milestones.overdue, 'overdue milestone')}`,
      action: 'Finish or reschedule the overdue items',
    },
  ];

  const scored: ReadinessCriterion[] = criteria.map((c) => {
    const weight = READINESS_WEIGHTS[c.key];
    return {
      ...c,
      ratio: round1(c.ratio * 100) / 100,
      weight,
      points: round1(weight * c.ratio),
      action: c.met ? null : c.action,
    };
  });
  const exact = criteria.reduce(
    (sum, c) => sum + READINESS_WEIGHTS[c.key] * c.ratio,
    0,
  );
  const allMet = scored.every((c) => c.met);
  const score = allMet ? 100 : Math.min(99, Math.round(exact));

  return {
    score,
    level: allMet
      ? 'READY'
      : score >= 80
        ? 'ALMOST_READY'
        : score >= 40
          ? 'IN_PROGRESS'
          : 'NOT_READY',
    criteria: scored,
    missing: scored.filter((c) => !c.met).map((c) => c.action!),
    requiredDocuments: docs,
    method: 'RULE_BASED',
    aiUsed: false,
    version: READINESS_VERSION,
    levels:
      'READY = every criterion met (score 100); ALMOST_READY >= 80; IN_PROGRESS >= 40; NOT_READY < 40',
  };
}
