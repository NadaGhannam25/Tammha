import {
  DocumentCategory,
  FeedbackCategory,
  MilestoneStatus,
  Priority,
  ProjectCategory,
  ProjectOrigin,
  ProjectStatus,
  SubmissionStatus,
  TaskStatus,
} from '@prisma/client';

/**
 * ONE vocabulary for statuses and classifications, shared with the frontend
 * (GET /reference/values; mirrored in the frontend's domain.js). Codes are the database
 * enum values; labels are for display only (Arabic first, English second).
 *
 * Derived states are NOT stored statuses: "overdue" = an open task / stage past its due
 * date (computed), "due soon" = due within 24 hours.
 */
export type Label = { ar: string; en: string };

export const TASK_STATUS_LABELS: Record<TaskStatus, Label> = {
  TODO: { ar: 'لم تبدأ', en: 'To do' },
  IN_PROGRESS: { ar: 'قيد التنفيذ', en: 'In progress' },
  IN_REVIEW: { ar: 'قيد المراجعة', en: 'In review' },
  BLOCKED: { ar: 'متوقفة', en: 'Blocked' },
  COMPLETED: { ar: 'مكتملة', en: 'Completed' },
  CANCELLED: { ar: 'ملغاة', en: 'Cancelled' },
};

/**
 * Valid task status changes. Members (on their own tasks) and the leader follow it;
 * cancelling and restoring a cancelled task is for the team leader only.
 */
export const TASK_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  TODO: ['IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'CANCELLED'],
  IN_PROGRESS: ['TODO', 'IN_REVIEW', 'BLOCKED', 'COMPLETED', 'CANCELLED'],
  IN_REVIEW: ['IN_PROGRESS', 'COMPLETED', 'BLOCKED', 'CANCELLED'],
  BLOCKED: ['TODO', 'IN_PROGRESS', 'CANCELLED'],
  COMPLETED: ['IN_PROGRESS', 'IN_REVIEW', 'TODO'],
  CANCELLED: ['TODO'],
};
export const LEADER_ONLY_TASK_STATUSES: TaskStatus[] = ['CANCELLED'];

export function canChangeTaskStatus(
  from: TaskStatus,
  to: TaskStatus,
  isLeader: boolean,
): boolean {
  if (from === to) return true;
  if (!TASK_STATUS_TRANSITIONS[from].includes(to)) return false;
  if (
    !isLeader &&
    (LEADER_ONLY_TASK_STATUSES.includes(to) ||
      LEADER_ONLY_TASK_STATUSES.includes(from))
  ) {
    return false;
  }
  return true;
}

export const PRIORITY_LABELS: Record<Priority, Label> = {
  LOW: { ar: 'منخفضة', en: 'Low' },
  MEDIUM: { ar: 'متوسطة', en: 'Medium' },
  HIGH: { ar: 'عالية', en: 'High' },
  CRITICAL: { ar: 'حرجة', en: 'Critical' },
};

/** Project stages = milestones. OVERDUE is set by nobody: it is computed. */
export const STAGE_STATUS_LABELS: Record<MilestoneStatus, Label> = {
  PENDING: { ar: 'لم تبدأ', en: 'Not started' },
  IN_PROGRESS: { ar: 'جارية', en: 'In progress' },
  COMPLETED: { ar: 'مكتملة', en: 'Completed' },
  OVERDUE: { ar: 'متأخرة', en: 'Overdue' },
  CANCELLED: { ar: 'ملغاة', en: 'Cancelled' },
};

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, Label> = {
  PLANNING: { ar: 'التخطيط', en: 'Planning' },
  IN_PROGRESS: { ar: 'قيد التنفيذ', en: 'In progress' },
  REVIEW: { ar: 'المراجعة النهائية', en: 'Final review' },
  COMPLETED: { ar: 'مكتمل', en: 'Completed' },
  ARCHIVED: { ar: 'مؤرشف', en: 'Archived' },
};

/** Document review (submission) status. Only the supervisor records decisions. */
export const DOCUMENT_STATUS_LABELS: Record<SubmissionStatus, Label> = {
  UPLOADED: { ar: 'مرفوع', en: 'Uploaded' },
  SUBMITTED: { ar: 'بانتظار المراجعة', en: 'Submitted for review' },
  UNDER_REVIEW: { ar: 'قيد المراجعة', en: 'Under review' },
  CHANGES_REQUESTED: { ar: 'مطلوب تعديل', en: 'Changes requested' },
  APPROVED: { ar: 'معتمد', en: 'Approved' },
  REJECTED: { ar: 'مرفوض', en: 'Rejected' },
};

export const PROJECT_CATEGORY_LABELS: Record<ProjectCategory, Label> = {
  TECHNOLOGY: { ar: 'تقنية', en: 'Technology' },
  EDUCATION: { ar: 'تعليم', en: 'Education' },
  HEALTH: { ar: 'صحة', en: 'Health' },
  MEDICAL: { ar: 'طبي', en: 'Medical' },
  BUSINESS: { ar: 'أعمال', en: 'Business' },
  ENGINEERING: { ar: 'هندسة', en: 'Engineering' },
  OTHER: { ar: 'أخرى', en: 'Other' },
};

export const PROJECT_ORIGIN_LABELS: Record<ProjectOrigin, Label> = {
  NEW: { ar: 'فكرة جديدة', en: 'New idea' },
  CONTINUATION: { ar: 'استكمال لمشروع سابق', en: 'Continuation' },
  PREVIOUSLY_IMPLEMENTED: { ar: 'إعادة تنفيذ', en: 'Re-implementation' },
};

export const DOCUMENT_CATEGORY_LABELS: Record<DocumentCategory, Label> = {
  GENERAL: { ar: 'عام', en: 'General' },
  PROPOSAL: { ar: 'مقترح', en: 'Proposal' },
  REPORT: { ar: 'تقرير', en: 'Report' },
  PRESENTATION: { ar: 'عرض تقديمي', en: 'Presentation' },
  DESIGN: { ar: 'تصميم', en: 'Design' },
  CODE: { ar: 'شيفرة برمجية', en: 'Code' },
  DOCUMENTATION: { ar: 'توثيق', en: 'Documentation' },
  MEETING_NOTES: { ar: 'محضر اجتماع', en: 'Meeting notes' },
  OTHER: { ar: 'أخرى', en: 'Other' },
};

export const FEEDBACK_CATEGORY_LABELS: Record<FeedbackCategory, Label> = {
  GENERAL: { ar: 'عامة', en: 'General' },
  TECHNICAL_SKILLS: { ar: 'تقنية', en: 'Technical' },
  COMMUNICATION: { ar: 'تواصل', en: 'Communication' },
  COLLABORATION: { ar: 'عمل جماعي', en: 'Collaboration' },
  LEADERSHIP: { ar: 'قيادة', en: 'Leadership' },
  PERFORMANCE: { ar: 'سير العمل', en: 'Progress' },
};
