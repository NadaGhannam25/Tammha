import { TaskStatus, UserRole } from '@prisma/client';
import { isTaskOverdue, taskOrderBy, TasksService } from '../tasks.service';
import { AuthUser } from '@common/types/auth-user.type';

describe('TasksService (unit)', () => {
  const student = {
    id: 's1',
    role: UserRole.STUDENT,
    universityId: 'uni-1',
    studentNumber: 'S1-0001',
  } as AuthUser;

  describe('isTaskOverdue', () => {
    const now = new Date('2026-10-10T12:00:00Z');
    const past = new Date('2026-10-09T12:00:00Z');
    const future = new Date('2026-10-11T12:00:00Z');

    it.each([
      [TaskStatus.TODO, past, true],
      [TaskStatus.IN_PROGRESS, past, true],
      [TaskStatus.IN_REVIEW, past, true],
      [TaskStatus.BLOCKED, past, true],
      [TaskStatus.COMPLETED, past, false],
      [TaskStatus.CANCELLED, past, false],
      [TaskStatus.TODO, future, false],
      [TaskStatus.TODO, null, false],
    ])('%s due %p -> %p', (status, due, expected) => {
      expect(isTaskOverdue(status, due, now)).toBe(expected);
    });
  });

  describe('taskOrderBy', () => {
    it('dueDate keeps tasks without a deadline last in both directions', () => {
      expect(taskOrderBy('dueDate', 'asc')).toEqual([
        { dueDate: { sort: 'asc', nulls: 'last' } },
      ]);
      expect(taskOrderBy('dueDate', 'desc')).toEqual([
        { dueDate: { sort: 'desc', nulls: 'last' } },
      ]);
    });

    it('priority asc = most important first (enum desc), then deadline', () => {
      expect(taskOrderBy('priority', 'asc')[0]).toEqual({ priority: 'desc' });
      expect(taskOrderBy('priority', 'desc')[0]).toEqual({ priority: 'asc' });
      expect(taskOrderBy('priority', 'asc')[1]).toEqual({
        dueDate: { sort: 'asc', nulls: 'last' },
      });
    });

    it('plain fields', () => {
      expect(taskOrderBy('createdAt', 'desc')).toEqual([{ createdAt: 'desc' }]);
    });
  });

  describe('completedAt follows status', () => {
    let prisma: any;
    let access: any;
    let service: TasksService;

    beforeEach(() => {
      prisma = {
        task: {
          findUnique: jest.fn(),
          update: jest.fn(async ({ data }: any) => ({
            id: 't1',
            projectId: 'p1',
            status: data.status ?? 'TODO',
            completedAt: data.completedAt ?? null,
            dueDate: null,
          })),
        },
      };
      access = {
        assertStudentOfProject: jest
          .fn()
          .mockResolvedValue({ id: 'p1', teamId: 'team1' }),
        // P16: field changes are made by the team leader
        findMembershipInTeam: jest
          .fn()
          .mockResolvedValue({ teamId: 'team1', role: 'LEADER' }),
      };
      service = new TasksService(prisma, access, {
        notify: jest.fn().mockResolvedValue([]),
      } as any);
    });

    const updateFrom = async (from: TaskStatus, to: TaskStatus) => {
      prisma.task.findUnique.mockResolvedValue({
        id: 't1',
        projectId: 'p1',
        status: from,
      });
      await service.update(student, 't1', { status: to });
      return prisma.task.update.mock.calls[0][0].data;
    };

    it('-> COMPLETED sets completedAt', async () => {
      expect(
        (await updateFrom(TaskStatus.IN_PROGRESS, TaskStatus.COMPLETED))
          .completedAt,
      ).toBeInstanceOf(Date);
    });

    it('COMPLETED -> other clears completedAt', async () => {
      expect(
        await updateFrom(TaskStatus.COMPLETED, TaskStatus.TODO),
      ).toMatchObject({ completedAt: null });
    });

    it('unchanged status does not touch completedAt', async () => {
      const data = await updateFrom(TaskStatus.COMPLETED, TaskStatus.COMPLETED);
      expect(data).not.toHaveProperty('completedAt');
      expect(data).not.toHaveProperty('status');
    });

    it('checks write access before changing anything', async () => {
      access.assertStudentOfProject.mockRejectedValue(new Error('denied'));
      prisma.task.findUnique.mockResolvedValue({
        id: 't1',
        projectId: 'p1',
        status: 'TODO',
      });
      await expect(
        service.update(student, 't1', { title: 'x' }),
      ).rejects.toThrow('denied');
      expect(prisma.task.update).not.toHaveBeenCalled();
    });
  });
});
