import {
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { TeamRole, UserRole } from '@prisma/client';
import { TeamsService } from '../teams.service';
import { AuthUser } from '@common/types/auth-user.type';

/**
 * Unit tests for TeamsService with mocked Prisma + access service.
 * Focus: transactions, race handling, configuration.
 */
describe('TeamsService', () => {
  const student = {
    id: 's1',
    role: UserRole.STUDENT,
    universityId: 'uni-1',
    studentNumber: 'S1-0001',
  } as AuthUser;
  const p2002 = Object.assign(new Error('unique'), { code: 'P2002' });

  let prisma: any;
  let access: any;
  const config = (values: Record<string, string | undefined>) => ({
    get: (key: string, def?: string) => values[key] ?? def,
  });

  beforeEach(() => {
    prisma = {
      team: { findUnique: jest.fn(), update: jest.fn() },
      teamMember: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        delete: jest.fn(),
        count: jest.fn().mockResolvedValue(1),
      },
      project: { findUnique: jest.fn() },
      user: { findFirst: jest.fn() },
    };
    prisma.$transaction = jest.fn((fn: any) => fn(prisma));
    access = {
      findMembershipInTeam: jest.fn().mockResolvedValue(null),
      assertStudentOfTeam: jest
        .fn()
        .mockResolvedValue({ id: 't1', inviteCode: null }),
      assertCanViewTeam: jest.fn(),
      getTeamOrThrow: jest.fn(),
      getTeamUniversityId: jest.fn().mockResolvedValue('uni-1'),
      assertSameUniversity: jest.fn(),
      // P16: team management is leader-only
      assertLeaderOfTeam: jest
        .fn()
        .mockResolvedValue({ id: 't1', inviteCode: null }),
    };
  });

  const make = (values: Record<string, string | undefined> = {}) =>
    new TeamsService(prisma, access, config(values) as any);

  describe('configuration', () => {
    it('uses INVITATION_LINK_BASE_URL for links', () => {
      const s = make({ INVITATION_LINK_BASE_URL: 'https://gp.example/join' });
      expect(
        s.toInvitationView({
          inviteCode: 'K7QXM2PA',
          inviteCodeUpdatedAt: null,
        })!.link,
      ).toBe('https://gp.example/join/K7QXM2PA');
    });

    it('treats empty/invalid TEAM_MAX_MEMBERS as no limit', async () => {
      prisma.team.findUnique.mockResolvedValue({
        id: 't1',
        name: 'T',
        isActive: true,
      });
      prisma.project.findUnique.mockResolvedValue({ id: 'p1', name: 'P' });
      for (const v of [undefined, '', 'abc', '0', '-2']) {
        await expect(
          make({ TEAM_MAX_MEMBERS: v }).previewInvitation('K7QXM2PA'),
        ).resolves.toMatchObject({ maxMembers: null });
      }
    });
  });

  describe('joinByInvitation', () => {
    beforeEach(() => {
      prisma.team.findUnique.mockResolvedValue({ id: 't1', isActive: true });
      prisma.project.findUnique.mockResolvedValue({ id: 'p1' });
    });

    it('runs inside a transaction and creates a MEMBER row', async () => {
      await expect(
        make().joinByInvitation(student, 'k7qx-m2pa'),
      ).resolves.toEqual({
        message: 'Joined team successfully',
        teamId: 't1',
        projectId: 'p1',
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.team.findUnique).toHaveBeenCalledWith({
        where: { inviteCode: 'K7QXM2PA' },
      });
      expect(prisma.teamMember.create).toHaveBeenCalledWith({
        data: { teamId: 't1', userId: 's1', role: TeamRole.MEMBER },
      });
    });

    it('does not touch the database for a malformed code', async () => {
      await expect(
        make().joinByInvitation(student, '???'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('treats an inactive team as an invalid invitation', async () => {
      prisma.team.findUnique.mockResolvedValue({ id: 't1', isActive: false });
      await expect(
        make().joinByInvitation(student, 'K7QXM2PA'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('treats a team without a project as an invalid invitation', async () => {
      prisma.project.findUnique.mockResolvedValue(null);
      await expect(
        make().joinByInvitation(student, 'K7QXM2PA'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('maps a concurrent unique violation (P2002) to 409 ALREADY_IN_THIS_TEAM', async () => {
      prisma.teamMember.create.mockRejectedValue(p2002);
      const err = await make()
        .joinByInvitation(student, 'K7QXM2PA')
        .catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse().code).toBe('ALREADY_IN_THIS_TEAM');
    });

    it('checks university consistency inside the transaction', async () => {
      await make().joinByInvitation(student, 'K7QXM2PA');
      expect(access.getTeamUniversityId).toHaveBeenCalledWith('t1', prisma);
      expect(access.assertSameUniversity).toHaveBeenCalledWith(
        'uni-1',
        'uni-1',
        expect.any(String),
      );
    });

    it('does not create the membership when universities differ', async () => {
      access.assertSameUniversity.mockImplementation(() => {
        throw new ConflictException({ code: 'UNIVERSITY_MISMATCH' });
      });
      await expect(
        make().joinByInvitation(student, 'K7QXM2PA'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.teamMember.create).not.toHaveBeenCalled();
    });

    it('enforces TEAM_MAX_MEMBERS', async () => {
      prisma.teamMember.count.mockResolvedValue(5);
      const err = await make({ TEAM_MAX_MEMBERS: '5' })
        .joinByInvitation(student, 'K7QXM2PA')
        .catch((e) => e);
      expect(err.getResponse().code).toBe('TEAM_FULL');
      expect(prisma.teamMember.create).not.toHaveBeenCalled();
    });
  });

  describe('invitation codes', () => {
    it('retries when a generated code already exists', async () => {
      prisma.team.findUnique
        .mockResolvedValueOnce({ id: 'taken' })
        .mockResolvedValueOnce(null);
      const code = await make().generateUniqueInviteCode();
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
      expect(prisma.team.findUnique).toHaveBeenCalledTimes(2);
    });

    it('regenerate retries when the write hits a unique collision', async () => {
      prisma.team.findUnique.mockResolvedValue(null);
      prisma.team.update
        .mockRejectedValueOnce(p2002)
        .mockImplementationOnce(async ({ data }: any) => ({
          id: 't1',
          ...data,
        }));
      const view = await make().regenerateInvitation(student, 't1');
      expect(view.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
      expect(prisma.team.update).toHaveBeenCalledTimes(2);
    });

    it('getInvitation returns the existing code without rewriting it', async () => {
      access.assertLeaderOfTeam.mockResolvedValue({
        id: 't1',
        inviteCode: 'K7QXM2PA',
        inviteCodeUpdatedAt: null,
      });
      await expect(make().getInvitation(student, 't1')).resolves.toMatchObject({
        code: 'K7QXM2PA',
      });
      expect(prisma.team.update).not.toHaveBeenCalled();
    });

    it('getInvitation creates a code for teams that have none', async () => {
      prisma.team.findUnique.mockResolvedValue(null);
      prisma.team.update.mockImplementation(async ({ data }: any) => ({
        id: 't1',
        ...data,
      }));
      const view = await make().getInvitation(student, 't1');
      expect(view.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    });
  });

  describe('removeMember / setLeader', () => {
    it('promotes the earliest remaining member WITH a university identity when the LEADER is removed', async () => {
      prisma.teamMember.findUnique.mockResolvedValue({
        id: 'm2',
        teamId: 't1',
        userId: 's2',
        role: TeamRole.LEADER,
      });
      prisma.teamMember.count.mockResolvedValue(3);
      // m0 joined first but has no university identity; m1 has a student number
      prisma.teamMember.findMany = jest.fn().mockResolvedValue([
        { id: 'm0', user: { role: 'STUDENT', universityId: 'uni-1' } },
        {
          id: 'm1',
          user: {
            role: 'STUDENT',
            universityId: 'uni-1',
            studentNumber: 'S-1',
          },
        },
      ]);

      await make().removeMember(student, 't1', 's2');

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.teamMember.delete).toHaveBeenCalledWith({
        where: { id: 'm2' },
      });
      expect(prisma.teamMember.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: { role: TeamRole.LEADER },
      });
    });

    it('setLeader demotes current leaders then promotes the target', async () => {
      prisma.teamMember.findUnique.mockResolvedValue({
        id: 'm3',
        teamId: 't1',
        userId: 's3',
        user: { role: 'STUDENT', universityId: 'uni-1', studentNumber: 'S-3' },
      });
      await make().setLeader(student, 't1', 's3');
      expect(prisma.teamMember.updateMany).toHaveBeenCalledWith({
        where: { teamId: 't1', role: TeamRole.LEADER },
        data: { role: TeamRole.MEMBER },
      });
      expect(prisma.teamMember.update).toHaveBeenCalledWith({
        where: { id: 'm3' },
        data: { role: TeamRole.LEADER },
      });
    });

    it('setLeader refuses a target without a university identity (409 UNIVERSITY_IDENTITY_REQUIRED)', async () => {
      prisma.teamMember.findUnique.mockResolvedValue({
        id: 'm4',
        teamId: 't1',
        userId: 's4',
        user: { role: 'STUDENT', universityId: 'uni-1', studentNumber: null },
      });
      const err = await make()
        .setLeader(student, 't1', 's4')
        .catch((e) => e);
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse().code).toBe('UNIVERSITY_IDENTITY_REQUIRED');
      expect(prisma.teamMember.updateMany).not.toHaveBeenCalled();
    });
  });
});
