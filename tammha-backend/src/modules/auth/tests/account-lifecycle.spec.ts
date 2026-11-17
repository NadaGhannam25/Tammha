import { AccountLifecycleService } from '../account-lifecycle.service';
import { AuthTokensService } from '../auth-tokens.service';
import {
  createInMemoryPrisma,
  InMemoryPrisma,
} from '@/testing/in-memory-prisma';

/** QA review 2: settings password link (5-minute repeat) and account deletion by e-mailed code. */
describe('AccountLifecycleService', () => {
  let db: InMemoryPrisma;
  let service: AccountLifecycleService;
  const mail = {
    deliveryState: 'ENABLED',
    sendPasswordReset: jest.fn(),
    sendAccountDeletionCode: jest.fn(),
    sendAccountDeleted: jest.fn(),
  };
  const asUser = (u: any) => ({ id: u.id, role: u.role }) as any;
  const lastCode = () =>
    mail.sendAccountDeletionCode.mock.calls.at(-1)![2] as string;

  const user = (email: string, role = 'STUDENT') =>
    db.user.create({
      data: {
        email,
        password: 'x',
        firstName: 'Rand',
        lastName: 'A',
        role,
        studentNumber: role === 'STUDENT' ? email.slice(0, 4) : null,
        college: 'Engineering',
        major: 'AI',
        emailVerifiedAt: new Date(),
      },
    });
  const team = async (leaderId: string, memberIds: string[] = []) => {
    const t = await db.team.create({ data: { name: 'Team X' } });
    await db.teamMember.create({
      data: { teamId: t!.id, userId: leaderId, role: 'LEADER' },
    });
    for (const id of memberIds) {
      await db.teamMember.create({
        data: { teamId: t!.id, userId: id, role: 'MEMBER' },
      });
    }
    return t!;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    db = createInMemoryPrisma();
    service = new AccountLifecycleService(
      db as any,
      new AuthTokensService(db as any),
      mail as any,
    );
  });

  it('password link: sent once, a second request within 5 minutes is not re-sent', async () => {
    const u = await user('rand@test.local');
    const t0 = new Date('2026-11-17T10:00:00Z');
    const first = await service.sendPasswordLink(asUser(u), t0);
    expect(first).toMatchObject({
      email: 'rand@test.local',
      alreadySent: false,
    });
    jest.useFakeTimers().setSystemTime(t0);
    const second = await service.sendPasswordLink(
      asUser(u),
      new Date(t0.getTime() + 2 * 60_000),
    );
    expect(second).toMatchObject({ alreadySent: true, retryAfterSeconds: 180 });
    expect(mail.sendPasswordReset).toHaveBeenCalledTimes(1);
    const later = await service.sendPasswordLink(
      asUser(u),
      new Date(t0.getTime() + 6 * 60_000),
    );
    expect(later.alreadySent).toBe(false);
    expect(mail.sendPasswordReset).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('deletion: wrong code refused, right code anonymises, signs out and says goodbye', async () => {
    const u = await user('rand@test.local');
    const other = await user('nada@test.local');
    const t = await team(other!.id, [u!.id]);
    await db.refreshToken.create({
      data: {
        userId: u!.id,
        tokenHash: 'h1',
        expiresAt: new Date(Date.now() + 1e9),
      },
    });

    const req = await service.requestDeletion(asUser(u));
    expect(req.email).toBe('rand@test.local');
    const code = lastCode();
    expect(code).toMatch(/^\d{6}$/);
    // the raw code is never stored
    expect(JSON.stringify(db.authToken.rows)).not.toContain(code);

    const wrong = code === '000000' ? '111111' : '000000';
    await expect(
      service.confirmDeletion(asUser(u), wrong),
    ).rejects.toMatchObject({
      response: { code: 'DELETION_CODE_INVALID' },
    });
    await expect(service.confirmDeletion(asUser(u), code)).resolves.toEqual({
      deleted: true,
    });

    const row = db.user.rows.find((r: any) => r.id === u!.id)!;
    expect(row).toMatchObject({
      isActive: false,
      firstName: 'حساب',
      lastName: 'محذوف',
      studentNumber: null,
      college: null,
      major: null,
      avatar: null,
    });
    expect(row.email).not.toContain('rand');
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(db.refreshToken.rows.every((r: any) => r.revokedAt)).toBe(true);
    expect(
      db.teamMember.rows.some(
        (m: any) => m.userId === u!.id && m.teamId === t.id,
      ),
    ).toBe(false);
    expect(mail.sendAccountDeleted.mock.calls[0].slice(0, 2)).toEqual([
      'rand@test.local',
      'Rand',
    ]);
    // the code cannot be used twice
    await expect(
      service.confirmDeletion(asUser(u), code),
    ).rejects.toBeDefined();
  });

  it('a code stops working after 5 wrong attempts', async () => {
    const u = await user('rand@test.local');
    await service.requestDeletion(asUser(u));
    const code = lastCode();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      await expect(
        service.confirmDeletion(asUser(u), wrong),
      ).rejects.toBeDefined();
    }
    await expect(
      service.confirmDeletion(asUser(u), code),
    ).rejects.toMatchObject({
      response: { code: 'DELETION_CODE_INVALID' },
    });
    expect(db.user.rows.find((r: any) => r.id === u!.id)!.isActive).toBe(true);
  });

  it('a leader whose team has members cannot delete; a leader alone can', async () => {
    const lead = await user('lead@test.local');
    const member = await user('memb@test.local');
    await team(lead!.id, [member!.id]);
    await expect(service.requestDeletion(asUser(lead))).rejects.toMatchObject({
      response: {
        code: 'ACCOUNT_DELETION_BLOCKED',
        details: { blockers: [{ code: 'TEAM_LEADER', name: 'Team X' }] },
      },
    });
    expect(mail.sendAccountDeletionCode).not.toHaveBeenCalled();

    const solo = await user('solo@test.local');
    await team(solo!.id);
    await expect(service.requestDeletion(asUser(solo))).resolves.toBeDefined();
  });

  it('a supervisor of a project cannot delete', async () => {
    const sup = await user('sup@test.local', 'SUPERVISOR');
    const lead = await user('lead@test.local');
    const t = await team(lead!.id);
    const p = await db.project.create({ data: { name: 'Proj', teamId: t.id } });
    await db.projectMember.create({
      data: { projectId: p!.id, userId: sup!.id, role: 'PROJECT_MANAGER' },
    });
    await expect(service.requestDeletion(asUser(sup))).rejects.toMatchObject({
      response: {
        code: 'ACCOUNT_DELETION_BLOCKED',
        details: { blockers: [{ code: 'SUPERVISOR', name: 'Proj' }] },
      },
    });
  });

  it('a new code cannot be requested within a minute', async () => {
    const u = await user('rand@test.local');
    await service.requestDeletion(asUser(u));
    await expect(service.requestDeletion(asUser(u))).rejects.toMatchObject({
      response: { code: 'DELETION_CODE_RECENTLY_SENT' },
    });
  });
});
