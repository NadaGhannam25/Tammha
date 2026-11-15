import { NotificationType } from '@prisma/client';
import { renderNotificationEmail } from './email-templates';

describe('Localized notification emails', () => {
  const task = {
    type: NotificationType.TASK_ASSIGNED,
    title: 'New task assigned',
    message: 'Example',
    data: {
      kind: 'task_assigned',
      taskTitle: 'Chapter 2',
      actorName: 'Sara',
      dueDate: '2027-01-20T14:00:00.000Z',
    },
    recipientName: 'Nada',
    frontendUrl: 'https://tammha.site',
  };

  it('uses the recipient language independently for the same event', () => {
    const ar = renderNotificationEmail({ ...task, language: 'ar' });
    const en = renderNotificationEmail({ ...task, language: 'en' });
    expect(ar.subject).toContain('مهمة جديدة');
    expect(ar.html).toContain('dir="rtl"');
    expect(en.subject).toContain('New Task');
    expect(en.html).toContain('dir="ltr"');
    expect(ar.text).toContain('Chapter 2');
    expect(en.text).toContain('Chapter 2');
  });

  it('translates a supervisor review state without leaking the English label', () => {
    const msg = renderNotificationEmail({
      type: NotificationType.SUBMISSION_STATUS_CHANGED,
      title: 'Submission status updated',
      message: 'Changes requested',
      language: 'ar',
      data: { status: 'CHANGES_REQUESTED', documentTitle: 'GP1' },
    });
    expect(msg.text).toContain('يتطلب تعديلات');
    expect(msg.text).not.toContain('Changes requested');
  });

  it('does not trust notification data as raw HTML', () => {
    const msg = renderNotificationEmail({
      ...task,
      language: 'ar',
      data: {
        kind: 'task_assigned',
        taskTitle: '<img src=x onerror=alert(1)>',
      },
    });
    expect(msg.html).toContain('&lt;img');
    expect(msg.html).not.toContain('<img src=x');
  });
});
