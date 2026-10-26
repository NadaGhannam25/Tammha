/* eslint-disable @typescript-eslint/no-explicit-any */
import { Prisma } from '@prisma/client';
/**
 * TEST-ONLY in-memory stand-in for PrismaService.
 *
 * Supports the subset of the Prisma API used by the app:
 * findUnique/findFirst/findMany/create/update/updateMany/delete/count/groupBy,
 * where (equality incl. null, in, not, lt/lte/gt/gte, equals/contains with
 * mode 'insensitive', compound unique keys), select/include of relations,
 * orderBy (object or array; { sort, nulls }; enums in declaration order like
 * PostgreSQL), skip/take, unique constraints (throws { code: 'P2002' }) and
 * $transaction(callback | array) with rollback of the callback form on error.
 *
 * Excluded from the production build (see tsconfig.json "exclude").
 */
type Row = Record<string, any>;

interface TableDef {
  unique: string[];
  compound?: Record<string, string[]>;
  defaults: () => Row;
  relations?: Record<string, (row: Row) => Row | null | undefined>;
  /** One-to-many relations: child table + foreign key pointing at this row's id. */
  many?: Record<string, { table: () => Table; foreignKey: string }>;
  /** Enum columns sort by declaration order in PostgreSQL, not alphabetically. */
  enumOrder?: Record<string, string[]>;
}

let clock = Date.UTC(2026, 0, 1);
const tick = () => new Date((clock += 1000));
let idSeq = 0;
const newId = (prefix: string) =>
  `${prefix}_${(++idSeq).toString(36).padStart(6, '0')}`;

const uniqueError = (fields: string[]) =>
  Object.assign(new Error(`Unique constraint failed on ${fields.join(',')}`), {
    code: 'P2002',
    meta: { target: fields },
  });

const notFoundError = () =>
  Object.assign(new Error('Record to update not found.'), { code: 'P2025' });

/** Prisma semantics: a field set to `undefined` in `data` means "leave unset / unchanged". */
function defined(data: Row = {}): Row {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, v]) => v !== undefined)
      // Prisma.DbNull / JsonNull mean SQL NULL for Json columns
      .map(([k, v]) => [
        k,
        v === Prisma.DbNull || v === Prisma.JsonNull ? null : v,
      ]),
  );
}

function same(a: any, b: any): boolean {
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime();
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  return a === b;
}

class Table {
  rows: Row[] = [];
  constructor(
    private readonly prefix: string,
    private readonly def: TableDef,
  ) {}

  private matchValue(actual: any, expected: any): boolean {
    const isOperator =
      expected !== null &&
      typeof expected === 'object' &&
      !(expected instanceof Date) &&
      !Array.isArray(expected);
    if (!isOperator) return same(actual, expected);

    const insensitive = expected.mode === 'insensitive';
    const lower = (v: any) =>
      insensitive && typeof v === 'string' ? v.toLowerCase() : v;
    return Object.entries(expected).every(([op, value]: [string, any]) => {
      switch (op) {
        case 'mode':
          return true;
        case 'in':
          return value.some((v: any) => same(actual, v));
        case 'notIn':
          return !value.some((v: any) => same(actual, v));
        case 'equals':
          return same(lower(actual), lower(value));
        case 'not':
          return actual !== null && actual !== undefined
            ? !same(actual, value)
            : value !== null; // SQL: NULL <> x is unknown -> excluded
        case 'contains':
          return (
            typeof actual === 'string' && lower(actual).includes(lower(value))
          );
        case 'lt':
          return actual !== null && actual < value;
        case 'lte':
          return actual !== null && actual <= value;
        case 'gt':
          return actual !== null && actual > value;
        case 'gte':
          return actual !== null && actual >= value;
        default:
          throw new Error(`in-memory-prisma: unsupported operator "${op}"`);
      }
    });
  }

