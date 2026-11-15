import { AISupportCategory, AiRequestKind } from '@prisma/client';

/**
 * AI feature registry (P13). Every feature shares one pipeline:
 *   authorize -> limits -> project context -> handbook excerpts -> provider -> validated guidance
 * Adding a feature (e.g. Roadmap Generation) = adding an entry here (and enabling its
 * kind) — no change to the service, provider or storage. The seven-topic handbook summary
 * (stored as HANDBOOK_EXPLANATION) and the handbook task extraction (stored as TASK_BREAKDOWN)
 * have their own pipeline (HandbookSummaryService). TASK_BREAKDOWN is for students only:
 * supervisors never receive task suggestions. AI project-idea
 * evaluation was removed on purpose: Tammha does not evaluate or grade ideas.
 */
export interface AiFeature {
  kind: AiRequestKind;
  category: AISupportCategory;
  label: string;
  /** Task description for the model (what to produce, which fields to fill) */
  instructions: string;
  requiresQuestion: boolean;
  /** Refuse before calling the provider when no project (or university) handbook is READY */
  requiresHandbook: boolean;
  /** Extra terms (English + Arabic) used to find relevant handbook excerpts */
  handbookKeywords: string;
  /** Send the latest supervisor feedback comments (never scores) */
  includeFeedback: boolean;
  /** The feature accepts a milestone to focus on */
  acceptsMilestone: boolean;
}

const K = AiRequestKind;
const C = AISupportCategory;

export const AI_FEATURES: Partial<Record<AiRequestKind, AiFeature>> = {
  [K.PROJECT_QUESTION]: {
    kind: K.PROJECT_QUESTION,
    category: C.PROJECT_GUIDANCE,
    label: 'Project question',
    instructions:
      "Answer the requester's question about their graduation project in `answer` (clear, practical, " +
      'specific to this project). Add up to 5 recommendations or next steps only if they help. ' +
      'Use handbook excerpts when they are relevant and cite them.',
    requiresQuestion: true,
    requiresHandbook: false,
    handbookKeywords: '',
    includeFeedback: false,
    acceptsMilestone: false,
  },
  [K.NEXT_STEPS]: {
    kind: K.NEXT_STEPS,
    category: C.PROJECT_GUIDANCE,
    label: 'Suggested next steps',
    instructions:
      'Suggest the most valuable next steps for the coming 1-2 weeks, considering open and overdue tasks, ' +
      'upcoming milestones, document review statuses, readiness gaps and recent supervisor feedback. ' +
      'Fill `nextSteps` with 5-8 ordered, concrete items and `recommendations` with the reasoning. ' +
      'List risks (missed deadlines, missing required documents) in `risks`.',
    requiresQuestion: false,
    requiresHandbook: false,
    handbookKeywords:
      'deadline submission requirements proposal report milestone evaluation week موعد تسليم متطلبات مقترح تقرير تقييم',
    includeFeedback: true,
    acceptsMilestone: false,
  },
  [K.TASK_BREAKDOWN]: {
    kind: K.TASK_BREAKDOWN,
    category: C.TASK_PLANNING,
    label: 'Task breakdown',
    instructions:
      'Break the remaining work into concrete tasks in `taskSuggestions` (4-12 items) based on the project ' +
      'overview, objectives, category, origin, deadlines and handbook. Give each a priority, rough effort in ' +
      'days and the title of an existing milestone when relevant. Do not repeat tasks that already exist. ' +
      'If a focus milestone is given, break down only that milestone. These are suggestions: the team ' +
      'leader decides which tasks to create.',
    requiresQuestion: false,
    requiresHandbook: false,
    handbookKeywords:
      'report chapters implementation testing documentation requirements template deliverables تقرير فصول تنفيذ اختبار متطلبات',
    includeFeedback: false,
    acceptsMilestone: true,
  },
  [K.MILESTONE_GUIDANCE]: {
    kind: K.MILESTONE_GUIDANCE,
    category: C.TASK_PLANNING,
    label: 'Milestone guidance',
    instructions:
      'Review the milestone plan against the project dates and the handbook. Suggest missing, re-ordered or ' +
      're-timed milestones in `milestoneSuggestions` with suggested dates inside the project period, and ' +
      'explain timing in `recommendations`. If a focus milestone is given, concentrate on it.',
    requiresQuestion: false,
    requiresHandbook: false,
    handbookKeywords:
      'proposal deadline week semester submission presentation progress final report schedule مقترح موعد أسبوع الفصل الدراسي عرض تسليم',
    includeFeedback: false,
    acceptsMilestone: true,
  },
  [K.HANDBOOK_GUIDANCE]: {
    kind: K.HANDBOOK_GUIDANCE,
    category: C.DOCUMENTATION_HELP,
    label: 'Handbook guidance',
    instructions:
      'Explain what the project handbook requires for this project (deliverables, format, deadlines, ' +
      'evaluation, academic integrity) and how the project currently aligns. Every handbook-based statement ' +
      'must cite an excerpt in `handbookReferences`. Put gaps in `risks` and the fixes in `recommendations`. ' +
      'If a question is given, focus on it and answer it in `answer`.',
    requiresQuestion: false,
    requiresHandbook: true,
    handbookKeywords:
      'requirements report format template chapters pages deadline submission evaluation grading percent presentation plagiarism integrity proposal ' +
      'متطلبات تقرير تنسيق قالب فصول تسليم موعد تقييم درجات عرض انتحال نزاهة مقترح',
    includeFeedback: false,
    acceptsMilestone: false,
  },
  // Reserved for a later stage (enum value already exists): ROADMAP_GENERATION
};

export const ACTIVE_AI_KINDS = Object.keys(AI_FEATURES) as AiRequestKind[];
