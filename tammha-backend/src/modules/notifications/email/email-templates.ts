import { NotificationType } from '@prisma/client';
import {
  EmailLanguage,
  emailActionUrl,
  emailLanguage,
  renderTammhaMail,
} from '@/common/email/email-layout';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

type Details = Record<string, unknown>;
const value = (data: Details, key: string): string =>
  typeof data[key] === 'string' ? (data[key] as string).slice(0, 200) : '';
const label = (text: string): string => `"${text}"`;
const quote = (text: string): string => `"${text}"`;
const fallback = (
  input: { title: string; message: string },
  lang: EmailLanguage,
) =>
  lang === 'ar'
    ? {
        subject: 'تممها | إشعار جديد',
        body: 'لديك تحديث جديد في تممها. سجّل الدخول لمراجعة تفاصيله.',
        button: 'الدخول إلى تممها',
      }
    : {
        subject: `Tammha | ${input.title}`,
        body: input.message,
        button: 'Open Tammha',
      };

const arStatus: Record<string, string> = {
  PLANNING: 'التخطيط',
  IN_PROGRESS: 'قيد التنفيذ',
  IN_REVIEW: 'قيد المراجعة',
  COMPLETED: 'مكتمل',
  ARCHIVED: 'مؤرشف',
  SUBMITTED: 'تم التسليم',
  UNDER_REVIEW: 'قيد المراجعة',
  CHANGES_REQUESTED: 'يتطلب تعديلات',
  APPROVED: 'تمت الموافقة',
  REJECTED: 'لم تتم الموافقة',
};
const enStatus: Record<string, string> = {
  PLANNING: 'Planning',
  IN_PROGRESS: 'In progress',
  IN_REVIEW: 'In review',
  COMPLETED: 'Completed',
  ARCHIVED: 'Archived',
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under review',
  CHANGES_REQUESTED: 'Changes requested',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};
const status = (value: string, lang: EmailLanguage) =>
  (lang === 'ar' ? arStatus : enStatus)[value] ??
  (lang === 'ar' ? 'محدّثة' : 'updated');
const date = (raw: string, lang: EmailLanguage) => {
  if (!raw) return '';
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime())
    ? ''
    : new Intl.DateTimeFormat(lang === 'ar' ? 'ar-SA' : 'en-GB', {
        dateStyle: 'medium',
        timeZone: 'Asia/Riyadh',
      }).format(parsed);
};

/**
 * Source events are authoritative: never interpret arbitrary notification text as HTML.
 * Missing metadata produces a neutral localized message, not invented project details.
 * Links point to FRONTEND_ORIGIN (safe fallback) until frontend deep routes are verified.
 */
