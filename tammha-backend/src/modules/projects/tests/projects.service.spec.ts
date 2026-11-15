import { BadRequestException } from '@nestjs/common';
import { TeamRole, UserRole } from '@prisma/client';
import { ProjectsService } from '../projects.service';
import { AuthUser } from '@common/types/auth-user.type';

/**
 * Unit tests for ProjectsService with mocked Prisma, access and teams services.
 * Focus: transactional creation and concurrency handling.
 */
describe('ProjectsService', () => {
  const student = {
    id: 's1',
    role: UserRole.STUDENT,
    universityId: 'uni-1',
    studentNumber: 'S1-0001',
  } as AuthUser;
  let prisma: any;
  let access: any;
  let teams: any;
  let service: ProjectsService;

  beforeEach(() => {
    prisma = {
      team: { create: jest.fn().mockResolvedValue({ id: 't1' }) },
      teamMember: {
        create: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      project: {
        create: jest.fn().mockResolvedValue({ id: 'p1' }),
        update: jest.fn(),
        // handbook source (library selection / upload)
        findUnique: jest.fn().mockResolvedValue({ handbookSource: null }),
      },
      projectMember: { findMany: jest.fn().mockResolvedValue([]) },
      // P16 workspace sections
      milestone: { findMany: jest.fn().mockResolvedValue([]) },
      task: { groupBy: jest.fn().mockResolvedValue([]) },
      projectHandbook: { findFirst: jest.fn().mockResolvedValue(null) },
      // setup readiness (leader identity)
      user: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    prisma.$transaction = jest.fn((fn: any) => fn(prisma));
    access = {
      findStudentMemberships: jest.fn().mockResolvedValue([]),
      getProjectOrThrow: jest
        .fn()
        .mockResolvedValue({ id: 'p1', teamId: 't1', name: 'P' }),
      getTeamOrThrow: jest
        .fn()
        .mockResolvedValue({ id: 't1', name: 'T', inviteCode: 'K7QXM2PA' }),
    };
    teams = {
      generateUniqueInviteCode: jest.fn().mockResolvedValue('K7QXM2PA'),
      listMembers: jest.fn().mockResolvedValue([]),
      toInvitationView: jest
        .fn()
        .mockReturnValue({ code: 'K7QXM2PA', link: 'l', updatedAt: null }),
    };
    const metrics = {
      progress: { percent: 0 },
      readiness: { score: 0, level: 'NOT_READY' },
      stats: { tasks: { total: 0, completed: 0 } },
    };
    service = new ProjectsService(
      prisma,
      access,
      teams,
      {
        loadMetrics: jest.fn(
          async (ids: string[]) => new Map(ids.map((id) => [id, metrics])),
        ),
      } as any,
      {
        evaluate: jest.fn().mockResolvedValue({
          canComplete: false,
          missingRequirements: ['HANDBOOK_REQUIRED'],
          completed: false,
          handbookState: 'NONE',
          supervisorRequestStatus: null,
        }),
      } as any,
    );
  });

  it('creates team, LEADER membership and project in one transaction', async () => {
    await service.createWorkspace(student, { name: 'Tammha' });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(teams.generateUniqueInviteCode).toHaveBeenCalledWith(prisma);
    expect(prisma.team.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Tammha Team',
        inviteCode: 'K7QXM2PA',
      }),
    });
    expect(prisma.teamMember.create).toHaveBeenCalledWith({
      data: { teamId: 't1', userId: 's1', role: TeamRole.LEADER },
    });
    expect(prisma.project.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: 'Tammha', teamId: 't1' }),
    });
  });

  it('requires a university before creating anything', async () => {
    const err = await service
      .createWorkspace({ ...student, universityId: null } as AuthUser, {
        name: 'Tammha',
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().code).toBe('UNIVERSITY_REQUIRED');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a student who already has projects can create another one (own team, LEADER)', async () => {
    access.findStudentMemberships = jest
      .fn()
      .mockResolvedValue([{ teamId: 'other', role: TeamRole.MEMBER }]);
    await service.createWorkspace(student, { name: 'Second project' });
    expect(prisma.team.create).toHaveBeenCalledTimes(1);
    expect(prisma.teamMember.create).toHaveBeenCalledWith({
      data: { teamId: 't1', userId: 's1', role: TeamRole.LEADER },
    });
  });

  it('returns the invitation to the team leader only (not members or supervisors)', async () => {
    access.assertCanViewProject = jest.fn().mockResolvedValue({ id: 'p1' });
    const supervisor = { id: 'v1', role: UserRole.SUPERVISOR } as AuthUser;
    const member = { id: 's2', role: UserRole.STUDENT } as AuthUser;
    teams.listMembers.mockResolvedValue([
      {
        userId: 's1',
        teamRole: TeamRole.LEADER,
        user: { universityId: 'uni-1' },
      },
      {
        userId: 's2',
        teamRole: TeamRole.MEMBER,
        user: { universityId: 'uni-1' },
      },
    ]);

    expect(
      (await service.getWorkspace(supervisor, 'p1')).invitation,
    ).toBeNull();
    expect((await service.getWorkspace(member, 'p1')).invitation).toBeNull();
    const leaderView = await service.getWorkspace(student, 'p1');
    expect(leaderView.invitation).toMatchObject({ code: 'K7QXM2PA' });
    expect(leaderView.viewer).toMatchObject({
      isLeader: true,
      teamRole: 'LEADER',
    });
  });

  it('lists only SUPERVISOR users as project supervisors', async () => {
    access.assertCanViewProject = jest.fn().mockResolvedValue({ id: 'p1' });
    prisma.projectMember.findMany.mockResolvedValue([
      {
        userId: 'v1',
        role: 'PROJECT_MANAGER',
        createdAt: new Date(),
        user: { id: 'v1', role: UserRole.SUPERVISOR },
      },
      {
        userId: 's9',
        role: 'CONTRIBUTOR',
        createdAt: new Date(),
        user: { id: 's9', role: UserRole.STUDENT },
      },
    ]);
    const ws = await service.getWorkspace(student, 'p1');
    expect(ws.supervisors.map((s) => s.userId)).toEqual(['v1']);
  });
});
