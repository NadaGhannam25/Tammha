import { ConflictException, ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { FeedbackService } from '../feedback.service';
import { AuthUser } from '@common/types/auth-user.type';

/**
 * FeedbackService guarantees (Prisma, access and notifications mocked).
 * HTTP behaviour is covered in feedback.integration.spec.ts.
 */
describe('FeedbackService (unit)', () => {
  const supervisor = {
    id: 'sup1',
    role: UserRole.SUPERVISOR,
    universityId: 'u1',
  } as AuthUser;
  const student = {
    id: 's1',
    role: UserRole.STUDENT,
    universityId: 'u1',
  } as AuthUser;

  const feedbackRow = (over: Record<string, unknown> = {}) => ({
    id: 'f1',
    projectId: 'p1',
    documentId: 'd1',
    documentVersion: 2,
    givenById: 'sup1',
    comment: 'ok',
    category: 'GENERAL',
    status: 'APPROVED',
    taskId: null,
    task: null,
    createdAt: new Date(1000),
    updatedAt: new Date(1000),
    givenBy: { id: 'sup1' },
    document: { id: 'd1', title: 'T' },
    ...over,
  });

  let order: string[];
  let prisma: any;
  let tx: any;
  let access: any;
  let notifications: any;
  let service: FeedbackService;

  const step = (name: string, value?: unknown) =>
    jest.fn(async () => {
      order.push(name);
      return value;
    });

  beforeEach(() => {
    order = [];
    tx = {
      document: {
        updateMany: step('document.updateMany(compare-and-set)', { count: 1 }),
        findUnique: jest.fn().mockResolvedValue({ id: 'd1' }),
      },
      documentVersion: {
        findFirst: step('version.findFirst(latest)', { version: 2 }),
      },
      feedback: {
        create: step('feedback.create', { id: 'f1' }),
        update: step('feedback.update'),
      },
    };
    prisma = {
      document: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'd1',
          title: 'T',
          projectId: 'p1',
          uploadedById: 's1',
        }),
      },
      feedback: { findUnique: jest.fn().mockResolvedValue(feedbackRow()) },
      $transaction: jest.fn(async (fn: any) => {
        order.push('tx.begin');
        const result = await fn(tx);
        order.push('tx.commit');
        return result;
      }),
    };
    access = {
      assertSupervisorOfProject: jest
        .fn()
        .mockResolvedValue({ id: 'p1', teamId: 't1' }),
      assertCanViewProject: jest.fn().mockResolvedValue(undefined),
      getTeamStudentIds: jest.fn().mockResolvedValue(['s1', 's2']),
    };
    notifications = { notify: step('notify') };
    service = new FeedbackService(prisma, access, notifications);
  });

  it('status decision: compare-and-set, feedback and notifications in ONE transaction', async () => {
    await service.create(supervisor, { documentId: 'd1', status: 'APPROVED' });
    expect(order).toEqual([
      'tx.begin',
      'document.updateMany(compare-and-set)',
      'version.findFirst(latest)',
      'feedback.create',
      'notify',
      'tx.commit',
    ]);
    expect(tx.document.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', reviewStatus: { not: 'APPROVED' } },
      data: {
        reviewStatus: 'APPROVED',
        reviewStatusUpdatedAt: expect.any(Date),
      },
    });
    // notifications are written with the transaction client
    expect(notifications.notify).toHaveBeenCalledWith(
      ['s1', 's2'],
      expect.objectContaining({
        type: 'SUBMISSION_STATUS_CHANGED', // P11 (was FEEDBACK_RECEIVED)
        dedupeKey: 'feedback:f1',
        email: true, // APPROVED is an important decision
      }),
      tx,
    );
    expect(tx.feedback.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'p1',
        documentId: 'd1',
        documentVersion: 2,
        givenById: 'sup1',
        receivedById: 's1',
        status: 'APPROVED',
      }),
      select: { id: true },
    });
  });

  it('unchanged status: 409 and nothing is created or notified', async () => {
    tx.document.updateMany = step('document.updateMany(compare-and-set)', {
      count: 0,
    });
    await expect(
      service.create(supervisor, { documentId: 'd1', status: 'APPROVED' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.feedback.create).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('authorization runs before anything is written', async () => {
    access.assertSupervisorOfProject.mockRejectedValue(
      new ForbiddenException(),
    );
    await expect(
      service.create(supervisor, { documentId: 'd1', comment: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('no grading: the view has no score or rubric fields', async () => {
    for (const viewer of [student, supervisor]) {
      const view = await service.findOne(viewer, 'f1');
      expect(view).toMatchObject({ comment: 'ok', edited: false });
      for (const key of [
        'score',
        'maxScore',
        'rubric',
        'rubricTotal',
        'scoreVisibleToStudents',
      ]) {
        expect(view).not.toHaveProperty(key);
      }
    }
  });

  it('task feedback: records the task and its assignee; the task is never written', async () => {
    prisma.task = {
      findUnique: jest.fn().mockResolvedValue({
        id: 'k1',
        title: 'Write chapter 2',
        projectId: 'p1',
        assignedToId: 's2',
      }),
    };
    tx.task = { update: jest.fn(), updateMany: jest.fn() };
    await service.create(supervisor, { taskId: 'k1', comment: 'Add sources' });
    expect(tx.feedback.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'p1',
        taskId: 'k1',
        documentId: null,
        receivedById: 's2',
        comment: 'Add sources',
      }),
      select: { id: true },
    });
    expect(tx.task.update).not.toHaveBeenCalled();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(notifications.notify).toHaveBeenCalledWith(
      ['s1', 's2'],
      expect.objectContaining({
        type: 'FEEDBACK_RECEIVED',
        message: 'Your supervisor left feedback on the task "Write chapter 2".',
      }),
      tx,
    );
  });

  it('editing only the category does not notify students', async () => {
    await service.update(supervisor, 'f1', { category: 'TECHNICAL_SKILLS' });
    expect(tx.feedback.update).toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('only the author can edit', async () => {
    prisma.feedback.findUnique.mockResolvedValue(
      feedbackRow({ givenById: 'someone-else' }),
    );
    await expect(
      service.update(supervisor, 'f1', { comment: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
