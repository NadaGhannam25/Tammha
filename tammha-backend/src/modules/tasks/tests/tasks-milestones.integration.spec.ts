import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { PrismaService } from '@/prisma/prisma.service';
import { configureApp } from '@/app.setup';
import { testConfigModule } from '@/testing/test-env';
import { AuthModule } from '@modules/auth/auth.module';
import { ProjectsModule } from '@modules/projects/projects.module';
import { TeamsModule } from '@modules/teams/teams.module';
import { TasksModule } from '@modules/tasks/tasks.module';
import { MilestonesModule } from '@modules/milestones/milestones.module';
import {
  createInMemoryPrisma,
  InMemoryPrisma,
} from '@/testing/in-memory-prisma';

/**
 * HTTP integration tests for tasks and milestones.
 * Real: controllers, services, JWT/Roles guards, ValidationPipe, error filter.
 * PrismaService is replaced by the in-memory test store.
 */
describe('Tasks & milestones (integration)', () => {
  let app: INestApplication;
  let db: InMemoryPrisma;
  let jwt: JwtService;
  const API = '/api/v1';
  const DAY = 24 * 60 * 60 * 1000;
  const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();

  const users: Record<string, { id: string; token: string }> = {};
  const as = (key: string) => ({ Authorization: `Bearer ${users[key].token}` });
  const http = () => request(app.getHttpServer());

  let projectA = '';
  let teamA = '';
  let projectB = '';

  async function seedUser(key: string, role: string) {
    const u = await db.user.create({
      data: {
        email: `${key}@test.local`,
        password: 'unused',
        firstName: key,
        role,
        // students need a university identity (student number or verified university e-mail)
        studentNumber: role === 'STUDENT' ? `SN-${key.toUpperCase()}` : null,
        universityId: 'uni-1',
      },
    });
    users[key] = {
      id: u!.id,
      token: jwt.sign({ sub: u!.id, email: u!.email, role }),
    };
  }

  beforeAll(async () => {
    db = createInMemoryPrisma();
    const moduleRef = await Test.createTestingModule({
      imports: [
        testConfigModule(),
        AuthModule,
        TeamsModule,
        ProjectsModule,
        TasksModule,
        MilestonesModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(db)
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    jwt = app.get(JwtService);

    for (const s of ['alice', 'bob', 'carol', 'erin'])
      await seedUser(s, 'STUDENT');
    await seedUser('supA', 'SUPERVISOR');
    await seedUser('supB', 'SUPERVISOR');

    // Project A: alice + bob + carol. Project B: erin.
    const a = await http()
      .post(`${API}/projects`)
      .set(as('alice'))
      .send({ name: 'Project A' })
      .expect(201);
    projectA = a.body.project.id;
    teamA = a.body.team.id;
    for (const s of ['bob', 'carol']) {
      await http()
        .post(`${API}/teams/join`)
        .set(as(s))
        .send({ code: a.body.invitation.code })
        .expect(200);
    }
    const b = await http()
      .post(`${API}/projects`)
      .set(as('erin'))
      .send({ name: 'Project B' })
      .expect(201);
    projectB = b.body.project.id;

    // supA supervises project A (through the real request/accept flow)
    const req = await http()
      .post(`${API}/projects/${projectA}/supervision-requests`)
      .set(as('alice'))
      .send({ supervisorEmail: 'supA@test.local' })
      .expect(201);
    await http()
      .post(`${API}/supervision-requests/${req.body.id}/accept`)
      .set(as('supA'))
      .send({})
      .expect(200);
  });

  afterAll(async () => {
    await app?.close();
  });

  // ==================================================================
  describe('Milestones', () => {
    let m1 = '';

    it('creates a milestone (any student of the team; not another team)', async () => {
      const denied = await http()
        .post(`${API}/milestones`)
        .set(as('erin'))
        .send({ projectId: projectA, title: 'Chapter 3', dueDate: inDays(30) })
        .expect(403);
      expect(denied.body.code).toBe('PROJECT_ACCESS_DENIED');
      const res = await http()
        .post(`${API}/milestones`)
        .set(as('alice'))
        .send({ projectId: projectA, title: 'Chapter 3', dueDate: inDays(30) })
        .expect(201);
      m1 = res.body.id;
      expect(res.body).toMatchObject({
        projectId: projectA,
        // the project's first stage becomes the current stage automatically
        status: 'IN_PROGRESS',
        isOverdue: false,
        progress: { totalTasks: 0, completedTasks: 0, percent: 0 },
      });
    });

    it('validates input: dueDate required, OVERDUE not settable, unknown fields rejected', async () => {
      await http()
        .post(`${API}/milestones`)
        .set(as('alice'))
        .send({ projectId: projectA, title: 'X1' })
        .expect(400);
      await http()
        .post(`${API}/milestones`)
        .set(as('alice'))
        .send({
          projectId: projectA,
          title: 'X1',
          dueDate: inDays(3),
          status: 'OVERDUE',
        })
        .expect(400);
      await http()
        .post(`${API}/milestones`)
        .set(as('alice'))
        .send({
          projectId: projectA,
          title: 'X1',
          dueDate: inDays(3),
          createdById: 'x',
        })
        .expect(400);
    });

    it('403 for another team, supervisors and unrelated supervisors on writes', async () => {
      const body = { projectId: projectA, title: 'Nope', dueDate: inDays(3) };
      const e = await http()
        .post(`${API}/milestones`)
        .set(as('erin'))
        .send(body)
        .expect(403);
      expect(e.body.code).toBe('PROJECT_ACCESS_DENIED');
      await http()
        .post(`${API}/milestones`)
        .set(as('supA'))
        .send(body)
        .expect(403);
      await http()
        .patch(`${API}/milestones/${m1}`)
        .set(as('supA'))
        .send({ title: 'Nope' })
        .expect(403);
      await http()
        .delete(`${API}/milestones/${m1}`)
        .set(as('erin'))
        .expect(403);
    });

    it('updates title/status', async () => {
      await http()
        .patch(`${API}/milestones/${m1}`)
        .set(as('carol'))
        .send({ title: 'Member edit' })
        .expect(200); // every student of the team edits the stages
      const res = await http()
        .patch(`${API}/milestones/${m1}`)
        .set(as('alice'))
        .send({ title: 'Chapter 3: Design', status: 'IN_PROGRESS' })
        .expect(200);
      expect(res.body).toMatchObject({
        title: 'Chapter 3: Design',
        status: 'IN_PROGRESS',
      });
    });

    it('404 MILESTONE_NOT_FOUND', async () => {
      const res = await http()
        .get(`${API}/milestones/nope`)
        .set(as('alice'))
        .expect(404);
      expect(res.body.code).toBe('MILESTONE_NOT_FOUND');
    });

    // shared with the task tests below
    afterAll(() => {
      state.milestoneA = m1;
    });
  });

  const state = { milestoneA: '', taskIds: {} as Record<string, string> };

  // ==================================================================
  describe('Tasks: create & validation', () => {
    it('creates a task with all fields', async () => {
      const due = inDays(5);
      const res = await http()
        .post(`${API}/tasks`)
        .set(as('alice'))
        .send({
          projectId: projectA,
          title: '  Design ERD  ',
          description: 'Entities and relations',
          assignedStudentId: users.bob.id,
          milestoneId: state.milestoneA,
          priority: 'HIGH',
          dueDate: due,
        })
        .expect(201);
      state.taskIds.erd = res.body.id;
      expect(res.body).toMatchObject({
        title: 'Design ERD',
        projectId: projectA,
        status: 'TODO',
        priority: 'HIGH',
        dueDate: due,
        completedAt: null,
        isOverdue: false,
        assignedStudentId: users.bob.id,
        milestone: { id: state.milestoneA, title: 'Chapter 3: Design' },
        createdBy: { id: users.alice.id },
      });
      expect(res.body.assignedStudent).toMatchObject({ id: users.bob.id });
      expect(JSON.stringify(res.body)).not.toContain('password');
    });

    it('members create tasks too: every student manages the project alike', async () => {
      const res = await http()
        .post(`${API}/tasks`)
        .set(as('bob'))
        .send({ projectId: projectA, title: 'Member task' })
        .expect(201);
      expect(res.body.title).toBe('Member task');
      // removed again so the counts below stay as they were
      await http()
        .delete(`${API}/tasks/${res.body.id}`)
        .set(as('bob'))
        .expect(200);
    });

    it('status COMPLETED on create sets completedAt', async () => {
      const res = await http()
        .post(`${API}/tasks`)
        .set(as('alice'))
        .send({
          projectId: projectA,
          title: 'Kickoff meeting',
          status: 'COMPLETED',
        })
        .expect(201);
      state.taskIds.kickoff = res.body.id;
      expect(res.body.completedAt).not.toBeNull();
    });

    it('rejects invalid input (400)', async () => {
      const send = (body: object) =>
        http().post(`${API}/tasks`).set(as('alice')).send(body);
      await send({ projectId: projectA, title: 'x' }).expect(400);
      await send({
        projectId: projectA,
        title: 'Valid',
        status: 'DONE',
      }).expect(400);
      await send({
        projectId: projectA,
        title: 'Valid',
        priority: 'URGENT',
      }).expect(400);
      await send({
        projectId: projectA,
        title: 'Valid',
        dueDate: 'tomorrow',
      }).expect(400);
      await send({
        projectId: projectA,
        title: 'Valid',
        completedAt: inDays(0),
      }).expect(400);
      await send({ title: 'Valid' }).expect(400);
    });

    it('assignee must be a student of the team (not another team, not the supervisor)', async () => {
      for (const who of ['erin', 'supA']) {
        const res = await http()
          .post(`${API}/tasks`)
          .set(as('alice'))
          .send({
            projectId: projectA,
            title: 'Bad assignee',
            assignedStudentId: users[who].id,
          })
          .expect(400);
        expect(res.body.code).toBe('ASSIGNEE_NOT_IN_TEAM');
      }
    });

    it('milestone must belong to the same project', async () => {
      const other = await http()
        .post(`${API}/milestones`)
        .set(as('erin'))
        .send({
          projectId: projectB,
          title: 'B milestone',
          dueDate: inDays(10),
        })
        .expect(201);
      const res = await http()
        .post(`${API}/tasks`)
        .set(as('alice'))
        .send({
          projectId: projectA,
          title: 'Wrong milestone',
          milestoneId: other.body.id,
        })
        .expect(400);
      expect(res.body.code).toBe('MILESTONE_PROJECT_MISMATCH');
      const missing = await http()
        .post(`${API}/tasks`)
        .set(as('alice'))
        .send({
          projectId: projectA,
          title: 'Missing milestone',
          milestoneId: 'nope',
        })
        .expect(404);
      expect(missing.body.code).toBe('MILESTONE_NOT_FOUND');
    });

    it('403: another team cannot create in project A; supervisors cannot create', async () => {
      await http()
        .post(`${API}/tasks`)
        .set(as('erin'))
        .send({ projectId: projectA, title: 'Hack' })
        .expect(403);
      await http()
        .post(`${API}/tasks`)
        .set(as('supA'))
        .send({ projectId: projectA, title: 'Sup task' })
        .expect(403);
    });

    it('seeds more tasks for filtering', async () => {
      const make = async (key: string, who: string, body: object) => {
        const res = await http()
          .post(`${API}/tasks`)
          .set(as(who))
          .send({ projectId: projectA, ...body })
          .expect(201);
        state.taskIds[key] = res.body.id;
      };
      await make('late', 'alice', {
        title: 'Literature review',
        assignedStudentId: users.alice.id,
        dueDate: inDays(-3),
        priority: 'CRITICAL',
        milestoneId: state.milestoneA,
      });
      await make('lateBlocked', 'alice', {
        title: 'Survey analysis',
        status: 'BLOCKED',
        dueDate: inDays(-1),
        priority: 'LOW',
      });
      await make('lateDone', 'alice', {
        title: 'Old report',
        status: 'COMPLETED',
        dueDate: inDays(-10),
      });
      await make('soon', 'alice', {
        title: 'API prototype',
        assignedStudentId: users.carol.id,
        dueDate: inDays(2),
        status: 'IN_PROGRESS',
      });
      await make('far', 'alice', {
        title: 'Final presentation',
        dueDate: inDays(40),
      });
      await make('cancelled', 'alice', {
        title: 'Dropped idea',
        status: 'CANCELLED',
        dueDate: inDays(1),
        milestoneId: state.milestoneA,
      });
      // project B task (must never leak into project A results)
      await http()
        .post(`${API}/tasks`)
        .set(as('erin'))
        .send({ projectId: projectB, title: 'B task', dueDate: inDays(1) })
        .expect(201);
    });
  });

  // ==================================================================
  describe('Tasks: list & filters', () => {
    const list = (who: string, qs = '') =>
      http().get(`${API}/tasks${qs}`).set(as(who));
    const titles = (res: request.Response) =>
      res.body.items.map((t: any) => t.title);

    it('student sees only own project; default sort = dueDate asc, no deadline last', async () => {
      const res = await list('bob').expect(200);
      expect(res.body.meta).toMatchObject({
        total: 8,
        page: 1,
        limit: 20,
        totalPages: 1,
      });
      expect(titles(res)).not.toContain('B task');
      expect(titles(res).slice(-1)[0]).toBe('Kickoff meeting'); // no dueDate
      expect(titles(res)[0]).toBe('Old report'); // -10 days
      const late = res.body.items.find(
        (t: any) => t.title === 'Literature review',
      );
      expect(late.isOverdue).toBe(true);
    });

    it('filters by status (multiple values)', async () => {
      const res = await list('alice', '?status=BLOCKED,IN_PROGRESS').expect(
        200,
      );
      expect(titles(res).sort()).toEqual(['API prototype', 'Survey analysis']);
      const repeated = await list(
        'alice',
        '?status=BLOCKED&status=IN_PROGRESS',
      ).expect(200);
      expect(repeated.body.meta.total).toBe(2);
    });

    it('filters by assignee: id, "me", "none"', async () => {
      const byId = await list(
        'alice',
        `?assignedStudentId=${users.carol.id}`,
      ).expect(200);
      expect(titles(byId)).toEqual(['API prototype']);
      const me = await list('bob', '?assignedStudentId=me').expect(200);
      expect(titles(me)).toEqual(['Design ERD']);
      const none = await list('alice', '?assignedStudentId=none').expect(200);
      expect(none.body.meta.total).toBe(5);
    });

    it('filters by deadline range, no deadline, milestone, priority and search', async () => {
      const range = await list(
        'alice',
        `?dueFrom=${inDays(0)}&dueTo=${inDays(10)}`,
      ).expect(200);
      expect(titles(range).sort()).toEqual([
        'API prototype',
        'Design ERD',
        'Dropped idea',
      ]);

      const noDue = await list('alice', '?noDueDate=true').expect(200);
      expect(titles(noDue)).toEqual(['Kickoff meeting']);
      const noDueFalse = await list('alice', '?noDueDate=false').expect(200);
      expect(noDueFalse.body.meta.total).toBe(8); // "false" must not filter

      const ms = await list('alice', `?milestoneId=${state.milestoneA}`).expect(
        200,
      );
      expect(ms.body.meta.total).toBe(3);
      const noMs = await list('alice', '?milestoneId=none').expect(200);
      expect(noMs.body.meta.total).toBe(5);

      const prio = await list('alice', '?priority=CRITICAL,HIGH').expect(200);
      expect(titles(prio).sort()).toEqual(['Design ERD', 'Literature review']);

      const search = await list('alice', '?search=erd').expect(200);
      expect(titles(search)).toEqual(['Design ERD']);
    });

    it('sorts by priority (most important first) and paginates', async () => {
      const res = await list('alice', '?sortBy=priority&limit=2').expect(200);
      expect(titles(res)).toEqual(['Literature review', 'Design ERD']);
      expect(res.body.meta).toMatchObject({
        total: 8,
        limit: 2,
        totalPages: 4,
      });

      const page2 = await list(
        'alice',
        '?sortBy=priority&limit=2&page=2',
      ).expect(200);
      expect(titles(page2)).not.toContain('Literature review');
    });

    it('rejects invalid filters (400)', async () => {
      await list('alice', '?status=DONE').expect(400);
      await list('alice', '?limit=500').expect(400);
      await list('alice', '?page=0').expect(400);
      await list('alice', '?sortBy=password').expect(400);
      await list('alice', '?noDueDate=maybe').expect(400);
      const range = await list(
        'alice',
        `?dueFrom=${inDays(5)}&dueTo=${inDays(1)}`,
      ).expect(400);
      expect(range.body.code).toBe('INVALID_DATE_RANGE');
    });

    it('project filter: own project ok, other project 403', async () => {
      await list('alice', `?projectId=${projectA}`).expect(200);
      const res = await list('alice', `?projectId=${projectB}`).expect(403);
      expect(res.body.code).toBe('PROJECT_ACCESS_DENIED');
    });
  });

  // ==================================================================
  describe('Overdue & upcoming', () => {
    it('overdue: open tasks past due, most overdue first; completed excluded', async () => {
      const res = await http()
        .get(`${API}/tasks/overdue`)
        .set(as('alice'))
        .expect(200);
      expect(res.body.items.map((t: any) => t.title)).toEqual([
        'Literature review',
        'Survey analysis',
      ]);
      expect(res.body.items.every((t: any) => t.isOverdue)).toBe(true);
    });

    it('overdue for "me"', async () => {
      const res = await http()
        .get(`${API}/tasks/overdue?assignedStudentId=me`)
        .set(as('alice'))
        .expect(200);
      expect(res.body.items.map((t: any) => t.title)).toEqual([
        'Literature review',
      ]);
    });

    it('upcoming: default 7 days, soonest first, cancelled excluded', async () => {
      const res = await http()
        .get(`${API}/tasks/upcoming`)
        .set(as('carol'))
        .expect(200);
      expect(res.body.items.map((t: any) => t.title)).toEqual([
        'API prototype',
        'Design ERD',
      ]);
    });

    it('upcoming: custom window and validation', async () => {
      const res = await http()
        .get(`${API}/tasks/upcoming?days=60`)
        .set(as('carol'))
        .expect(200);
      expect(res.body.items.map((t: any) => t.title)).toContain(
        'Final presentation',
      );
      await http()
        .get(`${API}/tasks/upcoming?days=0`)
        .set(as('carol'))
        .expect(400);
      await http()
        .get(`${API}/tasks/upcoming?days=91`)
        .set(as('carol'))
        .expect(400);
    });

    it('"me" is for students only', async () => {
      await http()
        .get(`${API}/tasks/overdue?assignedStudentId=me`)
        .set(as('supA'))
        .expect(400);
    });
  });

  // ==================================================================
  describe('Tasks: update, completion, delete', () => {
    it('COMPLETED sets completedAt; reopening clears it', async () => {
      const id = state.taskIds.erd;
      const done = await http()
        .patch(`${API}/tasks/${id}`)
        .set(as('bob'))
        .send({ status: 'COMPLETED' })
        .expect(200);
      expect(done.body.completedAt).not.toBeNull();
      expect(done.body.isOverdue).toBe(false);

      const reopened = await http()
        .patch(`${API}/tasks/${id}`)
        .set(as('bob'))
        .send({ status: 'IN_REVIEW' })
        .expect(200);
      expect(reopened.body.completedAt).toBeNull();

      await http()
        .patch(`${API}/tasks/${id}`)
        .set(as('bob'))
        .send({ status: 'COMPLETED' })
        .expect(200);
    });

    it('status changes follow the allowed transitions; any student cancels or restores', async () => {
      const id = state.taskIds.erd; // COMPLETED, assigned to bob
      const cancel = await http()
        .patch(`${API}/tasks/${id}`)
        .set(as('bob'))
        .send({ status: 'CANCELLED' })
        .expect(409);
      expect(cancel.body).toMatchObject({
        code: 'INVALID_STATUS_TRANSITION',
        details: { from: 'COMPLETED', to: 'CANCELLED' },
      });
      const blocked = await http()
        .patch(`${API}/tasks/${id}`)
        .set(as('bob'))
        .send({ status: 'BLOCKED' })
        .expect(409);
      expect(blocked.body.details.allowed).toEqual([
        'IN_PROGRESS',
        'IN_REVIEW',
        'TODO',
      ]);
      // the leader reopens, cancels, and restores a cancelled task
      for (const status of ['IN_PROGRESS', 'CANCELLED']) {
        await http()
          .patch(`${API}/tasks/${id}`)
          .set(as('alice'))
          .send({ status })
          .expect(200);
      }
      await http()
        .patch(`${API}/tasks/${id}`)
        .set(as('alice'))
        .send({ status: 'COMPLETED' })
        .expect(409); // a cancelled task is restored to TODO first
      // a member restores it as well
      await http()
        .patch(`${API}/tasks/${id}`)
        .set(as('bob'))
        .send({ status: 'TODO' })
        .expect(200);
      await http()
        .patch(`${API}/tasks/${id}`)
        .set(as('bob'))
        .send({ status: 'COMPLETED' })
        .expect(200);
    });

    it('a member manages any task like the leader: fields, assignee and status', async () => {
      const erd = await http()
        .get(`${API}/tasks/${state.taskIds.erd}`)
        .set(as('alice'))
        .expect(200);
      const late = await http()
        .get(`${API}/tasks/${state.taskIds.late}`)
        .set(as('alice'))
        .expect(200);
      const renamed = await http()
        .patch(`${API}/tasks/${state.taskIds.erd}`)
        .set(as('bob'))
        .send({ title: 'Renamed by member' })
        .expect(200);
      expect(renamed.body.title).toBe('Renamed by member');
      await http()
        .patch(`${API}/tasks/${state.taskIds.erd}`)
        .set(as('bob'))
        .send({ title: erd.body.title })
        .expect(200);
      // a task assigned to someone else, and an unassigned one
      const notMine = await http()
        .patch(`${API}/tasks/${state.taskIds.late}`)
        .set(as('carol'))
        .send({ priority: 'HIGH' })
        .expect(200);
      expect(notMine.body.priority).toBe('HIGH');
      await http()
        .patch(`${API}/tasks/${state.taskIds.late}`)
        .set(as('carol'))
        .send({ priority: late.body.priority })
        .expect(200);
    });

    it('the leader reassigns a task and the new assignee is notified once', async () => {
      const before = db.notification.rows.filter(
        (n) => n.userId === users.carol.id && n.type === 'TASK_ASSIGNED',
      ).length;
      const res = await http()
        .patch(`${API}/tasks/${state.taskIds.lateBlocked}`)
        .set(as('alice'))
        .send({ assignedStudentId: users.carol.id })
        .expect(200);
      expect(res.body.assignedStudentId).toBe(users.carol.id);
      // same assignee again: no duplicate notification
      await http()
        .patch(`${API}/tasks/${state.taskIds.lateBlocked}`)
        .set(as('alice'))
        .send({ assignedStudentId: users.carol.id })
        .expect(200);
      const after = db.notification.rows.filter(
        (n) => n.userId === users.carol.id && n.type === 'TASK_ASSIGNED',
      );
      expect(after).toHaveLength(before + 1);
      expect(after[after.length - 1].data).toMatchObject({
        taskId: state.taskIds.lateBlocked,
        projectId: projectA,
      });
      // restore for the filter tests that follow
      await http()
        .patch(`${API}/tasks/${state.taskIds.lateBlocked}`)
        .set(as('alice'))
        .send({ assignedStudentId: null })
        .expect(200);
    });

    it('null clears assignee, milestone, dueDate, description', async () => {
      const res = await http()
        .patch(`${API}/tasks/${state.taskIds.far}`)
        .set(as('alice'))
        .send({
          assignedStudentId: null,
          milestoneId: null,
          dueDate: null,
          description: null,
        })
        .expect(200);
      expect(res.body).toMatchObject({
        assignedStudentId: null,
        milestone: null,
        dueDate: null,
        description: null,
      });
    });

    it('cannot reassign to a non-member; projectId cannot change', async () => {
      const res = await http()
        .patch(`${API}/tasks/${state.taskIds.far}`)
        .set(as('alice'))
        .send({ assignedStudentId: users.erin.id })
        .expect(400);
      expect(res.body.code).toBe('ASSIGNEE_NOT_IN_TEAM');
      await http()
        .patch(`${API}/tasks/${state.taskIds.far}`)
        .set(as('alice'))
        .send({ projectId: projectB })
        .expect(400);
    });

    it('403 for another team and for supervisors; 404 for unknown task', async () => {
      await http()
        .patch(`${API}/tasks/${state.taskIds.far}`)
        .set(as('erin'))
        .send({ title: 'Hack' })
        .expect(403);
      await http()
        .patch(`${API}/tasks/${state.taskIds.far}`)
        .set(as('supA'))
        .send({ title: 'Hack' })
        .expect(403);
      await http()
        .delete(`${API}/tasks/${state.taskIds.far}`)
        .set(as('supA'))
        .expect(403);
      await http()
        .get(`${API}/tasks/${state.taskIds.far}`)
        .set(as('erin'))
        .expect(403);
      const missing = await http()
        .get(`${API}/tasks/nope`)
        .set(as('alice'))
        .expect(404);
      expect(missing.body.code).toBe('TASK_NOT_FOUND');
    });

    it('deletes a task (any student of the team; not another team)', async () => {
      const denied = await http()
        .delete(`${API}/tasks/${state.taskIds.far}`)
        .set(as('erin'))
        .expect(403);
      expect(denied.body.code).toBe('PROJECT_ACCESS_DENIED');
      await http()
        .delete(`${API}/tasks/${state.taskIds.far}`)
        .set(as('alice'))
        .expect(200);
      await http()
        .get(`${API}/tasks/${state.taskIds.far}`)
        .set(as('carol'))
        .expect(404);
    });
  });

  // ==================================================================
  describe('Milestone progress', () => {
    it('counts linked tasks (cancelled excluded) and overdue ones', async () => {
      // linked: Design ERD (COMPLETED), Literature review (TODO, overdue), Dropped idea (CANCELLED)
      const res = await http()
        .get(`${API}/milestones/${state.milestoneA}`)
        .set(as('alice'))
        .expect(200);
      expect(res.body.progress).toEqual({
        totalTasks: 2,
        completedTasks: 1,
        openTasks: 1,
        overdueTasks: 1,
        percent: 50,
      });
    });

    it('lists milestones with progress, sorted by dueDate; overdue filter', async () => {
      const past = await http()
        .post(`${API}/milestones`)
        .set(as('alice'))
        .send({ projectId: projectA, title: 'Proposal', dueDate: inDays(-2) })
        .expect(201);
      expect(past.body.isOverdue).toBe(true);
      await http()
        .post(`${API}/milestones`)
        .set(as('alice'))
        .send({
          projectId: projectA,
          title: 'Ethics form',
          dueDate: inDays(-5),
          status: 'COMPLETED',
        })
        .expect(201);

      const all = await http()
        .get(`${API}/milestones`)
        .set(as('bob'))
        .expect(200);
      expect(all.body.items.map((m: any) => m.title)).toEqual([
        'Ethics form',
        'Proposal',
        'Chapter 3: Design',
      ]);
      expect(all.body.items[2].progress.percent).toBe(50);

      const overdue = await http()
        .get(`${API}/milestones?overdue=true`)
        .set(as('bob'))
        .expect(200);
      expect(overdue.body.items.map((m: any) => m.title)).toEqual(['Proposal']);

      const done = await http()
        .get(`${API}/milestones?status=COMPLETED`)
        .set(as('bob'))
        .expect(200);
      expect(done.body.items.map((m: any) => m.title)).toEqual(['Ethics form']);
    });
  });

  // ==================================================================
  describe('Supervisors', () => {
    it('assigned supervisor reads tasks and milestones of the supervised project', async () => {
      const tasks = await http()
        .get(`${API}/tasks`)
        .set(as('supA'))
        .expect(200);
      expect(tasks.body.items.length).toBeGreaterThan(0);
      expect(tasks.body.items.every((t: any) => t.projectId === projectA)).toBe(
        true,
      );
      await http()
        .get(`${API}/tasks/${state.taskIds.erd}`)
        .set(as('supA'))
        .expect(200);
      await http().get(`${API}/tasks/overdue`).set(as('supA')).expect(200);
      const ms = await http()
        .get(`${API}/milestones`)
        .set(as('supA'))
        .expect(200);
      expect(ms.body.meta.total).toBe(3);
    });

    it('unassigned supervisor sees nothing and gets 403 on project A', async () => {
      const tasks = await http()
        .get(`${API}/tasks`)
        .set(as('supB'))
        .expect(200);
      expect(tasks.body.meta.total).toBe(0);
      await http()
        .get(`${API}/tasks?projectId=${projectA}`)
        .set(as('supB'))
        .expect(403);
      await http()
        .get(`${API}/tasks/${state.taskIds.erd}`)
        .set(as('supB'))
        .expect(403);
      await http()
        .get(`${API}/milestones/${state.milestoneA}`)
        .set(as('supB'))
        .expect(403);
    });
  });

  // ==================================================================
  describe('Consistency with team changes and deletes', () => {
    it("removing a member unassigns their open tasks but keeps completed ones' assignee", async () => {
      // carol has: API prototype (IN_PROGRESS). Give her a completed task too.
      const done = await http()
        .post(`${API}/tasks`)
        .set(as('alice'))
        .send({
          projectId: projectA,
          title: 'Done by carol',
          assignedStudentId: users.carol.id,
          status: 'COMPLETED',
        })
        .expect(201);

      await http()
        .delete(`${API}/teams/${teamA}/members/${users.carol.id}`)
        .set(as('alice'))
        .expect(200);

      const open = await http()
        .get(`${API}/tasks/${state.taskIds.soon}`)
        .set(as('alice'))
        .expect(200);
      expect(open.body.assignedStudentId).toBeNull();
      const kept = await http()
        .get(`${API}/tasks/${done.body.id}`)
        .set(as('alice'))
        .expect(200);
      expect(kept.body.assignedStudentId).toBe(users.carol.id);

      // and carol has lost access
      await http()
        .get(`${API}/tasks/${state.taskIds.soon}`)
        .set(as('carol'))
        .expect(403);
    });

    it('deleting a milestone keeps its tasks (milestone link cleared)', async () => {
      // a member deletes it (every student of the team manages the stages)
      await http()
        .delete(`${API}/milestones/${state.milestoneA}`)
        .set(as('bob'))
        .expect(200);
      const task = await http()
        .get(`${API}/tasks/${state.taskIds.late}`)
        .set(as('bob'))
        .expect(200);
      expect(task.body.milestone).toBeNull();
    });
  });
});