export function renderNotificationEmail(input: {
  title: string;
  message: string;
  type?: NotificationType;
  data?: unknown;
  language?: EmailLanguage;
  recipientName?: string | null;
  frontendUrl?: string;
}): RenderedEmail {
  const lang = emailLanguage(input.language);
  const ar = lang === 'ar';
  const data: Details =
    input.data && typeof input.data === 'object' && !Array.isArray(input.data)
      ? (input.data as Details)
      : {};
  const kind = value(data, 'kind');
  const t = input.type;
  const one = (arabic: string, english: string) => (ar ? arabic : english);
  const n = (key: string, defaultAr: string, defaultEn: string) =>
    value(data, key) || one(defaultAr, defaultEn);
  const subject = (a: string, e: string) =>
    one(`تممها | ${a}`, `Tammha | ${e}`);
  let output = fallback(input, lang);
  const set = (
    aTitle: string,
    enTitle: string,
    arBody: string,
    enBody: string,
    aButton: string,
    enButton: string,
  ) => {
    output = {
      subject: subject(aTitle, enTitle),
      body: one(arBody, enBody),
      button: one(aButton, enButton),
    };
  };
  const task = n('taskTitle', 'المهمة', 'the task');
  const project = n('projectName', 'المشروع', 'the project');
  const team = n('teamName', 'الفريق', 'the team');
  const meeting = n('meetingTitle', 'الاجتماع', 'the meeting');
  const document = n('documentTitle', 'المستند', 'the document');
  const person = n('actorName', 'أحد أعضاء الفريق', 'a team member');
  const due = date(value(data, 'dueDate'), lang);
  const when = date(value(data, 'scheduledAt'), lang);

  switch (t) {
    case NotificationType.TEAM_INVITATION:
      if (kind === 'team_invitation_accepted') {
        set(
          'تم قبول دعوة الفريق',
          'Team Invitation Accepted',
          `وافق ${person} على دعوتك للانضمام إلى فريق ${label(team)}.`,
          `${person} accepted your invitation to ${quote(team)}.`,
          'عرض الفريق',
          'View Team',
        );
      } else if (kind === 'team_invitation_declined') {
        set(
          'تحديث بشأن دعوة الفريق',
          'Team Invitation Update',
          `اعتذر ${person} عن الانضمام إلى فريق ${label(team)}.`,
          `${person} declined the invitation to ${quote(team)}.`,
          'إدارة الفريق',
          'Manage Team',
        );
      } else {
        set(
          'دعوة للانضمام إلى فريق',
          'Team Invitation',
          `دعاك ${person} للانضمام إلى فريق ${label(team)}. يمكنك قبول الدعوة أو رفضها من حسابك.`,
          `${person} invited you to join ${quote(team)}. Review it in your account.`,
          'مراجعة الدعوة',
          'Review Invitation',
        );
      }
      break;
    case NotificationType.SUPERVISION_REQUESTED:
      set(
        'طلب إشراف على مشروع',
        'Supervision Request',
        `أرسل لك ${person} طلبًا للإشراف على مشروع ${label(project)}. يمكنك مراجعة التفاصيل واتخاذ القرار.`,
        `${person} requested your supervision for ${quote(project)}. Review the project details before responding.`,
        'مراجعة طلب الإشراف',
        'Review Supervision Request',
      );
      break;
    case NotificationType.SUPERVISION_RESPONDED:
      if (kind === 'supervision_accepted') {
        set(
          'تم قبول طلب الإشراف',
          'Supervision Request Accepted',
          `وافق ${person} على الإشراف على مشروع ${label(project)}.`,
          `${person} accepted the supervision request for ${quote(project)}.`,
          'عرض المشروع',
          'View Project',
        );
      } else {
        set(
          'تحديث طلب الإشراف',
          'Supervision Request Update',
          `اعتذر ${person} عن قبول طلب الإشراف على مشروع ${label(project)}.`,
          `${person} declined the supervision request for ${quote(project)}.`,
          'إدارة طلبات الإشراف',
          'Manage Supervision Requests',
        );
      }
      break;
    case NotificationType.TASK_ASSIGNED:
      set(
        kind === 'task_reassigned'
          ? 'تم تحويل مهمة إليك'
          : 'مهمة جديدة مسندة إليك',
        kind === 'task_reassigned'
          ? 'Task Reassigned to You'
          : 'New Task Assigned',
        `أسند إليك ${person} مهمة ${label(task)} ضمن ${label(project)}.${due ? ` موعد التسليم: ${due}.` : ''}`,
        `${person} assigned you ${quote(task)} in ${quote(project)}.${due ? ` Due: ${due}.` : ''}`,
        'عرض المهمة',
        'View Task',
      );
      break;
    case NotificationType.TASK_UPDATED:
      if (kind === 'task_completed')
        set(
          'تم إنجاز مهمة',
          'Task Completed',
          `أكمل ${person} مهمة ${label(task)} ضمن ${label(project)}.`,
          `${person} completed ${quote(task)} in ${quote(project)}.`,
          'عرض المهمة',
          'View Task',
        );
      else if (kind === 'task_unassigned')
        set(
          'تغيير المسؤول عن مهمة',
          'Task Assignment Changed',
          `تم تحويل مهمة ${label(task)} إلى عضو آخر في الفريق.`,
          `The task ${quote(task)} was assigned to another team member.`,
          'عرض المهام',
          'View Tasks',
        );
      else if (kind === 'task_deleted')
        set(
          'إزالة مهمة من المشروع',
          'Task Removed',
          `تمت إزالة مهمة ${label(task)} التي كانت مسندة إليك.`,
          `The task ${quote(task)} assigned to you was removed.`,
          'عرض المهام',
          'View Tasks',
        );
      else
        set(
          'تحديث على إحدى مهامك',
          'Task Updated',
          `أجرى ${person} تحديثًا على مهمة ${label(task)}.`,
          `${person} updated the task ${quote(task)}.${
            Array.isArray(data.changes)
              ? ` Changes: ${data.changes
                  .filter((item): item is string => typeof item === 'string')
                  .slice(0, 8)
                  .join(', ')}.`
              : ''
          }`,
          'مراجعة التحديث',
          'Review Update',
        );
      break;
    case NotificationType.TASK_DUE_SOON:
      set(
        'تذكير بموعد تسليم مهمة',
        'Task Deadline Reminder',
        `اقترب موعد تسليم مهمة ${label(task)}.${due ? ` الموعد: ${due}.` : ''} يرجى مراجعة تقدمها.`,
        `Your task ${quote(task)} is due soon.${due ? ` Due date: ${due}.` : ''} Review your progress.`,
        'عرض المهمة',
        'View Task',
      );
      break;
    case NotificationType.TASK_OVERDUE:
      set(
        'مهمة تجاوزت موعدها المحدد',
        'Overdue Task',
        `تجاوزت مهمة ${label(task)} موعدها المحدد.${due ? ` الموعد: ${due}.` : ''} يرجى مراجعتها.`,
        `Your task ${quote(task)} is overdue.${due ? ` Due date: ${due}.` : ''} Please review it.`,
        'مراجعة المهمة',
        'Review Task',
      );
      break;
    case NotificationType.MILESTONE_DUE:
      set(
        'اقتراب موعد إحدى مراحل المشروع',
        'Project Milestone Reminder',
        `اقترب موعد مرحلة ${label(n('milestoneTitle', 'المرحلة', 'the milestone'))}.${due ? ` موعدها: ${due}.` : ''}`,
        `The milestone ${quote(n('milestoneTitle', 'المرحلة', 'the milestone'))} is due soon.${due ? ` Due: ${due}.` : ''}`,
        'عرض المرحلة',
        'View Milestone',
      );
      break;
    case NotificationType.MEETING_INVITATION:
      set(
        'تمت جدولة اجتماع جديد',
        'New Meeting Scheduled',
        `تمت جدولة اجتماع ${label(meeting)}${when ? ` بتاريخ ${when}` : ''}.`,
        `A meeting ${quote(meeting)} has been scheduled${when ? ` for ${when}` : ''}.`,
        'تفاصيل الاجتماع',
        'View Meeting',
      );
      break;
    case NotificationType.MEETING_UPDATED:
      set(
        'تحديث موعد اجتماع',
        'Meeting Updated',
        `تم تحديث تفاصيل اجتماع ${label(meeting)}${when ? ` المقرر بتاريخ ${when}` : ''}.`,
        `The meeting ${quote(meeting)} was updated${when ? `, now scheduled for ${when}` : ''}.`,
        'مراجعة الاجتماع',
        'Review Meeting',
      );
      break;
    case NotificationType.MEETING_CANCELLED:
      set(
        'تم إلغاء اجتماع',
        'Meeting Cancelled',
        `تم إلغاء اجتماع ${label(meeting)}${when ? ` المقرر بتاريخ ${when}` : ''}.`,
        `The meeting ${quote(meeting)}${when ? ` scheduled for ${when}` : ''} was cancelled.`,
        'عرض الاجتماعات',
        'View Meetings',
      );
      break;
    case NotificationType.DOCUMENT_SUBMITTED:
      if (Number(data.version) > 1)
        set(
          'تم رفع نسخة جديدة من مستند',
          'Document Resubmitted',
          `تم رفع النسخة رقم ${Number(data.version)} من المستند ${label(document)} ضمن ${label(project)}.`,
          `Version ${Number(data.version)} of ${quote(document)} was submitted in ${quote(project)}.`,
          'عرض النسخة الجديدة',
          'View New Version',
        );
      else
        set(
          'مستند جديد بانتظار المراجعة',
          'Document Submitted for Review',
          `تم تسليم المستند ${label(document)} ضمن ${label(project)} للمراجعة.`,
          `The document ${quote(document)} was submitted for review in ${quote(project)}.`,
          'مراجعة المستند',
          'Review Document',
        );
      break;
    case NotificationType.FEEDBACK_RECEIVED:
    case NotificationType.SUBMISSION_STATUS_CHANGED: {
      const decision = value(data, 'status');
      if (decision)
        set(
          'تحديث حالة التسليم',
          'Submission Status Updated',
          `تم تحديث حالة ${label(document)} إلى "${status(decision, lang)}". يمكنك مراجعة قرار المشرف وملاحظاته.`,
          `The status of ${quote(document)} was updated to ${status(decision, lang)}. You can review your supervisor's feedback.`,
          'عرض نتيجة المراجعة',
          'View Review Decision',
        );
      else if (kind === 'feedback_updated')
        set(
          'تم تحديث ملاحظات المشرف',
          'Supervisor Feedback Updated',
          `حدّث المشرف ملاحظاته على ${label(n('itemTitle', 'المشروع', 'the project'))}.`,
          `The supervisor updated feedback on ${quote(n('itemTitle', 'المشروع', 'the project'))}.`,
          'مراجعة الملاحظات',
          'Review Feedback',
        );
      else
        set(
          'ملاحظات جديدة من المشرف',
          'New Supervisor Feedback',
          `أضاف المشرف ملاحظات جديدة على ${label(n('itemTitle', 'المشروع', 'the project'))}.`,
          `Your supervisor added feedback on ${quote(n('itemTitle', 'المشروع', 'the project'))}.`,
          'عرض الملاحظات',
          'View Feedback',
        );
      break;
    }
    case NotificationType.PROJECT_STATUS_CHANGED:
      set(
        'تحديث حالة مشروعك',
        'Project Status Updated',
        `تغيرت حالة مشروع ${label(project)} من "${status(value(data, 'from'), lang)}" إلى "${status(value(data, 'to'), lang)}".`,
        `The status of ${quote(project)} changed from ${status(value(data, 'from'), lang)} to ${status(value(data, 'to'), lang)}.`,
        'عرض المشروع',
        'View Project',
      );
      break;
    case NotificationType.HANDBOOK_PROCESSED:
      if (value(data, 'status') === 'READY')
        set(
          'دليل مشروعك جاهز',
          'Your Project Handbook Is Ready',
          `اكتملت معالجة دليل ${label(n('handbookTitle', 'المشروع', 'the handbook'))}. يمكنك الآن طلب مهام مقترحة من المساعد الذكي.`,
          `The handbook ${quote(n('handbookTitle', 'الدليل', 'the handbook'))} was processed. You can now request AI task suggestions.`,
          'فتح دليل المشروع',
          'Open Project Handbook',
        );
      else
        set(
          'تعذرت معالجة دليل المشروع',
          'Handbook Processing Unsuccessful',
          `لم نتمكن من معالجة دليل ${label(n('handbookTitle', 'المشروع', 'the handbook'))}. يرجى مراجعة الملف وإعادة رفعه عند الحاجة.`,
          `We could not process ${quote(n('handbookTitle', 'الدليل', 'the handbook'))}. Please review the file and upload it again if needed.`,
          'مراجعة دليل المشروع',
          'Review Project Handbook',
        );
      break;
    default:
      break;
  }
  // Never trust user-provided URLs. The application origin is controlled by server config.
  const url = input.frontendUrl ? emailActionUrl(input.frontendUrl) : '';
  return renderTammhaMail({
    language: lang,
    recipientName: input.recipientName,
    subject: output.subject,
    body: output.body,
    buttonLabel: url ? one('الدخول إلى تممها', 'Open Tammha') : undefined,
    actionUrl: url,
  });
}