  private matches(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, expected]) => {
      const compound = this.def.compound?.[key];
      if (compound) return compound.every((f) => row[f] === expected[f]);
      const toMany = this.def.many?.[key];
      if (toMany && expected && typeof expected === 'object') {
        // to-many relation filter: { attendees: { some: { userId } } }
        const children = toMany
          .table()
          .rows.filter((c: Row) => c[toMany.foreignKey] === row.id);
        const t = toMany.table() as Table;
        if (expected.some)
          return children.some((c: Row) => t.matchesRow(c, expected.some));
        if (expected.none)
          return !children.some((c: Row) => t.matchesRow(c, expected.none));
        if (expected.every)
          return children.every((c: Row) => t.matchesRow(c, expected.every));
        throw new Error(
          `in-memory-prisma: unsupported to-many filter on ${key}`,
        );
      }
      const relation = this.def.relations?.[key];
      if (relation && expected && typeof expected === 'object') {
        // to-one relation filter, e.g. { user: { role: 'SUPERVISOR' } }
        const related = relation(row);
        return (
          !!related &&
          Object.entries(expected).every(([k, v]) =>
            this.matchValue(related[k], v),
          )
        );
      }
      return this.matchValue(row[key], expected);
    });
  }

  /** Public for nested to-many filters. */
  matchesRow(row: Row, where: Row = {}): boolean {
    return this.matches(row, where);
  }

  private shape(row: Row | undefined, args: Row = {}): Row | null {
    if (!row) return null;
    const relations = this.def.relations ?? {};
    const many = this.def.many ?? {};
    const project = (target: Row, spec: Row | true) => {
      if (spec === true) return { ...target };
      const sel = spec.select;
      if (!sel) return { ...target };
      const out: Row = {};
      for (const k of Object.keys(sel)) if (sel[k]) out[k] = target[k];
      return out;
    };
    const children = (key: string, spec: Row | true) => {
      const { table, foreignKey } = many[key];
      const nested: Row = spec === true ? {} : spec;
      return table().query({
        ...nested,
        where: { ...(nested.where ?? {}), [foreignKey]: row.id },
      });
    };
    const counts = (spec: Row) => {
      const out: Row = {};
      for (const [k, v] of Object.entries(spec.select ?? {})) {
        if (v && many[k]) out[k] = children(k, { select: { id: true } }).length;
      }
      return out;
    };
    const resolve = (k: string, v: any) => {
      if (k === '_count') return counts(v);
      if (many[k]) return children(k, v);
      const rel = relations[k](row);
      return rel ? project(rel, v as Row) : null;
    };

    if (args.select) {
      const out: Row = {};
      for (const [k, v] of Object.entries(args.select)) {
        if (!v) continue;
        out[k] =
          k === '_count' || many[k] || relations[k] ? resolve(k, v) : row[k];
      }
      return out;
    }

    const out: Row = { ...row };
    for (const [k, v] of Object.entries(args.include ?? {})) {
      if (!v || !(k === '_count' || many[k] || relations[k])) continue;
      out[k] = resolve(k, v);
    }
    return out;
  }

  private sorted(args: Row = {}): Row[] {
    const specs: Row[] = !args.orderBy
      ? []
      : Array.isArray(args.orderBy)
        ? args.orderBy
        : [args.orderBy];
    const keys = specs.map((spec) => {
      const [field, value] = Object.entries(spec)[0] as [string, any];
      const dir = typeof value === 'string' ? value : value.sort;
      // PostgreSQL defaults: ASC -> NULLS LAST, DESC -> NULLS FIRST
      const nulls =
        typeof value === 'object' && value.nulls
          ? value.nulls
          : dir === 'asc'
            ? 'last'
            : 'first';
      return { field, dir, nulls };
    });
    const rank = (field: string, v: any) => {
      const order = this.def.enumOrder?.[field];
      if (order) return order.indexOf(v);
      return v instanceof Date ? v.getTime() : v;
    };
    return [...this.rows].sort((a, b) => {
      for (const { field, dir, nulls } of keys) {
        const av = a[field];
        const bv = b[field];
        if (av === bv) continue;
        if (av === null || av === undefined) return nulls === 'first' ? -1 : 1;
        if (bv === null || bv === undefined) return nulls === 'first' ? 1 : -1;
        const x = rank(field, av);
        const y = rank(field, bv);
        if (x === y) continue;
        const cmp = x < y ? -1 : 1;
        return dir === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
  }

  private assertUnique(candidate: Row, ignoreId?: string) {
    const others = this.rows.filter((r) => r.id !== ignoreId);
    for (const field of this.def.unique) {
      const value = candidate[field];
      if (value === null || value === undefined) continue;
      if (others.some((r) => r[field] === value)) throw uniqueError([field]);
    }
    for (const fields of Object.values(this.def.compound ?? {})) {
      // SQL: a NULL in any column never conflicts in a unique index
      if (
        fields.some((f) => candidate[f] === null || candidate[f] === undefined)
      )
        continue;
      if (others.some((r) => fields.every((f) => r[f] === candidate[f]))) {
        throw uniqueError(fields);
      }
    }
  }

  async findUnique(args: Row) {
    return this.shape(
      this.rows.find((r) => this.matches(r, args.where)),
      args,
    );
  }
  async findUniqueOrThrow(args: Row) {
    const row = await this.findUnique(args);
    if (!row) throw notFoundError();
    return row;
  }
  async findFirst(args: Row = {}) {
    return this.shape(
      this.sorted(args).find((r) => this.matches(r, args.where)),
      args,
    );
  }
  /** Synchronous findMany (also used for nested to-many relations). */
  query(args: Row = {}): Row[] {
    const list = this.sorted(args).filter((r) => this.matches(r, args.where));
    const start = args.skip ?? 0;
    const end = args.take === undefined ? undefined : start + args.take;
    return list.slice(start, end).map((r) => this.shape(r, args) as Row);
  }
  async findMany(args: Row = {}) {
    const list = this.sorted(args).filter((r) => this.matches(r, args.where));
    const start = args.skip ?? 0;
    const end = args.take === undefined ? undefined : start + args.take;
    return list.slice(start, end).map((r) => this.shape(r, args));
  }
  async groupBy(args: Row) {
    const groups = new Map<string, { key: Row; count: number }>();
    for (const row of this.rows.filter((r) => this.matches(r, args.where))) {
      const key: Row = {};
      for (const f of args.by) key[f] = row[f];
      const id = JSON.stringify(key);
      const g = groups.get(id) ?? { key, count: 0 };
      g.count++;
      groups.set(id, g);
    }
    return [...groups.values()].map((g) => ({
      ...g.key,
      _count: { _all: g.count },
    }));
  }
  async count(args: Row = {}) {
    return this.rows.filter((r) => this.matches(r, args.where)).length;
  }
  async create(args: Row) {
    const now = tick();
    const row: Row = {
      id: newId(this.prefix),
      ...this.def.defaults(),
      createdAt: now,
      updatedAt: now,
      ...defined(args.data),
    };
    this.assertUnique(row);
    this.rows.push(row);
    return this.shape(row, args);
  }
  async update(args: Row) {
    const row = this.rows.find((r) => this.matches(r, args.where));
    if (!row) throw notFoundError();
    const next = { ...row, ...defined(args.data), updatedAt: tick() };
    this.assertUnique(next, row.id);
    Object.assign(row, next);
    return this.shape(row, args);
  }
  async upsert(args: Row) {
    const existing = this.rows.find((r) => this.matches(r, args.where));
    if (existing)
      return this.update({
        where: { id: existing.id },
        data: args.update,
        select: args.select,
        include: args.include,
      });
    return this.create({
      data: args.create,
      select: args.select,
      include: args.include,
    });
  }
  async updateMany(args: Row) {
    const rows = this.rows.filter((r) => this.matches(r, args.where));
    rows.forEach((r) =>
      Object.assign(r, defined(args.data), { updatedAt: tick() }),
    );
    return { count: rows.length };
  }
  async createMany(args: Row) {
    return { count: (await this.insertMany(args)).length };
  }
  /** Prisma 5.14+: inserted rows only (skipDuplicates leaves conflicts out). */
  async createManyAndReturn(args: Row) {
    const rows = await this.insertMany(args);
    return rows.map((r) => this.shape(r, { select: args.select }));
  }
  private async insertMany(args: Row): Promise<Row[]> {
    const items: Row[] = Array.isArray(args.data) ? args.data : [args.data];
    const inserted: Row[] = [];
    for (const data of items) {
      try {
        const created = await this.create({ data });
        inserted.push(this.rows.find((r) => r.id === created!.id)!);
      } catch (error: any) {
        if (args.skipDuplicates && error?.code === 'P2002') continue;
        throw error;
      }
    }
    return inserted;
  }
  async deleteMany(args: Row = {}) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !this.matches(r, args.where));
    return { count: before - this.rows.length };
  }
  async delete(args: Row) {
    const index = this.rows.findIndex((r) => this.matches(r, args.where));
    if (index < 0) throw notFoundError();
    const [row] = this.rows.splice(index, 1);
    return { ...row };
  }
}

