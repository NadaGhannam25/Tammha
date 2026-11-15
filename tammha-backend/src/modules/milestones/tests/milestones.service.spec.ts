import { UserRole } from '@prisma/client';
import { MilestonesService } from '../milestones.service';
import { AuthUser } from '@common/types/auth-user.type';

describe('MilestonesService (unit)', () => {
  const student = { id: 's1', role: UserRole.STUDENT } as AuthUser;
  let prisma: any;
  let access: any;
  let service: MilestonesService;

  const milestone = (id: string, dueInDays: number, status = 'PENDING') => ({
    id,
    projectId: 'p1',
    title: id,
    description: null,
    dueDate: new Date(Date.now() + dueInDays * 86_400_000),
    status,
    createdById: 's1',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  beforeEach(() => {
    prisma = {
      milestone: { count: jest.fn(), findMany: jest.fn() },
      task: { groupBy: jest.fn() },
    };
    prisma.$transaction = jest.fn((ops: Promise<unknown>[]) =>
      Promise.all(ops),
    );
    access = { getReadableProjectIds: jest.fn().mockResolvedValue(['p1']) };
    service = new MilestonesService(prisma, access);
  });

  it('computes progress for a whole page with exactly two aggregate queries (no N+1)', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => milestone(`m${i}`, 10));
    prisma.milestone.count.mockResolvedValue(25);
    prisma.milestone.findMany.mockResolvedValue(rows);
    prisma.task.groupBy
      .mockResolvedValueOnce([
        { milestoneId: 'm0', status: 'COMPLETED', _count: { _all: 3 } },
        { milestoneId: 'm0', status: 'TODO', _count: { _all: 1 } },
        { milestoneId: 'm0', status: 'CANCELLED', _count: { _all: 5 } },
      ])
      .mockResolvedValueOnce([{ milestoneId: 'm0', _count: { _all: 1 } }]);

    const page = await service.findMany(student, { limit: 25 });

    expect(prisma.task.groupBy).toHaveBeenCalledTimes(2);
    expect(page.items[0].progress).toEqual({
      totalTasks: 4,
      completedTasks: 3,
      openTasks: 1,
      overdueTasks: 1,
      percent: 75,
    });
    expect(page.items[1].progress.percent).toBe(0);
  });

  it('isOverdue: past due and still open only', async () => {
    prisma.milestone.count.mockResolvedValue(3);
    prisma.milestone.findMany.mockResolvedValue([
      milestone('late', -1),
      milestone('lateDone', -1, 'COMPLETED'),
      milestone('future', 1),
    ]);
    prisma.task.groupBy.mockResolvedValue([]);

    const page = await service.findMany(student, {});
    expect(page.items.map((m) => m.isOverdue)).toEqual([true, false, false]);
  });

  it('overdue filter excludes closed statuses even if requested', async () => {
    prisma.milestone.count.mockResolvedValue(0);
    prisma.milestone.findMany.mockResolvedValue([]);
    await service.findMany(student, {
      overdue: true,
      status: ['COMPLETED', 'PENDING'] as any,
    });
    const where = prisma.milestone.findMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ['PENDING'] });
    expect(where.dueDate.lt).toBeInstanceOf(Date);
  });
});
