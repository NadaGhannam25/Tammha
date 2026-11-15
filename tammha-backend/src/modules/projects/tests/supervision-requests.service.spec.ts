import { ConflictException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { SupervisionRequestsService } from '../supervision/supervision-requests.service';
import { AuthUser } from '@common/types/auth-user.type';

/**
 * Unit tests for SupervisionRequestsService with mocked Prisma.
 * Focus: transaction usage, project-row locking order and conditional status updates.
 */
describe('SupervisionRequestsService', () => {
  const supervisor = {
    id: 'v1',
    role: UserRole.SUPERVISOR,
    universityId: 'uni-1',
  } as AuthUser;
  const student = {
    id: 's1',
    role: UserRole.STUDENT,
    universityId: 'uni-1',
  } as AuthUser;
  const calls: string[] = [];
  let prisma: any;
  let access: any;
  let service: SupervisionRequestsService;

  const track = (name: string, value?: unknown) =>
    jest.fn(async () => {
      calls.push(name);
      return value;
    });

  beforeEach(() => {
    calls.length = 0;
    prisma = {
      project: { update: track('lockProject') },
      projectMember: {
        findMany: track('checkSupervisors', []),
        create: track('linkSupervisor'),
      },
      supervisionRequest: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'r1',
          projectId: 'p1',
          supervisorId: 'v1',
          status: 'PENDING',
          message: null,
          responseNote: null,
          respondedAt: null,
          createdAt: new Date(),
          project: { id: 'p1', name: 'P', teamId: 't1' },
          supervisor: { id: 'v1' },
          requestedBy: { id: 's1' },
        }),
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: track('updateStatus', { count: 1 }),
        create: jest.fn(),
      },
      user: { findFirst: jest.fn() },
    };
    prisma.$transaction = jest.fn((fn: any) => fn(prisma));
    access = {
      getProjectOrThrow: jest
        .fn()
        .mockResolvedValue({ id: 'p1', teamId: 't1' }),
      getTeamUniversityId: jest.fn().mockResolvedValue('uni-1'),
      assertSameUniversity: jest.fn(),
      assertStudentOfProject: jest
        .fn()
        .mockResolvedValue({ id: 'p1', teamId: 't1' }),
      // P16: the team leader sends the request; the team is notified of the answer
      assertLeaderOfProject: jest
        .fn()
        .mockResolvedValue({ id: 'p1', teamId: 't1' }),
      getTeamStudentIds: jest.fn().mockResolvedValue(['s1']),
    };
    service = new SupervisionRequestsService(prisma, access, {
      notify: jest.fn().mockResolvedValue([]),
    } as any);
  });

  it('accept: locks the project before checking and linking', async () => {
    await service.acceptRequest(supervisor, 'r1', 'ok');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(calls.indexOf('lockProject')).toBe(0);
    expect(calls.indexOf('checkSupervisors')).toBeGreaterThan(
      calls.indexOf('lockProject'),
    );
    expect(calls.indexOf('linkSupervisor')).toBeGreaterThan(
      calls.indexOf('checkSupervisors'),
    );
    expect(prisma.projectMember.create).toHaveBeenCalledWith({
      data: { userId: 'v1', projectId: 'p1', role: 'PROJECT_MANAGER' },
    });
    // conditional transition: only from PENDING
    expect(prisma.supervisionRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', status: 'PENDING' },
      data: expect.objectContaining({ status: 'ACCEPTED', responseNote: 'ok' }),
    });
  });

  it('accept: a request already handled concurrently does not link the supervisor', async () => {
    prisma.supervisionRequest.updateMany = jest
      .fn()
      .mockResolvedValue({ count: 0 });
    const err = await service.acceptRequest(supervisor, 'r1').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().code).toBe('REQUEST_NOT_PENDING');
    expect(prisma.projectMember.create).not.toHaveBeenCalled();
  });

  it('accept: P2002 on project_members maps to SUPERVISOR_ALREADY_ASSIGNED', async () => {
    prisma.projectMember.create = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('u'), { code: 'P2002' }));
    const err = await service.acceptRequest(supervisor, 'r1').catch((e) => e);
    expect(err.getResponse().code).toBe('SUPERVISOR_ALREADY_ASSIGNED');
  });

  it('accept: checks the supervisor university against the team', async () => {
    await service.acceptRequest(supervisor, 'r1');
    expect(access.getTeamUniversityId).toHaveBeenCalledWith('t1', prisma);
    expect(access.assertSameUniversity).toHaveBeenCalledWith(
      'uni-1',
      'uni-1',
      expect.any(String),
    );
  });

  it('create: locks the project before the pending/assigned checks', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 'v1',
      role: UserRole.SUPERVISOR,
      isActive: true,
      universityId: 'uni-1',
    });
    prisma.supervisionRequest.create.mockImplementation(async () => {
      calls.push('createRequest');
      return prisma.supervisionRequest.findUnique();
    });

    await service.createRequest(student, 'p1', 'v1@test.local');

    expect(calls[0]).toBe('lockProject');
    expect(calls).toContain('checkSupervisors');
    expect(calls[calls.length - 1]).toBe('createRequest');
  });

  it('reject: uses the conditional PENDING -> REJECTED transition', async () => {
    await service.rejectRequest(supervisor, 'r1', 'busy');
    expect(prisma.supervisionRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', status: 'PENDING' },
      data: expect.objectContaining({
        status: 'REJECTED',
        responseNote: 'busy',
      }),
    });
    expect(prisma.projectMember.create).not.toHaveBeenCalled();
  });
});
