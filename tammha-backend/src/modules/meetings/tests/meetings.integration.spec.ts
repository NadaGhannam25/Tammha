import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { PrismaService } from '@/prisma/prisma.service';
import { configureApp, createSwaggerDocument } from '@/app.setup';
import { testConfigModule, TestEnvOverrides } from '@/testing/test-env';
import {
  createInMemoryPrisma,
  InMemoryPrisma,
} from '@/testing/in-memory-prisma';
import { verifyHs256 } from '@/testing/verify-hs256';
import { AuthModule } from '@modules/auth/auth.module';
import { ProjectsModule } from '@modules/projects/projects.module';
import { TeamsModule } from '@modules/teams/teams.module';
import { MeetingsModule } from '@modules/meetings/meetings.module';
import { IntegrationsModule } from '@/integrations/integrations.module';

/**
 * P12 meetings + LiveKit join tokens.
 * LiveKit uses FAKE test credentials; tokens are signed locally and verified here with
 * Node's crypto. Nothing is sent to LiveKit (the SDK only signs a JWT).
 */
const FAKE_LIVEKIT = {
  LIVEKIT_ENABLED: 'true',
  LIVEKIT_URL: 'https://tammha-test.livekit.cloud',
  LIVEKIT_API_KEY: 'APItestKeyOnly',
  LIVEKIT_API_SECRET: 'test-only-livekit-secret-not-real-0123456789abcdef',
};

const API = '/api/v1';
const MIN = 60_000;
const HOUR = 60 * MIN;

async function bootApp(overrides: TestEnvOverrides) {
  const db = createInMemoryPrisma();
  const moduleRef = await Test.createTestingModule({
    imports: [
      testConfigModule(overrides),
      IntegrationsModule,
      AuthModule,
      TeamsModule,
      ProjectsModule,
      MeetingsModule,
    ],
  })
    .overrideProvider(PrismaService)
    .useValue(db)
    .compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return { app, db, jwt: app.get(JwtService) };
}

