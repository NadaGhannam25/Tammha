import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { PrismaService } from '@/prisma/prisma.service';
import { configureApp, createSwaggerDocument } from '@/app.setup';
import { testConfigModule } from '@/testing/test-env';
import { AuthModule } from '@modules/auth/auth.module';
import { ProjectsModule } from '@modules/projects/projects.module';
import { TeamsModule } from '@modules/teams/teams.module';
import {
  createInMemoryPrisma,
  InMemoryPrisma,
} from '@/testing/in-memory-prisma';

/**
 * HTTP integration tests for Project Workspace + Team Management.
 * Real: controllers, services, JWT strategy/guard, RolesGuard, ValidationPipe,
 * exception filter. PrismaService is replaced by an in-memory test store.
 */
describe('Project workspace & teams (integration)', () => {
  let app: INestApplication;
  let db: InMemoryPrisma;
  let jwt: JwtService;

  const users: Record<string, { id: string; token: string }> = {};
  const BASE = '/api/v1';

  async function seedUser(
    key: string,
    role: string,
    extra: Record<string, unknown> = {},
  ) {
    const u = await db.user.create({
      data: {
        email: `${key}@test.local`,
        password: 'not-used-in-these-tests',
        firstName: key,
        role,
        // students need a university identity (student number or verified university e-mail)
        studentNumber: role === 'STUDENT' ? `SN-${key.toUpperCase()}` : null,
        universityId: 'uni-test',
        ...extra,
      },
    });
    users[key] = {
      id: u!.id,
      token: jwt.sign({ sub: u!.id, email: u!.email, role }),
    };
  }

  const http = () => request(app.getHttpServer());
  const as = (key: string) => ({ Authorization: `Bearer ${users[key].token}` });

  beforeAll(async () => {
    db = createInMemoryPrisma();
    const moduleRef = await Test.createTestingModule({
      imports: [
        testConfigModule({
          // trailing slash on purpose: link building must not double it
          INVITATION_LINK_BASE_URL: 'https://tammha.test/join/',
          TEAM_MAX_MEMBERS: '4',
        }),
        AuthModule,
        TeamsModule,
        ProjectsModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(db)
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    jwt = app.get(JwtService);

    await seedUser('alice', 'STUDENT');
    await seedUser('bob', 'STUDENT');
    await seedUser('carol', 'STUDENT');
    await seedUser('dave', 'STUDENT');
    await seedUser('erin', 'STUDENT');
    await seedUser('frank', 'STUDENT');
    await seedUser('ghost', 'STUDENT', { isActive: false });
    await seedUser('mallory', 'STUDENT', { universityId: 'uni-other' });
    await seedUser('nouni', 'STUDENT', { universityId: null });
    await seedUser('supA', 'SUPERVISOR');
    await seedUser('supB', 'SUPERVISOR');
    await seedUser('supX', 'SUPERVISOR', { universityId: 'uni-other' });
    await seedUser('supOff', 'SUPERVISOR', { isActive: false });
  });

  afterAll(async () => {
    await app.close();
  });

  let projectId = '';
  let teamId = '';
  let inviteCode = '';
  let inviteLink = '';

  // ----------------------------------------------------------------
  describe('Swagger', () => {
    it('builds the OpenAPI document with the new routes', () => {
      const doc = createSwaggerDocument(app);
      expect(doc.paths).toHaveProperty('/api/v1/projects');
      expect(doc.paths).toHaveProperty('/api/v1/projects/me');
      expect(doc.paths).toHaveProperty('/api/v1/projects/supervised');
      expect(doc.paths).toHaveProperty('/api/v1/teams/join');
      expect(doc.paths).toHaveProperty('/api/v1/teams/{id}/invitation');
      expect(doc.paths).toHaveProperty(
        '/api/v1/supervision-requests/{requestId}/accept',
      );
    });
  });

  // ----------------------------------------------------------------
  describe('Create workspace', () => {
    it('401 without token', async () => {
      await http()
        .post(`${BASE}/projects`)
        .send({ name: 'X project' })
        .expect(401);
    });

    it('403 for SUPERVISOR', async () => {
      await http()
        .post(`${BASE}/projects`)
        .set(as('supA'))
        .send({ name: 'Sup project' })
        .expect(403);
    });

    it('400 on invalid body (unknown field, short name)', async () => {
      const res = await http()
        .post(`${BASE}/projects`)
        .set(as('alice'))
        .send({ name: 'ab', status: 'COMPLETED' })
        .expect(400);
      expect(Array.isArray(res.body.message)).toBe(true);
    });

    it('400 INVALID_DATE_RANGE when endDate < startDate', async () => {
      const res = await http()
        .post(`${BASE}/projects`)
        .set(as('alice'))
        .send({
          name: 'Tammha',
          startDate: '2027-01-01',
          endDate: '2026-01-01',
        })
        .expect(400);
      expect(res.body.code).toBe('INVALID_DATE_RANGE');
    });

    it('201 creates project + team + invitation; creator is LEADER', async () => {
      const res = await http()
        .post(`${BASE}/projects`)
        .set(as('alice'))
        .send({
          name: '  Tammha Platform  ',
          description: 'GP management',
          teamName: 'Team Tammha',
          startDate: '2026-09-01',
          endDate: '2027-05-30',
        })
        .expect(201);

      projectId = res.body.project.id;
      teamId = res.body.team.id;
      inviteCode = res.body.invitation.code;
      inviteLink = res.body.invitation.link;

      expect(res.body.project.name).toBe('Tammha Platform');
      expect(res.body.team.name).toBe('Team Tammha');
      expect(res.body.team.members).toHaveLength(1);
      expect(res.body.team.members[0]).toMatchObject({
        userId: users.alice.id,
        teamRole: 'LEADER',
      });
      expect(res.body.team.members[0].user).not.toHaveProperty('password');
      expect(inviteCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
      expect(inviteLink).toBe(`https://tammha.test/join/${inviteCode}`);
      expect(res.body.supervisors).toEqual([]);
    });
  });

  // ----------------------------------------------------------------
  describe('Current workspace', () => {
    it('GET /projects/me returns the student workspace', async () => {
      const res = await http()
        .get(`${BASE}/projects/me`)
        .set(as('alice'))
        .expect(200);
      expect(res.body.project.id).toBe(projectId);
      expect(res.body.invitation.code).toBe(inviteCode);
    });

    it('GET /projects/me 404 NOT_IN_TEAM for a student without a team', async () => {
      const res = await http()
        .get(`${BASE}/projects/me`)
        .set(as('bob'))
        .expect(404);
      expect(res.body.code).toBe('NOT_IN_TEAM');
    });

    it('GET /teams/me returns team + members', async () => {
      const res = await http()
        .get(`${BASE}/teams/me`)
        .set(as('alice'))
        .expect(200);
      expect(res.body).toMatchObject({ id: teamId, projectId, memberCount: 1 });
    });
  });

  // ----------------------------------------------------------------
  describe('Invitations & joining', () => {
    it('preview shows team and project', async () => {
      const res = await http()
        .get(`${BASE}/teams/invitations/${inviteCode.toLowerCase()}`)
        .set(as('bob'))
        .expect(200);
      expect(res.body).toMatchObject({
        teamId,
        projectId,
        projectName: 'Tammha Platform',
        memberCount: 1,
        maxMembers: 4,
      });
    });

    it('400 INVITATION_MALFORMED for a badly formatted code', async () => {
      const res = await http()
        .post(`${BASE}/teams/join`)
        .set(as('bob'))
        .send({ code: 'abc' })
        .expect(400);
      expect(res.body.code).toBe('INVITATION_MALFORMED');
    });

    it('400 when code is missing', async () => {
      await http()
        .post(`${BASE}/teams/join`)
        .set(as('bob'))
        .send({})
        .expect(400);
    });

    it('404 INVITATION_INVALID for a well-formed but unknown code', async () => {
      const unknown = inviteCode === 'ZZZZZZZZ' ? 'YYYYYYYY' : 'ZZZZZZZZ';
      const res = await http()
        .post(`${BASE}/teams/join`)
        .set(as('bob'))
        .send({ code: unknown })
        .expect(404);
      expect(res.body.code).toBe('INVITATION_INVALID');
    });

    it('403 when a SUPERVISOR tries to join', async () => {
      await http()
        .post(`${BASE}/teams/join`)
        .set(as('supA'))
        .send({ code: inviteCode })
        .expect(403);
    });

    it('student joins with the raw code (lowercase + dash accepted)', async () => {
      const messy =
        `${inviteCode.slice(0, 4)}-${inviteCode.slice(4)}`.toLowerCase();
      const res = await http()
        .post(`${BASE}/teams/join`)
        .set(as('bob'))
        .send({ code: messy })
        .expect(200);
      expect(res.body).toEqual({
        message: 'Joined team successfully',
        teamId,
        projectId,
      });
    });

    it('student joins with the full invitation link', async () => {
      await http()
        .post(`${BASE}/teams/join`)
        .set(as('carol'))
        .send({ code: inviteLink })
        .expect(200);
    });

    it('409 ALREADY_IN_THIS_TEAM when joining again', async () => {
      const res = await http()
        .post(`${BASE}/teams/join`)
        .set(as('bob'))
        .send({ code: inviteCode })
        .expect(409);
      expect(res.body.code).toBe('ALREADY_IN_THIS_TEAM');
    });

    it('a student can also be in another team (several projects); each project stays separate', async () => {
      const other = await http()
        .post(`${BASE}/projects`)
        .set(as('erin'))
        .send({ name: 'Other project' })
        .expect(201);
      // bob (member of alice's team) also joins erin's team
      await http()
        .post(`${BASE}/teams/join`)
        .set(as('bob'))
        .send({ code: other.body.invitation.code })
        .expect(200);
      const mine = await http()
        .get(`${BASE}/projects`)
        .set(as('bob'))
        .expect(200);
      expect(mine.body.map((w: any) => w.project.id).sort()).toEqual(
        [projectId, other.body.project.id].sort(),
      );
      // erin still has no access to alice's project
      await http()
        .get(`${BASE}/projects/${projectId}`)
        .set(as('erin'))
        .expect(403);
      // bob leaves erin's team again (keeps the rest of this suite unchanged)
      await http()
        .delete(`${BASE}/teams/${other.body.team.id}/members/${users.bob.id}`)
        .set(as('bob'))
        .expect(200);
    });

    it('regenerating the code invalidates the old one (leader only)', async () => {
      const denied = await http()
        .post(`${BASE}/teams/${teamId}/invitation/regenerate`)
        .set(as('bob')) // P16: a MEMBER cannot manage the invitation
        .expect(403);
      expect(denied.body.code).toBe('NOT_TEAM_LEADER');
      const memberRead = await http()
        .get(`${BASE}/teams/${teamId}/invitation`)
        .set(as('bob'))
        .expect(403);
      expect(memberRead.body.code).toBe('NOT_TEAM_LEADER');

      const res = await http()
        .post(`${BASE}/teams/${teamId}/invitation/regenerate`)
        .set(as('alice'))
        .expect(200);
      expect(res.body.code).not.toBe(inviteCode);

      const old = await http()
        .post(`${BASE}/teams/join`)
        .set(as('dave'))
        .send({ code: inviteCode })
        .expect(404);
      expect(old.body.code).toBe('INVITATION_INVALID');

      inviteCode = res.body.code;
      const current = await http()
        .get(`${BASE}/teams/${teamId}/invitation`)
        .set(as('alice'))
        .expect(200);
      expect(current.body.code).toBe(inviteCode);
    });

    it('403 when a non-member reads the invitation', async () => {
      await http()
        .get(`${BASE}/teams/${teamId}/invitation`)
        .set(as('dave'))
        .expect(403);
    });
  });

  // ----------------------------------------------------------------
  describe('Team members', () => {
    it('adds a student by email (MEMBER label); members cannot', async () => {
      const denied = await http()
        .post(`${BASE}/teams/${teamId}/members`)
        .set(as('carol'))
        .send({ email: 'dave@test.local' })
        .expect(403);
      expect(denied.body.code).toBe('NOT_TEAM_LEADER');
      const res = await http()
        .post(`${BASE}/teams/${teamId}/members`)
        .set(as('alice'))
        .send({ email: 'dave@test.local' })
        .expect(201);
      expect(res.body.map((m: any) => m.userId)).toContain(users.dave.id);
      expect(
        res.body.find((m: any) => m.userId === users.dave.id).teamRole,
      ).toBe('MEMBER');
    });

    it('409 TEAM_FULL when TEAM_MAX_MEMBERS (4) is reached', async () => {
      const res = await http()
        .post(`${BASE}/teams/join`)
        .set(as('frank'))
        .send({ code: inviteCode })
        .expect(409);
      expect(res.body.code).toBe('TEAM_FULL');
    });

    it('rejects adding a supervisor, an inactive user and an unknown email', async () => {
      const a = await http()
        .post(`${BASE}/teams/${teamId}/members`)
        .set(as('alice'))
        .send({ email: 'supA@test.local' })
        .expect(400);
      expect(a.body.code).toBe('USER_NOT_STUDENT');
      const b = await http()
        .post(`${BASE}/teams/${teamId}/members`)
        .set(as('alice'))
        .send({ email: 'ghost@test.local' })
        .expect(400);
      expect(b.body.code).toBe('USER_INACTIVE');
      const c = await http()
        .post(`${BASE}/teams/${teamId}/members`)
        .set(as('alice'))
        .send({ email: 'nobody@test.local' })
        .expect(404);
      expect(c.body.code).toBe('USER_NOT_FOUND');
      await http()
        .post(`${BASE}/teams/${teamId}/members`)
        .set(as('alice'))
        .send({ email: 'not-an-email' })
        .expect(400);
    });

    it('403 when a student of another team manages this team', async () => {
      await http()
        .post(`${BASE}/teams/${teamId}/members`)
        .set(as('erin'))
        .send({ email: 'frank@test.local' })
        .expect(403);
      await http()
        .get(`${BASE}/teams/${teamId}/members`)
        .set(as('erin'))
        .expect(403);
    });

    it('only the leader transfers leadership', async () => {
      const denied = await http()
        .patch(`${BASE}/teams/${teamId}/leader`)
        .set(as('dave'))
        .send({ userId: users.dave.id })
        .expect(403);
      expect(denied.body.code).toBe('NOT_TEAM_LEADER');
      const res = await http()
        .patch(`${BASE}/teams/${teamId}/leader`)
        .set(as('alice'))
        .send({ userId: users.bob.id })
        .expect(200);
      const leaders = res.body.filter((m: any) => m.teamRole === 'LEADER');
      expect(leaders).toHaveLength(1);
      expect(leaders[0].userId).toBe(users.bob.id);
    });

    it('the former leader loses management rights; a leaving LEADER passes the role to the earliest member', async () => {
      const denied = await http()
        .delete(`${BASE}/teams/${teamId}/members/${users.carol.id}`)
        .set(as('alice'))
        .expect(403);
      expect(denied.body.code).toBe('NOT_TEAM_LEADER');

      const res = await http()
        .delete(`${BASE}/teams/${teamId}/members/${users.bob.id}`)
        .set(as('bob'))
        .expect(200);
      expect(res.body.message).toBe('You left the team');
      const leader = res.body.members.find((m: any) => m.teamRole === 'LEADER');
      expect(leader.userId).toBe(users.alice.id);
    });

    it('a removed student can no longer access the project, and can join elsewhere', async () => {
      await http()
        .get(`${BASE}/projects/${projectId}`)
        .set(as('bob'))
        .expect(403);
      const res = await http()
        .get(`${BASE}/projects/me`)
        .set(as('bob'))
        .expect(404);
      expect(res.body.code).toBe('NOT_IN_TEAM');
    });

    it('a student can leave by removing themselves', async () => {
      const res = await http()
        .delete(`${BASE}/teams/${teamId}/members/${users.dave.id}`)
        .set(as('dave'))
        .expect(200);
      expect(res.body.message).toBe('You left the team');
    });

    it('404 MEMBER_NOT_FOUND for a user outside the team', async () => {
      const res = await http()
        .delete(`${BASE}/teams/${teamId}/members/${users.erin.id}`)
        .set(as('alice'))
        .expect(404);
      expect(res.body.code).toBe('MEMBER_NOT_FOUND');
    });

    it('409 LAST_MEMBER when removing the only remaining student', async () => {
      await http()
        .delete(`${BASE}/teams/${teamId}/members/${users.carol.id}`)
        .set(as('alice'))
        .expect(200);
      const res = await http()
        .delete(`${BASE}/teams/${teamId}/members/${users.alice.id}`)
        .set(as('alice'))
        .expect(409);
      expect(res.body.code).toBe('LAST_MEMBER');
    });

    it('updates team name', async () => {
      const res = await http()
        .patch(`${BASE}/teams/${teamId}`)
        .set(as('alice'))
        .send({ name: 'Team Tammha v2', description: null })
        .expect(200);
      expect(res.body).toMatchObject({
        name: 'Team Tammha v2',
        description: null,
      });
    });
  });

  // ----------------------------------------------------------------
  describe('Project details', () => {
    it('updates name/dates', async () => {
      const res = await http()
        .patch(`${BASE}/projects/${projectId}`)
        .set(as('alice'))
        .send({ name: 'Tammha GP Platform', endDate: '2027-06-15' })
        .expect(200);
      expect(res.body.project.name).toBe('Tammha GP Platform');
      expect(res.body.project.endDate).toBe('2027-06-15T00:00:00.000Z');
    });

    it('400 INVALID_DATE_RANGE against the stored startDate', async () => {
      const res = await http()
        .patch(`${BASE}/projects/${projectId}`)
        .set(as('alice'))
        .send({ endDate: '2026-01-01' })
        .expect(400);
      expect(res.body.code).toBe('INVALID_DATE_RANGE');
    });

    it('400 when trying to change status (not editable in this stage)', async () => {
      await http()
        .patch(`${BASE}/projects/${projectId}`)
        .set(as('alice'))
        .send({ status: 'COMPLETED' })
        .expect(400);
    });

    it('403 for a student of another team; 404 for unknown project', async () => {
      const res = await http()
        .patch(`${BASE}/projects/${projectId}`)
        .set(as('erin'))
        .send({ name: 'Hijack' })
        .expect(403);
      expect(res.body.code).toBe('PROJECT_ACCESS_DENIED');
      await http()
        .get(`${BASE}/projects/does-not-exist`)
        .set(as('alice'))
        .expect(404);
    });
  });

  // ----------------------------------------------------------------
  describe('University consistency', () => {
    it('400 UNIVERSITY_REQUIRED when a student without university creates a project', async () => {
      const res = await http()
        .post(`${BASE}/projects`)
        .set(as('nouni'))
        .send({ name: 'No uni project' })
        .expect(400);
      expect(res.body.code).toBe('UNIVERSITY_REQUIRED');
    });

    it('409 UNIVERSITY_MISMATCH when joining a team of another university', async () => {
      const res = await http()
        .post(`${BASE}/teams/join`)
        .set(as('mallory'))
        .send({ code: inviteCode })
        .expect(409);
      expect(res.body.code).toBe('UNIVERSITY_MISMATCH');
      expect(
        db.teamMember.rows.some((m) => m.userId === users.mallory.id),
      ).toBe(false);
    });

    it('409 UNIVERSITY_MISMATCH when adding a student of another university by email', async () => {
      const res = await http()
        .post(`${BASE}/teams/${teamId}/members`)
        .set(as('alice'))
        .send({ email: 'mallory@test.local' })
        .expect(409);
      expect(res.body.code).toBe('UNIVERSITY_MISMATCH');
    });

    it('exposes the team university in the workspace', async () => {
      const res = await http()
        .get(`${BASE}/projects/me`)
        .set(as('alice'))
        .expect(200);
      expect(res.body.team.universityId).toBe('uni-test');
    });
  });

  // ----------------------------------------------------------------
  describe('Supervision requests', () => {
    let firstRequestId = '';

    it('unassigned supervisor: empty list and 403 on the project', async () => {
      const list = await http()
        .get(`${BASE}/projects/supervised`)
        .set(as('supA'))
        .expect(200);
      expect(list.body).toEqual([]);
      await http()
        .get(`${BASE}/projects/${projectId}`)
        .set(as('supA'))
        .expect(403);
      await http()
        .get(`${BASE}/teams/${teamId}/members`)
        .set(as('supA'))
        .expect(403);
    });

    it('lists only active supervisors of the student university', async () => {
      const res = await http()
        .get(`${BASE}/supervision-requests/supervisors`)
        .set(as('alice'))
        .expect(200);
      const ids = res.body.map((u: any) => u.id).sort();
      expect(ids).toEqual([users.supA.id, users.supB.id].sort());
      expect(res.body[0]).not.toHaveProperty('password');
    });

    it('rejects invalid targets: student, other university, inactive, unknown', async () => {
      const send = (email: string) =>
        http()
          .post(`${BASE}/projects/${projectId}/supervision-requests`)
          .set(as('alice'))
          .send({ supervisorEmail: email });

      expect((await send('carol@test.local').expect(400)).body.code).toBe(
        'USER_NOT_SUPERVISOR',
      );
      expect((await send('supX@test.local').expect(409)).body.code).toBe(
        'UNIVERSITY_MISMATCH',
      );
      expect((await send('supOff@test.local').expect(400)).body.code).toBe(
        'USER_INACTIVE',
      );
      expect((await send('nobody@test.local').expect(404)).body.code).toBe(
        'USER_NOT_FOUND',
      );
      await send('not-an-email').expect(400);
    });

    it('only students of the project can send requests', async () => {
      await http()
        .post(`${BASE}/projects/${projectId}/supervision-requests`)
        .set(as('erin'))
        .send({ supervisorEmail: 'supA@test.local' })
        .expect(403);
      await http()
        .post(`${BASE}/projects/${projectId}/supervision-requests`)
        .set(as('supA'))
        .send({ supervisorEmail: 'supA@test.local' })
        .expect(403);
    });

    it('201 creates a PENDING request', async () => {
      const res = await http()
        .post(`${BASE}/projects/${projectId}/supervision-requests`)
        .set(as('alice'))
        .send({
          supervisorEmail: 'supA@test.local',
          message: 'Please supervise us',
        })
        .expect(201);
      firstRequestId = res.body.id;
      expect(res.body).toMatchObject({
        status: 'PENDING',
        message: 'Please supervise us',
        project: { id: projectId },
        supervisor: { id: users.supA.id },
        requestedBy: { id: users.alice.id },
      });
      expect(res.body.supervisor).not.toHaveProperty('password');
    });

    it('409 REQUEST_ALREADY_PENDING for a second request', async () => {
      const res = await http()
        .post(`${BASE}/projects/${projectId}/supervision-requests`)
        .set(as('alice'))
        .send({ supervisorEmail: 'supB@test.local' })
        .expect(409);
      expect(res.body.code).toBe('REQUEST_ALREADY_PENDING');
    });

    it('supervisor sees incoming requests; others do not', async () => {
      const a = await http()
        .get(`${BASE}/supervision-requests/incoming?status=PENDING`)
        .set(as('supA'))
        .expect(200);
      expect(a.body.map((r: any) => r.id)).toEqual([firstRequestId]);
      const b = await http()
        .get(`${BASE}/supervision-requests/incoming`)
        .set(as('supB'))
        .expect(200);
      expect(b.body).toEqual([]);
      await http()
        .get(`${BASE}/supervision-requests/incoming?status=WRONG`)
        .set(as('supA'))
        .expect(400);
      await http()
        .get(`${BASE}/supervision-requests/incoming`)
        .set(as('alice'))
        .expect(403);
    });

    it('a pending request does not grant project access', async () => {
      await http()
        .get(`${BASE}/projects/${projectId}`)
        .set(as('supA'))
        .expect(403);
    });

    it('403 when another supervisor tries to accept or reject', async () => {
      const res = await http()
        .post(`${BASE}/supervision-requests/${firstRequestId}/accept`)
        .set(as('supB'))
        .send({})
        .expect(403);
      expect(res.body.code).toBe('REQUEST_ACCESS_DENIED');
      await http()
        .post(`${BASE}/supervision-requests/${firstRequestId}/reject`)
        .set(as('supB'))
        .send({})
        .expect(403);
    });

    it('supervisor rejects; rejecting again is 409 REQUEST_NOT_PENDING', async () => {
      const res = await http()
        .post(`${BASE}/supervision-requests/${firstRequestId}/reject`)
        .set(as('supA'))
        .send({ note: 'Fully booked this term' })
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'REJECTED',
        responseNote: 'Fully booked this term',
      });

      const again = await http()
        .post(`${BASE}/supervision-requests/${firstRequestId}/accept`)
        .set(as('supA'))
        .send({})
        .expect(409);
      expect(again.body.code).toBe('REQUEST_NOT_PENDING');
    });

    it('student can cancel a pending request; cancelling twice is 409', async () => {
      const created = await http()
        .post(`${BASE}/projects/${projectId}/supervision-requests`)
        .set(as('alice'))
        .send({ supervisorEmail: 'supB@test.local' })
        .expect(201);

      await http()
        .post(`${BASE}/supervision-requests/${created.body.id}/cancel`)
        .set(as('erin'))
        .expect(403);

      const res = await http()
        .post(`${BASE}/supervision-requests/${created.body.id}/cancel`)
        .set(as('alice'))
        .expect(200);
      expect(res.body.status).toBe('CANCELLED');

      await http()
        .post(`${BASE}/supervision-requests/${created.body.id}/cancel`)
        .set(as('alice'))
        .expect(409);
    });

    it('supervisor accepts -> linked via project_members and gains read access', async () => {
      const created = await http()
        .post(`${BASE}/projects/${projectId}/supervision-requests`)
        .set(as('alice'))
        .send({ supervisorEmail: 'supA@test.local' })
        .expect(201);

      const res = await http()
        .post(`${BASE}/supervision-requests/${created.body.id}/accept`)
        .set(as('supA'))
        .send({ note: 'Welcome aboard' })
        .expect(200);
      expect(res.body.status).toBe('ACCEPTED');
      expect(db.projectMember.rows).toEqual([
        expect.objectContaining({
          userId: users.supA.id,
          projectId,
          role: 'PROJECT_MANAGER',
        }),
      ]);

      const list = await http()
        .get(`${BASE}/projects/supervised`)
        .set(as('supA'))
        .expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({
        teamId,
        projectRole: 'PROJECT_MANAGER',
        memberCount: 1,
      });

      const ws = await http()
        .get(`${BASE}/projects/${projectId}`)
        .set(as('supA'))
        .expect(200);
      expect(ws.body.supervisors.map((s: any) => s.userId)).toEqual([
        users.supA.id,
      ]);
      expect(ws.body.invitation).toBeNull();

      await http()
        .get(`${BASE}/teams/${teamId}/members`)
        .set(as('supA'))
        .expect(200);
      const history = await http()
        .get(`${BASE}/projects/${projectId}/supervision-requests`)
        .set(as('supA'))
        .expect(200);
      expect(history.body).toHaveLength(3);
    });

    it('409 SUPERVISOR_ALREADY_ASSIGNED for new requests', async () => {
      const res = await http()
        .post(`${BASE}/projects/${projectId}/supervision-requests`)
        .set(as('alice'))
        .send({ supervisorEmail: 'supB@test.local' })
        .expect(409);
      expect(res.body.code).toBe('SUPERVISOR_ALREADY_ASSIGNED');
    });

    it('accept is re-checked: a stale pending request cannot add a 2nd supervisor', async () => {
      const stale = await db.supervisionRequest.create({
        data: {
          projectId,
          supervisorId: users.supB.id,
          requestedById: users.alice.id,
        },
      });
      const res = await http()
        .post(`${BASE}/supervision-requests/${stale!.id}/accept`)
        .set(as('supB'))
        .send({})
        .expect(409);
      expect(res.body.code).toBe('SUPERVISOR_ALREADY_ASSIGNED');
      expect(db.projectMember.rows).toHaveLength(1);
      await http()
        .get(`${BASE}/projects/${projectId}`)
        .set(as('supB'))
        .expect(403);
    });

    it('accept is re-checked for university consistency', async () => {
      // A request that bypassed creation checks (e.g. data edited manually)
      const other = await http()
        .post(`${BASE}/projects`)
        .set(as('frank'))
        .send({ name: 'Frank project' })
        .expect(201);
      const odd = await db.supervisionRequest.create({
        data: {
          projectId: other.body.project.id,
          supervisorId: users.supX.id,
          requestedById: users.frank.id,
        },
      });
      const res = await http()
        .post(`${BASE}/supervision-requests/${odd!.id}/accept`)
        .set(as('supX'))
        .send({})
        .expect(409);
      expect(res.body.code).toBe('UNIVERSITY_MISMATCH');
    });

    it('supervisor cannot edit project or manage team; other supervisor still blocked', async () => {
      await http()
        .patch(`${BASE}/projects/${projectId}`)
        .set(as('supA'))
        .send({ name: 'Nope' })
        .expect(403);
      await http()
        .get(`${BASE}/teams/${teamId}/invitation`)
        .set(as('supA'))
        .expect(403);
      await http()
        .get(`${BASE}/projects/${projectId}`)
        .set(as('supB'))
        .expect(403);
    });

    it('students see the accepted supervisor in their workspace', async () => {
      const res = await http()
        .get(`${BASE}/projects/me`)
        .set(as('alice'))
        .expect(200);
      expect(res.body.supervisors).toHaveLength(1);
      expect(res.body.supervisors[0].user).not.toHaveProperty('password');
    });

    it('403 for students on the supervised list', async () => {
      await http()
        .get(`${BASE}/projects/supervised`)
        .set(as('alice'))
        .expect(403);
    });
  });
});
