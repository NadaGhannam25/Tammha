// ===== Tammha domain vocabulary (frontend mirror of the backend) =====
// ONE list of statuses and classifications for every page. Codes are the backend's
// database values (GET /api/v1/reference/values returns the same lists); labels are
// [Arabic, English]. Pages show labels, keep codes in their data, and never invent
// their own status keys.
//
// Derived states are NOT statuses: "overdue" = an open task / stage whose due date has
// passed; "due soon" = an open task due within 24 hours.
(function () {
  'use strict';

  const TASK_STATUSES = {
    TODO: { label: ['لم تبدأ', 'To do'], cls: 'idle' },
    IN_PROGRESS: { label: ['قيد التنفيذ', 'In progress'], cls: 'progress' },
    IN_REVIEW: { label: ['قيد المراجعة', 'In review'], cls: 'review' },
    BLOCKED: { label: ['متوقفة', 'Blocked'], cls: 'blocked' },
    COMPLETED: { label: ['مكتملة', 'Completed'], cls: 'completed' },
    CANCELLED: { label: ['ملغاة', 'Cancelled'], cls: 'cancelled' }
  };
  // Valid status changes (same table as the backend). Cancelling / restoring = team leader only.
  const TASK_TRANSITIONS = {
    TODO: ['IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'CANCELLED'],
    IN_PROGRESS: ['TODO', 'IN_REVIEW', 'BLOCKED', 'COMPLETED', 'CANCELLED'],
    IN_REVIEW: ['IN_PROGRESS', 'COMPLETED', 'BLOCKED', 'CANCELLED'],
    BLOCKED: ['TODO', 'IN_PROGRESS', 'CANCELLED'],
    COMPLETED: ['IN_PROGRESS', 'IN_REVIEW', 'TODO'],
    CANCELLED: ['TODO']
  };
  const LEADER_ONLY_TASK_STATUSES = ['CANCELLED'];
  const CLOSED_TASK_STATUSES = ['COMPLETED', 'CANCELLED'];

  const PRIORITIES = {
    LOW: ['منخفضة', 'Low'],
    MEDIUM: ['متوسطة', 'Medium'],
    HIGH: ['عالية', 'High'],
    CRITICAL: ['حرجة', 'Critical']
  };

  // Project stages (= backend milestones). OVERDUE is computed, never chosen.
  const STAGE_STATUSES = {
    PENDING: { label: ['لم تبدأ', 'Not started'], cls: 'idle' },
    IN_PROGRESS: { label: ['جارية', 'In progress'], cls: 'progress' },
    COMPLETED: { label: ['مكتملة', 'Completed'], cls: 'completed' },
    OVERDUE: { label: ['متأخرة', 'Overdue'], cls: 'overdue' },
    CANCELLED: { label: ['ملغاة', 'Cancelled'], cls: 'cancelled' }
  };

  const PROJECT_STATUSES = {
    PLANNING: { label: ['التخطيط', 'Planning'], cls: 'idle' },
    IN_PROGRESS: { label: ['قيد التنفيذ', 'In progress'], cls: 'progress' },
    REVIEW: { label: ['المراجعة النهائية', 'Final review'], cls: 'review' },
    COMPLETED: { label: ['مكتمل', 'Completed'], cls: 'completed' },
    ARCHIVED: { label: ['مؤرشف', 'Archived'], cls: 'archived' }
  };

  // Document status. UPLOADED = a regular project file (no review); SUBMITTED = sent to the
  // supervisor for review. Decisions are recorded by the supervisor only.
  const DOCUMENT_STATUSES = {
    UPLOADED: { label: ['مرفوع', 'Uploaded'], cls: 'uploaded' },
    SUBMITTED: { label: ['بانتظار المراجعة', 'Waiting for review'], cls: 'pending' },
    UNDER_REVIEW: { label: ['قيد المراجعة', 'Under review'], cls: 'pending' },
    CHANGES_REQUESTED: { label: ['مطلوب تعديل', 'Changes requested'], cls: 'changes' },
    APPROVED: { label: ['معتمد', 'Approved'], cls: 'approved' },
    REJECTED: { label: ['مرفوض', 'Rejected'], cls: 'rejected' }
  };
  const REVIEW_DECISIONS = ['UNDER_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED'];
  const WAITING_REVIEW = ['SUBMITTED', 'UNDER_REVIEW'];

  const PROJECT_CATEGORIES = {
    TECHNOLOGY: ['تقنية', 'Technology'],
    EDUCATION: ['تعليم', 'Education'],
    HEALTH: ['صحة', 'Health'],
    MEDICAL: ['طبي', 'Medical'],
    BUSINESS: ['أعمال', 'Business'],
    ENGINEERING: ['هندسة', 'Engineering'],
    OTHER: ['أخرى', 'Other']
  };
  const PROJECT_ORIGINS = {
    NEW: ['فكرة جديدة', 'New idea'],
    CONTINUATION: ['استكمال لمشروع سابق', 'Continuation'],
    PREVIOUSLY_IMPLEMENTED: ['إعادة تنفيذ', 'Re-implementation']
  };

  // Supervisor written feedback targets (no grades or scores in Tammha).
  const FEEDBACK_TARGETS = {
    PROJECT: ['المشروع', 'Project'],
    DOCUMENT: ['ملف', 'File'],
    TASK: ['مهمة', 'Task']
  };

  const isOpenTask = (status) => !CLOSED_TASK_STATUSES.includes(status);
  const isOverdue = (status, dueIso, todayIso) =>
    !!dueIso && isOpenTask(status) && dueIso.slice(0, 10) < todayIso.slice(0, 10);
  const canChangeTaskStatus = (from, to, isLeader) => {
    if (from === to) return true;
    if (!(TASK_TRANSITIONS[from] || []).includes(to)) return false;
    if (!isLeader && (LEADER_ONLY_TASK_STATUSES.includes(to) || LEADER_ONLY_TASK_STATUSES.includes(from))) return false;
    return true;
  };
  const nextTaskStatuses = (from, isLeader) =>
    (TASK_TRANSITIONS[from] || []).filter((to) => canChangeTaskStatus(from, to, isLeader));

  window.TammhaDomain = Object.freeze({
    TASK_STATUSES, TASK_TRANSITIONS, LEADER_ONLY_TASK_STATUSES, CLOSED_TASK_STATUSES,
    PRIORITIES, STAGE_STATUSES, PROJECT_STATUSES, DOCUMENT_STATUSES, REVIEW_DECISIONS, WAITING_REVIEW,
    PROJECT_CATEGORIES, PROJECT_ORIGINS, FEEDBACK_TARGETS,
    isOpenTask, isOverdue, canChangeTaskStatus, nextTaskStatuses
  });
})();
