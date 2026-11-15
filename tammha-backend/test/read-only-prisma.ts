import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';

/** Prisma actions that only read. Everything else is refused (allowlist, not blocklist). */
const READ_ACTIONS = new Set<Prisma.PrismaAction>([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'queryRaw', // application code only issues SELECT statements
]);

/**
 * PrismaService used by the real-database E2E suite.
 * Any write (create, update, upsert, delete, *Many, executeRaw, ...) is rejected
 * BEFORE it is sent to the database and recorded in `blockedWrites`.
 */
export class ReadOnlyPrismaService extends PrismaService {
  readonly blockedWrites: string[] = [];

  constructor() {
    super();
    this.$use(async (params, next) => {
      if (!READ_ACTIONS.has(params.action)) {
        const op = `${params.model ?? '$raw'}.${params.action}`;
        this.blockedWrites.push(op);
        throw new Error(`E2E suite is read-only: blocked ${op}`);
      }
      return next(params);
    });
  }
}
