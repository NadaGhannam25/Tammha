import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TeamRole, UserRole } from '@prisma/client';
import { WorkspaceAccessService } from './workspace-access.service';
import { AuthUser } from '@common/types/auth-user.type';

describe('WorkspaceAccessService', () => {
  const prisma = {
    teamMember: { findUnique: jest.fn() },
    project: { findUnique: jest.fn() },
    team: { findUnique: jest.fn() },
    projectMember: { findUnique: jest.fn() },
  };
  const service = new WorkspaceAccessService(prisma as any);

  const user = (id: string, role: UserRole) => ({ id, role }) as AuthUser;
  const project = { id: 'p1', teamId: 't1' };
  const team = { id: 't1' };

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.project.findUnique.mockResolvedValue(project);
    prisma.team.findUnique.mockResolvedValue(team);
  });

  describe('assertCanViewProject', () => {
    it('allows a student of the project team, whatever the TeamRole', async () => {
      for (const role of [TeamRole.MEMBER, TeamRole.LEADER]) {
        prisma.teamMember.findUnique.mockResolvedValue({ teamId: 't1', role });
        await expect(
          service.assertCanViewProject(user('s1', UserRole.STUDENT), 'p1'),
        ).resolves.toBe(project);
      }
    });

    it('denies a student of another team', async () => {
      prisma.teamMember.findUnique.mockResolvedValue({ teamId: 'other' });
      await expect(
        service.assertCanViewProject(user('s1', UserRole.STUDENT), 'p1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('denies a student with no team', async () => {
      prisma.teamMember.findUnique.mockResolvedValue(null);
      await expect(
        service.assertCanViewProject(user('s1', UserRole.STUDENT), 'p1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows only linked supervisors', async () => {
      prisma.projectMember.findUnique.mockResolvedValue({ id: 'pm' });
      await expect(
        service.assertCanViewProject(user('v1', UserRole.SUPERVISOR), 'p1'),
      ).resolves.toBe(project);
      expect(prisma.projectMember.findUnique).toHaveBeenCalledWith({
        where: { userId_projectId: { userId: 'v1', projectId: 'p1' } },
      });

      prisma.projectMember.findUnique.mockResolvedValue(null);
      await expect(
        service.assertCanViewProject(user('v2', UserRole.SUPERVISOR), 'p1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('denies ADMIN in this stage', async () => {
      await expect(
        service.assertCanViewProject(user('a1', UserRole.ADMIN), 'p1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404 when the project does not exist', async () => {
      prisma.project.findUnique.mockResolvedValue(null);
      await expect(
        service.assertCanViewProject(user('s1', UserRole.STUDENT), 'x'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('write access', () => {
    it('supervisors never get student write access, even when linked', async () => {
      prisma.projectMember.findUnique.mockResolvedValue({ id: 'pm' });
      await expect(
        service.assertStudentOfProject(user('v1', UserRole.SUPERVISOR), 'p1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.assertStudentOfTeam(user('v1', UserRole.SUPERVISOR), 't1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('team students (MEMBER label) get write access', async () => {
      prisma.teamMember.findUnique.mockResolvedValue({
        teamId: 't1',
        role: TeamRole.MEMBER,
      });
      await expect(
        service.assertStudentOfTeam(user('s1', UserRole.STUDENT), 't1'),
      ).resolves.toBe(team);
    });

    it('404 for an unknown team', async () => {
      prisma.team.findUnique.mockResolvedValue(null);
      await expect(
        service.assertStudentOfTeam(user('s1', UserRole.STUDENT), 'x'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