export function createInMemoryPrisma() {
  const db: any = {};

  db.university = new Table('uni', {
    unique: ['name', 'code'],
    defaults: () => ({
      country: null,
      city: null,
      website: null,
      logo: null,
      isActive: true,
    }),
  });

  db.user = new Table('user', {
    unique: ['email'],
    defaults: () => ({
      firstName: null,
      lastName: null,
      universityId: null,
      avatar: null,
      bio: null,
      isActive: true,
      role: 'STUDENT',
    }),
  });

  db.refreshToken = new Table('rt', {
    unique: ['tokenHash'],
    defaults: () => ({ revokedAt: null }),
    relations: {
      user: (r) => db.user.rows.find((u: Row) => u.id === r.userId),
    },
  });

  db.team = new Table('team', {
    unique: ['inviteCode'],
    defaults: () => ({
      description: null,
      avatar: null,
      isActive: true,
      inviteCode: null,
      inviteCodeUpdatedAt: null,
    }),
  });

  db.teamMember = new Table('tm', {
    unique: ['userId'],
    compound: { teamId_userId: ['teamId', 'userId'] },
    defaults: () => ({ role: 'MEMBER' }),
    relations: {
      user: (r) => db.user.rows.find((u: Row) => u.id === r.userId),
    },
  });

  db.project = new Table('project', {
    unique: ['teamId'],
    defaults: () => ({
      description: null,
      status: 'PLANNING',
      startDate: null,
      endDate: null,
      thumbnail: null,
      isPublic: false,
    }),
    relations: {
      team: (r) => db.team.rows.find((t: Row) => t.id === r.teamId),
    },
  });

  db.projectMember = new Table('pm', {
    unique: [],
    compound: { userId_projectId: ['userId', 'projectId'] },
    defaults: () => ({ role: 'CONTRIBUTOR' }),
    relations: {
      user: (r) => db.user.rows.find((u: Row) => u.id === r.userId),
    },
  });

  db.supervisionRequest = new Table('sr', {
    unique: [],
    defaults: () => ({
      status: 'PENDING',
      message: null,
      responseNote: null,
      respondedAt: null,
    }),
    relations: {
      project: (r) => db.project.rows.find((p: Row) => p.id === r.projectId),
      supervisor: (r) => db.user.rows.find((u: Row) => u.id === r.supervisorId),
      requestedBy: (r) =>
        db.user.rows.find((u: Row) => u.id === r.requestedById),
    },
  });

  db.milestone = new Table('ms', {
    unique: [],
    defaults: () => ({ description: null, status: 'PENDING' }),
    enumOrder: {
      status: ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE', 'CANCELLED'],
    },
  });

  db.task = new Table('task', {
    unique: [],
    defaults: () => ({
      description: null,
      milestoneId: null,
      assignedToId: null,
      priority: 'MEDIUM',
      status: 'TODO',
      dueDate: null,
      completedAt: null,
      estimatedHours: null,
      actualHours: null,
    }),
    enumOrder: {
      priority: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
      status: [
        'TODO',
        'IN_PROGRESS',
        'IN_REVIEW',
        'COMPLETED',
        'BLOCKED',
        'CANCELLED',
      ],
    },
    relations: {
      assignedTo: (r) => db.user.rows.find((u: Row) => u.id === r.assignedToId),
      createdBy: (r) => db.user.rows.find((u: Row) => u.id === r.createdById),
      milestone: (r) =>
        db.milestone.rows.find((m: Row) => m.id === r.milestoneId),
      project: (r) => db.project.rows.find((p: Row) => p.id === r.projectId),
    },
  });

  db.document = new Table('doc', {
    unique: [],
    defaults: () => ({
      description: null,
      category: 'GENERAL',
      isPublic: false,
      reviewStatus: 'SUBMITTED',
      reviewStatusUpdatedAt: null,
    }),
    relations: {
      uploadedBy: (r) => db.user.rows.find((u: Row) => u.id === r.uploadedById),
      project: (r) => db.project.rows.find((p: Row) => p.id === r.projectId),
    },
    many: {
      versions: { table: () => db.documentVersion, foreignKey: 'documentId' },
    },
  });

  db.documentVersion = new Table('docv', {
    unique: [],
    compound: { documentId_version: ['documentId', 'version'] },
    defaults: () => ({}),
    relations: {
      document: (r) => db.document.rows.find((d: Row) => d.id === r.documentId),
    },
  });

  db.feedback = new Table('fb', {
    unique: [],
    defaults: () => ({
      projectId: null,
      receivedById: null,
      rating: null,
      comment: null,
      category: 'GENERAL',
      documentId: null,
      documentVersion: null,
      status: null,
      score: null,
      maxScore: null,
      rubric: null,
      scoreVisibleToStudents: false,
    }),
    relations: {
      givenBy: (r) => db.user.rows.find((u: Row) => u.id === r.givenById),
      document: (r) => db.document.rows.find((d: Row) => d.id === r.documentId),
      project: (r) => db.project.rows.find((p: Row) => p.id === r.projectId),
    },
  });

  db.meeting = new Table('mtg', {
    unique: [],
    defaults: () => ({
      description: null,
      location: null,
      meetingUrl: null,
      status: 'SCHEDULED',
      liveKitRoomName: null,
      cancelledAt: null,
      cancellationReason: null,
    }),
    relations: {
      project: (r) => db.project.rows.find((p: Row) => p.id === r.projectId),
      createdBy: (r) => db.user.rows.find((u: Row) => u.id === r.createdById),
    },
    many: {
      attendees: { table: () => db.meetingAttendee, foreignKey: 'meetingId' },
    },
  });

  db.meetingAttendee = new Table('mta', {
    unique: [],
    compound: { meetingId_userId: ['meetingId', 'userId'] },
    defaults: () => ({ status: 'PENDING', joinedAt: null }),
    relations: {
      user: (r) => db.user.rows.find((u: Row) => u.id === r.userId),
    },
  });

  db.notification = new Table('ntf', {
    unique: [],
    compound: { userId_dedupeKey: ['userId', 'dedupeKey'] },
    defaults: () => ({
      data: null,
      isRead: false,
      readAt: null,
      dedupeKey: null,
    }),
    relations: {
      user: (r) => db.user.rows.find((u: Row) => u.id === r.userId),
    },
  });

  db.universityHandbook = new Table('hb', {
    unique: ['universityId'],
    defaults: () => ({
      description: null,
      contentType: 'application/pdf',
      pageCount: null,
      extractedText: null,
      extractedChars: 0,
      uploadedById: null,
      uploadedAt: new Date(),
    }),
    relations: {
      university: (r) =>
        db.university.rows.find((u: Row) => u.id === r.universityId),
    },
  });

  db.aISupport = new Table('ai', {
    unique: [],
    defaults: () => ({
      projectId: null,
      response: null,
      status: 'PENDING',
      kind: 'PROJECT_QUESTION',
      provider: null,
      model: null,
      result: null,
      errorCode: null,
      latencyMs: null,
      inputTokens: null,
      outputTokens: null,
      handbookId: null,
      handbookExcerpts: 0,
      completedAt: null,
    }),
  });

  db.emailDelivery = new Table('mail', {
    unique: [],
    compound: { userId_dedupeKey: ['userId', 'dedupeKey'] },
    defaults: () => ({
      notificationId: null,
      htmlBody: null,
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: new Date(),
      lastError: null,
      provider: null,
      providerMessageId: null,
      sentAt: null,
    }),
    relations: {
      user: (r) => db.user.rows.find((u: Row) => u.id === r.userId),
      notification: (r) =>
        db.notification.rows.find((n: Row) => n.id === r.notificationId),
    },
  });

  // document_versions.documentId -> documents.id ON DELETE CASCADE
  const deleteDocument = db.document.delete.bind(db.document);
  db.document.delete = async (args: Row) => {
    const removed = await deleteDocument(args);
    db.documentVersion.rows = db.documentVersion.rows.filter(
      (v: Row) => v.documentId !== removed.id,
    );
    // feedbacks.documentId -> documents.id ON DELETE SET NULL
    db.feedback.rows
      .filter((f: Row) => f.documentId === removed.id)
      .forEach((f: Row) => (f.documentId = null));
    return removed;
  };

  // Mirrors the schema's onDelete rules that the app relies on.
  const deleteMilestone = db.milestone.delete.bind(db.milestone);
  db.milestone.delete = async (args: Row) => {
    const removed = await deleteMilestone(args);
    db.task.rows
      .filter((t: Row) => t.milestoneId === removed.id)
      .forEach((t: Row) => (t.milestoneId = null)); // SetNull
    return removed;
  };

  // Interactive transactions roll back on error, like PostgreSQL: every table is
  // snapshotted (rows copied) and restored if the callback throws.
  db.$transaction = async (arg: any) => {
    if (typeof arg !== 'function') return Promise.all(arg);
    const tables = Object.values(db).filter(
      (t): t is Table => t instanceof Table,
    );
    const snapshot = tables.map((t) => t.rows.map((r: Row) => ({ ...r })));
    try {
      return await arg(db);
    } catch (error) {
      tables.forEach((t, i) => (t.rows = snapshot[i]));
      throw error;
    }
  };
  db.$connect = async () => undefined;
  db.$disconnect = async () => undefined;
  db.$queryRaw = async () => [{ ok: 1 }];
  db.onModuleInit = async () => undefined;
  db.onModuleDestroy = async () => undefined;

  return db as {
    university: Table;
    user: Table;
    refreshToken: Table;
    team: Table;
    teamMember: Table;
    project: Table;
    projectMember: Table;
    supervisionRequest: Table;
    milestone: Table;
    task: Table;
    document: Table;
    documentVersion: Table;
    feedback: Table;
    notification: Table;
    meeting: Table;
    meetingAttendee: Table;
    emailDelivery: Table;
    universityHandbook: Table;
    aISupport: Table;
    $transaction: (arg: any) => Promise<any>;
  };
}

export type InMemoryPrisma = ReturnType<typeof createInMemoryPrisma>;