async function seedWorld(
  app: INestApplication,
  db: InMemoryPrisma,
  jwt: JwtService,
) {
  const users: Record<string, { id: string; token: string }> = {};
  const http = () => request(app.getHttpServer());
  const as = (k: string) => ({ Authorization: `Bearer ${users[k].token}` });
  const seed = async (key: string, role: string) => {
    const u = await db.user.create({
      data: {
        email: `${key}@test.local`,
        password: 'unused',
        firstName: key[0].toUpperCase() + key.slice(1),
        lastName: 'Test',
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
  };
  for (const s of ['alice', 'bob', 'erin', 'carl']) await seed(s, 'STUDENT');
  for (const s of ['supA', 'supB']) await seed(s, 'SUPERVISOR');
  await seed('admin', 'ADMIN');

  const supervise = async (student: string, projectId: string, sup: string) => {
    const req = await http()
      .post(`${API}/projects/${projectId}/supervision-requests`)
      .set(as(student))
      .send({ supervisorEmail: `${sup}@test.local` })
      .expect(201);
    await http()
      .post(`${API}/supervision-requests/${req.body.id}/accept`)
      .set(as(sup))
      .send({})
      .expect(200);
  };
  const a = await http()
    .post(`${API}/projects`)
    .set(as('alice'))
    .send({ name: 'Project A' })
    .expect(201);
  await http()
    .post(`${API}/teams/join`)
    .set(as('bob'))
    .send({ code: a.body.invitation.code })
    .expect(200);
  const b = await http()
    .post(`${API}/projects`)
    .set(as('erin'))
    .send({ name: 'Project B' })
    .expect(201);
  await supervise('alice', a.body.project.id, 'supA');
  await supervise('erin', b.body.project.id, 'supB');
  return {
    users,
    http,
    as,
    projectA: a.body.project.id as string,
    projectB: b.body.project.id as string,
  };
}

// ============================================================================
describe('Meetings + LiveKit (integration, fake LiveKit credentials)', () => {
  let app: INestApplication;
  let db: InMemoryPrisma;
  let w: Awaited<ReturnType<typeof seedWorld>>;
  const inMinutes = (m: number) => new Date(Date.now() + m * MIN).toISOString();
  const notesOf = (key: string) =>
    db.notification.rows.filter((n: any) => n.userId === w.users[key].id);
  const meetingRow = (id: string) =>
    db.meeting.rows.find((m: any) => m.id === id)!;
  const schedule = (who: string, body: Record<string, unknown>) =>
    w
      .http()
      .post(`${API}/meetings`)
      .set(w.as(who))
      .send({ projectId: w.projectA, ...body });

  beforeAll(async () => {
    const booted = await bootApp(FAKE_LIVEKIT);
    app = booted.app;
    db = booted.db;
    w = await seedWorld(app, db, booted.jwt);
  });
  afterAll(async () => app?.close());

  // ------------------------------------------------------------------------
  describe('JWT, roles, Swagger', () => {
    it.each([
      ['post', '/meetings'],
      ['get', '/meetings'],
      ['get', '/meetings/upcoming'],
      ['get', '/meetings/x'],
      ['patch', '/meetings/x'],
      ['post', '/meetings/x/cancel'],
      ['post', '/meetings/x/token'],
    ])('%s %s -> 401 without token', async (method, path) => {
      await (w.http() as any)[method](`${API}${path}`).expect(401);
    });

    it('ADMIN is not allowed', async () => {
      await w
        .http()
        .get(`${API}/meetings/upcoming`)
        .set(w.as('admin'))
        .expect(403);
      await schedule('admin', {
        title: 'x',
        scheduledAt: inMinutes(60),
      }).expect(403);
    });

    it('Swagger documents every route', () => {
      const paths = Object.keys(createSwaggerDocument(app).paths);
      expect(paths).toEqual(
        expect.arrayContaining([
          `${API}/meetings`,
          `${API}/meetings/upcoming`,
          `${API}/meetings/{id}`,
          `${API}/meetings/{id}/cancel`,
          `${API}/meetings/{id}/token`,
        ]),
      );
    });
  });

  // ------------------------------------------------------------------------
  describe('Create', () => {
    it('student schedules: whole team + supervisor invited, random room, notifications', async () => {
      db.notification.rows.length = 0;
      const res = await schedule('alice', {
        title: '  Sprint review  ',
        description: 'Demo of chapter 3',
        scheduledAt: inMinutes(120),
        durationMinutes: 45,
        location: 'Room 12',
      }).expect(201);
      expect(res.body).toMatchObject({
        projectId: w.projectA,
        title: 'Sprint review',
        durationMinutes: 45,
        location: 'Room 12',
        status: 'SCHEDULED',
        cancelledAt: null,
        isParticipant: true,
        canManage: true,
        createdBy: { id: w.users.alice.id },
      });
      expect(res.body.roomName).toMatch(/^tammha-[0-9a-f-]{36}$/);
      expect(res.body.roomName).not.toContain(res.body.id);
      expect(res.body.participants.map((p: any) => p.user.id).sort()).toEqual(
        [w.users.alice.id, w.users.bob.id, w.users.supA.id].sort(),
      );
      expect(res.body.participants[0].user.password).toBeUndefined();
      expect(
        new Date(res.body.endsAt).getTime() -
          new Date(res.body.scheduledAt).getTime(),
      ).toBe(45 * MIN);
      expect(res.body.join).toMatchObject({ isOpen: false });

      // P11 meeting notifications: everyone except the organiser
      expect(notesOf('alice')).toHaveLength(0);
      for (const k of ['bob', 'supA']) {
        expect(notesOf(k).map((n: any) => n.type)).toEqual([
          'MEETING_INVITATION',
        ]);
        expect(notesOf(k)[0].data).toMatchObject({
          meetingId: res.body.id,
          projectId: w.projectA,
        });
      }
      expect(notesOf('erin')).toHaveLength(0);
    });

    it('supervisor schedules with chosen participants; the organiser is always included', async () => {
      db.notification.rows.length = 0;
      const res = await schedule('supA', {
        title: 'One-to-one',
        scheduledAt: inMinutes(180),
        participantIds: [w.users.alice.id],
      }).expect(201);
      expect(res.body.participants.map((p: any) => p.user.id).sort()).toEqual(
        [w.users.alice.id, w.users.supA.id].sort(),
      );
      expect(res.body.durationMinutes).toBe(60);
      expect(notesOf('alice')).toHaveLength(1);
      expect(notesOf('bob')).toHaveLength(0);
    });

    it.each([
      [
        'in the past',
        { title: 'Old', scheduledAt: '2020-01-01T10:00:00.000Z' },
        'MEETING_IN_PAST',
      ],
      [
        'outsider participant',
        { title: 'Mixed', scheduledAt: 'FUTURE', participantIds: ['ERIN'] },
        'MEETING_PARTICIPANT_NOT_IN_PROJECT',
      ],
    ])('400 %s', async (_n, body: any, code) => {
      const b = { ...body };
      if (b.scheduledAt === 'FUTURE') b.scheduledAt = inMinutes(60);
      if (b.participantIds) b.participantIds = [w.users.erin.id];
      const res = await schedule('alice', b).expect(400);
      expect(res.body.code).toBe(code);
      if (code === 'MEETING_PARTICIPANT_NOT_IN_PROJECT') {
        expect(res.body.details).toEqual({ userIds: [w.users.erin.id] });
      }
    });

    it.each([
      ['missing title', { scheduledAt: 'FUTURE' }],
      ['short title', { title: 'ab', scheduledAt: 'FUTURE' }],
      [
        'date without time zone',
        { title: 'Meet', scheduledAt: '2030-01-01 10:00' },
      ],
      [
        'duration too short',
        { title: 'Meet', scheduledAt: 'FUTURE', durationMinutes: 3 },
      ],
      [
        'duration too long',
        { title: 'Meet', scheduledAt: 'FUTURE', durationMinutes: 481 },
      ],
      [
        'duplicate participants',
        { title: 'Meet', scheduledAt: 'FUTURE', participantIds: ['x', 'x'] },
      ],
      [
        'unknown field',
        { title: 'Meet', scheduledAt: 'FUTURE', meetingUrl: 'https://evil' },
      ],
    ])('400 validation: %s', async (_n, body: any) => {
      const b = { ...body };
      if (b.scheduledAt === 'FUTURE') b.scheduledAt = inMinutes(60);
      await schedule('alice', b).expect(400);
    });

    it('other projects: 403; unknown project: 404', async () => {
      await schedule('erin', {
        title: 'Hijack',
        scheduledAt: inMinutes(60),
      }).expect(403);
      await schedule('supB', {
        title: 'Hijack',
        scheduledAt: inMinutes(60),
      }).expect(403);
      await schedule('carl', {
        title: 'No team',
        scheduledAt: inMinutes(60),
      }).expect(403);
      await w
        .http()
        .post(`${API}/meetings`)
        .set(w.as('alice'))
        .send({ projectId: 'nope', title: 'Meet', scheduledAt: inMinutes(60) })
        .expect(404);
    });
  });

  // ------------------------------------------------------------------------
  describe('Read', () => {
    let id = '';
    beforeAll(async () => {
      id = (
        await schedule('alice', {
          title: 'Readable',
          scheduledAt: inMinutes(240),
        }).expect(201)
      ).body.id;
    });

    it('details: project members only', async () => {
      const bob = await w
        .http()
        .get(`${API}/meetings/${id}`)
        .set(w.as('bob'))
        .expect(200);
      expect(bob.body).toMatchObject({
        id,
        canManage: false,
        isParticipant: true,
      });
      const sup = await w
        .http()
        .get(`${API}/meetings/${id}`)
        .set(w.as('supA'))
        .expect(200);
      expect(sup.body.canManage).toBe(true);
      for (const k of ['erin', 'supB', 'carl']) {
        const r = await w
          .http()
          .get(`${API}/meetings/${id}`)
          .set(w.as(k))
          .expect(403);
        expect(r.body.code).toBe('PROJECT_ACCESS_DENIED');
      }
      const missing = await w
        .http()
        .get(`${API}/meetings/nope`)
        .set(w.as('alice'))
        .expect(404);
      expect(missing.body.code).toBe('MEETING_NOT_FOUND');
    });

    it('list: own projects only, soonest first, filters', async () => {
      const res = await w
        .http()
        .get(`${API}/meetings`)
        .set(w.as('bob'))
        .expect(200);
      const titles = res.body.items.map((m: any) => m.title);
      expect(titles).toEqual(['Sprint review', 'One-to-one', 'Readable']);
      expect(res.body.meta.total).toBe(3);
      const mine = await w
        .http()
        .get(`${API}/meetings?mine=true`)
        .set(w.as('bob'))
        .expect(200);
      expect(mine.body.items.map((m: any) => m.title)).toEqual([
        'Sprint review',
        'Readable',
      ]);
      const erin = await w
        .http()
        .get(`${API}/meetings`)
        .set(w.as('erin'))
        .expect(200);
      expect(erin.body.items).toEqual([]);
      await w
        .http()
        .get(`${API}/meetings?projectId=${w.projectA}`)
        .set(w.as('erin'))
        .expect(403);
      await w
        .http()
        .get(`${API}/meetings?from=yesterday`)
        .set(w.as('bob'))
        .expect(400);
    });
  });

  // ------------------------------------------------------------------------
  describe('Update', () => {
    let id = '';
    beforeEach(async () => {
      id = (
        await schedule('alice', {
          title: 'Planning',
          scheduledAt: inMinutes(300),
        }).expect(201)
      ).body.id;
      db.notification.rows.length = 0;
    });
    const patch = (who: string, body: Record<string, unknown>) =>
      w.http().patch(`${API}/meetings/${id}`).set(w.as(who)).send(body);

    it('organiser moves the meeting: participants notified (MEETING_UPDATED)', async () => {
      const when = inMinutes(360);
      const res = await patch('alice', {
        scheduledAt: when,
        durationMinutes: 30,
      }).expect(200);
      expect(res.body).toMatchObject({
        scheduledAt: when,
        durationMinutes: 30,
      });
      expect(notesOf('bob').map((n: any) => n.type)).toEqual([
        'MEETING_UPDATED',
      ]);
      expect(notesOf('supA')).toHaveLength(1);
      expect(notesOf('alice')).toHaveLength(0);
    });

    it('a description-only edit does not notify; an unchanged body changes nothing', async () => {
      await patch('alice', { description: 'Agenda attached' }).expect(200);
      const before = meetingRow(id).updatedAt;
      await patch('alice', { title: 'Planning' }).expect(200);
      expect(meetingRow(id).updatedAt).toEqual(before);
      expect(db.notification.rows).toHaveLength(0);
    });

    it('the project supervisor may edit; other members may not', async () => {
      await patch('supA', { title: 'Planning (moved)' }).expect(200);
      const bob = await patch('bob', { title: 'Mine now' }).expect(403);
      expect(bob.body.code).toBe('MEETING_MANAGE_NOT_ALLOWED');
      await patch('erin', { title: 'x' + 'y'.repeat(5) }).expect(403);
      await patch('supB', { title: 'Nope nope' }).expect(403);
    });

    it('participants: replace the list; new participants are notified', async () => {
      const removed = await patch('alice', {
        participantIds: [w.users.supA.id],
      }).expect(200);
      expect(
        removed.body.participants.map((p: any) => p.user.id).sort(),
      ).toEqual([w.users.alice.id, w.users.supA.id].sort());
      expect(notesOf('bob')).toHaveLength(0);
      const added = await patch('alice', {
        participantIds: [w.users.supA.id, w.users.bob.id],
      }).expect(200);
      expect(added.body.participants).toHaveLength(3);
      expect(notesOf('bob').map((n: any) => n.type)).toEqual([
        'MEETING_UPDATED',
      ]);
      const bad = await patch('alice', {
        participantIds: [w.users.erin.id],
      }).expect(400);
      expect(bad.body.code).toBe('MEETING_PARTICIPANT_NOT_IN_PROJECT');
    });

    it('validation: past time, project cannot change, unknown fields', async () => {
      const past = await patch('alice', {
        scheduledAt: '2021-05-05T10:00:00.000Z',
      }).expect(400);
      expect(past.body.code).toBe('MEETING_IN_PAST');
      await patch('alice', { projectId: w.projectB }).expect(400);
      await patch('alice', { status: 'COMPLETED' }).expect(400);
    });

    it('an ended meeting cannot be changed', async () => {
      const row = meetingRow(id);
      row.scheduledAt = new Date(Date.now() - 3 * HOUR);
      const res = await patch('alice', { title: 'Too late' }).expect(409);
      expect(res.body.code).toBe('MEETING_ENDED');
    });
  });

  // ------------------------------------------------------------------------
  describe('Cancel', () => {
    let id = '';
    beforeAll(async () => {
      id = (
        await schedule('alice', {
          title: 'To cancel',
          scheduledAt: inMinutes(400),
        }).expect(201)
      ).body.id;
      db.notification.rows.length = 0;
    });
    const cancel = (who: string, body: Record<string, unknown> = {}) =>
      w.http().post(`${API}/meetings/${id}/cancel`).set(w.as(who)).send(body);

    it('only the organiser or supervisor can cancel', async () => {
      const res = await cancel('bob').expect(403);
      expect(res.body.code).toBe('MEETING_MANAGE_NOT_ALLOWED');
    });

    it('cancel keeps the meeting, records the reason and notifies participants', async () => {
      const res = await cancel('supA', {
        reason: 'Supervisor travelling',
      }).expect(200);
      expect(res.body).toMatchObject({
        status: 'CANCELLED',
        cancellationReason: 'Supervisor travelling',
        join: { isOpen: false },
      });
      expect(res.body.cancelledAt).toBeTruthy();
      for (const k of ['alice', 'bob']) {
        expect(notesOf(k).map((n: any) => n.type)).toEqual([
          'MEETING_CANCELLED',
        ]);
      }
      expect(notesOf('supA')).toHaveLength(0);
    });

    it('cancelled: no second cancel, no edits, hidden from upcoming/list by default', async () => {
      expect((await cancel('alice').expect(409)).body.code).toBe(
        'MEETING_CANCELLED',
      );
      expect(
        (
          await w
            .http()
            .patch(`${API}/meetings/${id}`)
            .set(w.as('alice'))
            .send({ title: 'Back' })
            .expect(409)
        ).body.code,
      ).toBe('MEETING_CANCELLED');
      const up = await w
        .http()
        .get(`${API}/meetings/upcoming`)
        .set(w.as('alice'))
        .expect(200);
      expect(up.body.items.map((m: any) => m.id)).not.toContain(id);
      const list = await w
        .http()
        .get(`${API}/meetings`)
        .set(w.as('alice'))
        .expect(200);
      expect(list.body.items.map((m: any) => m.id)).not.toContain(id);
      const all = await w
        .http()
        .get(`${API}/meetings?includeCancelled=true`)
        .set(w.as('alice'))
        .expect(200);
      expect(all.body.items.map((m: any) => m.id)).toContain(id);
    });
  });

  // ------------------------------------------------------------------------
  describe('Upcoming', () => {
    it('ongoing first, then soonest; window in days', async () => {
      const ongoing = (
        await schedule('alice', {
          title: 'Running now',
          scheduledAt: inMinutes(5),
          durationMinutes: 60,
        }).expect(201)
      ).body.id;
      meetingRow(ongoing).scheduledAt = new Date(Date.now() - 10 * MIN);
      const ended = (
        await schedule('alice', {
          title: 'Finished',
          scheduledAt: inMinutes(5),
          durationMinutes: 30,
        }).expect(201)
      ).body.id;
      meetingRow(ended).scheduledAt = new Date(Date.now() - 2 * HOUR);
      await schedule('alice', {
        title: 'Far away',
        scheduledAt: inMinutes(60 * 24 * 20),
      }).expect(201);

      const res = await w
        .http()
        .get(`${API}/meetings/upcoming?days=7`)
        .set(w.as('bob'))
        .expect(200);
      const titles = res.body.items.map((m: any) => m.title);
      expect(titles[0]).toBe('Running now');
      expect(res.body.items[0].status).toBe('ONGOING');
      expect(titles).not.toContain('Finished');
      expect(titles).not.toContain('Far away');
      const later = await w
        .http()
        .get(`${API}/meetings/upcoming?days=30`)
        .set(w.as('bob'))
        .expect(200);
      expect(later.body.items.map((m: any) => m.title)).toContain('Far away');
      const page = await w
        .http()
        .get(`${API}/meetings/upcoming?limit=1&page=2`)
        .set(w.as('bob'))
        .expect(200);
      expect(page.body.items).toHaveLength(1);
      expect(page.body.meta).toMatchObject({ page: 2, limit: 1 });
      await w
        .http()
        .get(`${API}/meetings/upcoming?days=0`)
        .set(w.as('bob'))
        .expect(400);
      const supB = await w
        .http()
        .get(`${API}/meetings/upcoming`)
        .set(w.as('supB'))
        .expect(200);
      expect(supB.body.items).toEqual([]);
    });
  });

  // ------------------------------------------------------------------------
  describe('LiveKit join token', () => {
    let open = '';
    let privateMeeting = '';
    const token = (who: string, id = open) =>
      w.http().post(`${API}/meetings/${id}/token`).set(w.as(who));

    beforeAll(async () => {
      open = (
        await schedule('alice', {
          title: 'Join me',
          scheduledAt: inMinutes(5),
          durationMinutes: 30,
        }).expect(201)
      ).body.id;
      privateMeeting = (
        await schedule('supA', {
          title: 'Alice only',
          scheduledAt: inMinutes(5),
          participantIds: [w.users.alice.id],
        }).expect(201)
      ).body.id;
    });

    it('a participant gets a short-lived, room-scoped token signed with the server secret', async () => {
      const res = await token('bob').expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const room = meetingRow(open).liveKitRoomName;
      expect(res.body).toMatchObject({
        serverUrl: 'wss://tammha-test.livekit.cloud',
        roomName: room,
        identity: w.users.bob.id,
        displayName: 'Bob Test',
        meetingId: open,
      });

      const claims = verifyHs256(
        res.body.token,
        FAKE_LIVEKIT.LIVEKIT_API_SECRET,
      );
      expect(claims).toMatchObject({
        iss: FAKE_LIVEKIT.LIVEKIT_API_KEY,
        sub: w.users.bob.id,
        name: 'Bob Test',
        video: { room, roomJoin: true, canPublish: true, canSubscribe: true },
      });
      expect(claims.video.roomAdmin).toBeFalsy();
      expect(claims.video.roomCreate).toBeFalsy();
      expect(JSON.parse(claims.metadata)).toEqual({
        meetingId: open,
        projectId: w.projectA,
        role: 'STUDENT',
      });
      // valid until the join window closes (end + 30 min grace), not longer
      const closes =
        new Date(meetingRow(open).scheduledAt).getTime() + (30 + 30) * MIN;
      expect(claims.exp * 1000).toBeLessThanOrEqual(closes + 2000);
      expect(new Date(res.body.expiresAt).getTime()).toBeLessThanOrEqual(
        closes + 2000,
      );
    });

    it('the API secret never appears in any response', async () => {
      const responses = [
        await token('alice').expect(200),
        await w
          .http()
          .get(`${API}/meetings/${open}`)
          .set(w.as('alice'))
          .expect(200),
        await w.http().get(`${API}/meetings`).set(w.as('alice')).expect(200),
        await w
          .http()
          .get(`${API}/integrations/status`)
          .set(w.as('alice'))
          .expect(200),
      ];
      for (const r of responses) {
        expect(JSON.stringify(r.body)).not.toContain(
          FAKE_LIVEKIT.LIVEKIT_API_SECRET,
        );
        expect(JSON.stringify(r.headers)).not.toContain(
          FAKE_LIVEKIT.LIVEKIT_API_SECRET,
        );
      }
    });

    it('the project supervisor (participant) can join; first join time is recorded', async () => {
      await token('supA').expect(200);
      const att = db.meetingAttendee.rows.find(
        (a: any) => a.meetingId === open && a.userId === w.users.supA.id,
      )!;
      expect(att.joinedAt).toBeInstanceOf(Date);
      const first = att.joinedAt;
      await token('supA').expect(200);
      expect(att.joinedAt).toBe(first);
    });

    it('outsiders, ADMIN and non-participants get no token', async () => {
      for (const k of ['erin', 'supB', 'carl']) {
        expect((await token(k).expect(403)).body.code).toBe(
          'PROJECT_ACCESS_DENIED',
        );
      }
      await token('admin').expect(403);
      expect((await token('bob', privateMeeting).expect(403)).body.code).toBe(
        'MEETING_NOT_PARTICIPANT',
      );
      await token('alice', privateMeeting).expect(200);
      await token('alice', 'nope').expect(404);
    });

    it('membership is re-checked on every request: a student who left the team is refused', async () => {
      const membership = db.teamMember.rows.find(
        (m: any) => m.userId === w.users.bob.id,
      )!;
      db.teamMember.rows.splice(db.teamMember.rows.indexOf(membership), 1);
      try {
        const res = await token('bob').expect(403);
        expect(res.body.code).toBe('PROJECT_ACCESS_DENIED');
      } finally {
        db.teamMember.rows.push(membership);
      }
      await token('bob').expect(200);
    });

    it('join window: not open yet / ended / cancelled', async () => {
      const later = (
        await schedule('alice', {
          title: 'Tomorrow',
          scheduledAt: inMinutes(24 * 60),
        }).expect(201)
      ).body.id;
      const early = await token('bob', later).expect(409);
      expect(early.body.code).toBe('MEETING_NOT_OPEN_YET');
      expect(new Date(early.body.details.opensAt).getTime()).toBe(
        meetingRow(later).scheduledAt.getTime() - 15 * MIN,
      );

      meetingRow(later).scheduledAt = new Date(Date.now() - 3 * HOUR); // 60 min + 30 min grace are over
      expect((await token('bob', later).expect(409)).body.code).toBe(
        'MEETING_ENDED',
      );

      const c = (
        await schedule('alice', {
          title: 'Will cancel',
          scheduledAt: inMinutes(5),
        }).expect(201)
      ).body.id;
      await w
        .http()
        .post(`${API}/meetings/${c}/cancel`)
        .set(w.as('alice'))
        .send({})
        .expect(200);
      expect((await token('bob', c).expect(409)).body.code).toBe(
        'MEETING_CANCELLED',
      );
    });

    it('a meeting created before P12 (no room yet) gets a room on first join', async () => {
      const legacy = await db.meeting.create({
        data: {
          projectId: w.projectA,
          title: 'Legacy',
          scheduledAt: new Date(Date.now() + 5 * MIN),
          duration: 30,
          createdById: w.users.alice.id,
        },
      });
      await db.meetingAttendee.create({
        data: { meetingId: legacy!.id, userId: w.users.bob.id },
      });
      const res = await token('bob', legacy!.id).expect(200);
      expect(res.body.roomName).toMatch(/^tammha-/);
      expect(meetingRow(legacy!.id).liveKitRoomName).toBe(res.body.roomName);
      const again = await token('bob', legacy!.id).expect(200);
      expect(again.body.roomName).toBe(res.body.roomName);
    });
  });

  // ------------------------------------------------------------------------
  describe('Notes per author (QA review 2)', () => {
    const notes = (who: string, id: string) =>
      w.http().get(`${API}/meetings/${id}/notes`).set(w.as(who));
    const write = (who: string, id: string, content: string) =>
      w
        .http()
        .put(`${API}/meetings/${id}/notes`)
        .set(w.as(who))
        .send({ content });

    it("students' notes are private; the supervisor's are shared read-only", async () => {
      const m = await schedule('alice', {
        title: 'Notes split',
        scheduledAt: inMinutes(30),
      }).expect(201);
      const id = m.body.id;
      await write('alice', id, 'alice private').expect(200);
      await write('bob', id, 'bob private').expect(200);
      const sup = await write('supA', id, 'supervisor decisions').expect(200);
      expect(sup.body).toMatchObject({
        content: 'supervisor decisions',
        visibility: 'SHARED_WITH_TEAM',
        shared: [],
      });

      const a = await notes('alice', id).expect(200);
      expect(a.body).toMatchObject({
        exists: true,
        content: 'alice private',
        visibility: 'PRIVATE',
      });
      expect(a.body.shared.map((n: any) => n.content)).toEqual([
        'supervisor decisions',
      ]);
      expect(a.body.shared[0].author.id).toBe(w.users.supA.id);
      const b = await notes('bob', id).expect(200);
      expect(b.body.content).toBe('bob private');
      expect(JSON.stringify(b.body)).not.toContain('alice private');
      const s2 = await notes('supA', id).expect(200);
      expect(s2.body.content).toBe('supervisor decisions');
      expect(JSON.stringify(s2.body)).not.toContain('private');

      // editing changes only the caller's own note
      await write('bob', id, 'bob edited').expect(200);
      expect((await notes('supA', id)).body.content).toBe(
        'supervisor decisions',
      );
      expect((await notes('alice', id)).body.content).toBe('alice private');

      // hasNotes reflects what the caller can read
      const carlFree = await w
        .http()
        .get(`${API}/meetings/${id}`)
        .set(w.as('alice'))
        .expect(200);
      expect(carlFree.body.hasNotes).toBe(true);
    });

    it('a student without own notes still sees hasNotes when the supervisor wrote', async () => {
      const m = await schedule('alice', {
        title: 'Only supervisor notes',
        scheduledAt: inMinutes(30),
      }).expect(201);
      const id = m.body.id;
      const before = await w
        .http()
        .get(`${API}/meetings/${id}`)
        .set(w.as('bob'))
        .expect(200);
      expect(before.body.hasNotes).toBe(false);
      await write('alice', id, 'alice only').expect(200);
      expect(
        (await w.http().get(`${API}/meetings/${id}`).set(w.as('bob'))).body
          .hasNotes,
      ).toBe(false);
      await write('supA', id, 'from supervisor').expect(200);
      expect(
        (await w.http().get(`${API}/meetings/${id}`).set(w.as('bob'))).body
          .hasNotes,
      ).toBe(true);
      const bob = await notes('bob', id).expect(200);
      expect(bob.body).toMatchObject({ exists: false, content: '' });
      expect(bob.body.shared).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------------
  describe('End for everyone (QA review 2)', () => {
    it('only the organiser or supervisor ends it; then nobody can join', async () => {
      const m = await schedule('alice', {
        title: 'End me',
        scheduledAt: inMinutes(2),
      }).expect(201);
      const id = m.body.id;
      await w
        .http()
        .post(`${API}/meetings/${id}/token`)
        .set(w.as('bob'))
        .expect(200);
      await w
        .http()
        .post(`${API}/meetings/${id}/end`)
        .set(w.as('bob'))
        .expect(403);
      const ended = await w
        .http()
        .post(`${API}/meetings/${id}/end`)
        .set(w.as('alice'))
        .expect(200);
      expect(ended.body.status).toBe('COMPLETED');
      expect(ended.body.join.isOpen).toBe(false);
      expect(meetingRow(id).status).toBe('COMPLETED');
      const again = await w
        .http()
        .post(`${API}/meetings/${id}/token`)
        .set(w.as('bob'))
        .expect(409);
      expect(again.body.code ?? again.body.error?.code).toBeDefined();
      // ending twice is harmless
      await w
        .http()
        .post(`${API}/meetings/${id}/end`)
        .set(w.as('supA'))
        .expect(200);
    });
  });
});

// ============================================================================
describe('Meetings with LIVEKIT_ENABLED=false (default)', () => {
  let app: INestApplication;
  let w: Awaited<ReturnType<typeof seedWorld>>;

  beforeAll(async () => {
    const booted = await bootApp({});
    app = booted.app;
    w = await seedWorld(app, booted.db, booted.jwt);
  });
  afterAll(async () => app?.close());

  it('meetings work; the token endpoint answers 503 INTEGRATION_DISABLED after the access checks', async () => {
    const res = await w
      .http()
      .post(`${API}/meetings`)
      .set(w.as('alice'))
      .send({
        projectId: w.projectA,
        title: 'No video yet',
        scheduledAt: new Date(Date.now() + 5 * MIN).toISOString(),
      })
      .expect(201);
    const id = res.body.id;
    // access is checked first: outsiders still get 403, not 503
    await w
      .http()
      .post(`${API}/meetings/${id}/token`)
      .set(w.as('erin'))
      .expect(403);
    const disabled = await w
      .http()
      .post(`${API}/meetings/${id}/token`)
      .set(w.as('bob'))
      .expect(503);
    expect(disabled.body.code).toBe('INTEGRATION_DISABLED');
    const status = await w
      .http()
      .get(`${API}/integrations/status`)
      .set(w.as('bob'))
      .expect(200);
    expect(status.body.livekit).toEqual({
      enabled: false,
      state: 'DISABLED',
      provider: null,
    });
  });
});
