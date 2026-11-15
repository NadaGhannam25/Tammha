import { ProjectSetupReadinessService } from '../project-setup-readiness.service';
import { createInMemoryPrisma } from '@/testing/in-memory-prisma';

/** The pre-integration readiness rules: team name, optional supervisor approval, library handbook. */
describe('Project setup readiness — team, supervisor approval, library handbook', () => {
  async function world(teamName = 'Team Tammha') {
    const db = createInMemoryPrisma();
    const user = await db.user.create({
      data: {
        email: 'l@uni.test',
        password: 'x',
        role: 'STUDENT',
        studentNumber: 'S1',
        emailVerifiedAt: new Date(),
        universityId: 'u1',
      },
    });
    const team = await db.team.create({ data: { name: teamName } });
    await db.teamMember.create({
      data: { teamId: team!.id, userId: user!.id, role: 'LEADER' },
    });
    const project = await db.project.create({
      data: {
        name: 'Tammha',
        teamId: team!.id,
        description: 'd',
        overview: 'o',
        objectives: ['a'],
        category: 'TECHNOLOGY',
        origin: 'NEW',
        startDate: new Date('2026-09-01'),
        endDate: new Date('2027-05-01'),
        setupStep: 'HANDBOOK',
      },
    });
    await db.supervisionRequest.create({
      data: {
        projectId: project!.id,
        supervisorId: 'v1',
        requestedById: user!.id,
        status: 'PENDING',
      },
    });
    const lib = await db.libraryHandbook.create({
      data: { universityId: 'u2', title: 'Other university handbook' },
    });
    const version = await db.universityHandbook.create({
      data: {
        universityId: 'u2',
        handbookId: lib!.id,
        title: 'Other university handbook',
        fileUrl: 'handbooks/library/x.pdf',
        fileName: 'x.pdf',
        fileSize: 10,
        extractedText: 'text',
        extractedChars: 4,
      },
    });
    const select = () => {
      const row = db.project.rows.find((r: any) => r.id === project!.id)!;
      row.handbookSource = 'LIBRARY';
      row.libraryHandbookId = version!.id;
    };
    return { db, project: project!, team: team!, version: version!, select };
  }
  const service = (db: any, approval = '', required = '') =>
    new ProjectSetupReadinessService(db, {
      get: (k: string) =>
        k === 'SETUP_REQUIRE_SUPERVISOR_APPROVAL'
          ? approval
          : k === 'SETUP_REQUIRE_SUPERVISOR'
            ? required
            : undefined,
    } as any);

  it('a selected library version (any university) satisfies the handbook requirement', async () => {
    const { db, project, select } = await world();
    const before = await service(db).evaluate(project.id);
    expect(before.missingRequirements).toEqual(['HANDBOOK_REQUIRED']);
    select();
    const after = await service(db).evaluate(project.id);
    expect(after).toMatchObject({
      canComplete: true,
      handbookState: 'READY',
      handbookSource: 'LIBRARY',
      missingRequirements: [],
    });
  });

  it('a blank team name blocks completion', async () => {
    const { db, project } = await world('   ');
    const r = await service(db).evaluate(project.id);
    expect(r.missingRequirements).toContain('TEAM_NAME_REQUIRED');
  });

  it('SETUP_REQUIRE_SUPERVISOR_APPROVAL=true: a pending request is not enough', async () => {
    const { db, project, select } = await world();
    select();
    expect(
      (await service(db, 'true').evaluate(project.id)).missingRequirements,
    ).toEqual(['SUPERVISOR_APPROVAL_REQUIRED']);
    db.supervisionRequest.rows[0].status = 'ACCEPTED';
    expect((await service(db, 'true').evaluate(project.id)).canComplete).toBe(
      true,
    );
    // default (not set): a pending request is enough
    db.supervisionRequest.rows[0].status = 'PENDING';
    expect((await service(db).evaluate(project.id)).canComplete).toBe(true);
  });

  it('default: the academic supervisor is optional (no request, rejected or cancelled)', async () => {
    const { db, project, select } = await world();
    select();
    for (const status of ['REJECTED', 'CANCELLED']) {
      db.supervisionRequest.rows[0].status = status;
      const r = await service(db).evaluate(project.id);
      expect(r.missingRequirements).toEqual([]);
      expect(r.canComplete).toBe(true);
      expect(r.supervisorRequestStatus).toBeNull();
    }
    db.supervisionRequest.rows.splice(0);
    expect((await service(db).evaluate(project.id)).canComplete).toBe(true);
  });

  it('SETUP_REQUIRE_SUPERVISOR=true: a request is required again', async () => {
    const { db, project, select } = await world();
    select();
    db.supervisionRequest.rows.splice(0);
    expect(
      (await service(db, '', 'true').evaluate(project.id)).missingRequirements,
    ).toEqual(['SUPERVISOR_REQUEST_REQUIRED']);
    // approval implies a required supervisor
    expect(
      (await service(db, 'true').evaluate(project.id)).missingRequirements,
    ).toEqual(['SUPERVISOR_REQUEST_REQUIRED']);
  });
});
