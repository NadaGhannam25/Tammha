import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import {
  isCustomUniversityCode,
  SAUDI_UNIVERSITIES,
  universityNameKey,
} from './saudi-universities';

type UniversityRow = { id: string; code: string; name: string };

interface UniversityStore {
  university: {
    findMany(args: {
      select: { id: true; code: true; name: true };
    }): Promise<UniversityRow[]>;
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    update(args: {
      where: { id: string };
      data: { code: string };
    }): Promise<unknown>;
  };
}

/**
 * Adds the listed Saudi universities that are missing. Existing rows are never changed,
 * except a university first typed by a user ("Other", code CUSTOM-…) that turns out to be a
 * listed one: it receives the listed code, so its users stay linked to it.
 */
export async function seedSaudiUniversities(prisma: UniversityStore) {
  const rows = await prisma.university.findMany({
    select: { id: true, code: true, name: true },
  });
  let created = 0;
  let linked = 0;
  for (const u of SAUDI_UNIVERSITIES) {
    if (rows.some((r) => r.code.toUpperCase() === u.code)) continue;
    const sameName = rows.find(
      (r) =>
        universityNameKey(r.name) === universityNameKey(u.en) ||
        universityNameKey(r.name) === universityNameKey(u.ar),
    );
    if (sameName) {
      if (isCustomUniversityCode(sameName.code)) {
        await prisma.university.update({
          where: { id: sameName.id },
          data: { code: u.code },
        });
        linked++;
      }
      continue;
    }
    await prisma.university.create({
      data: {
        name: u.en,
        code: u.code,
        city: u.city,
        country: 'Saudi Arabia',
        isActive: true,
      },
    });
    created++;
  }
  return { created, linked };
}

/** Production only (and not when UNIVERSITIES_SEED=false); never blocks the start-up. */
@Injectable()
export class UniversitiesCatalogSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger('Universities');

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap() {
    if (process.env.NODE_ENV !== 'production') return;
    if ((process.env.UNIVERSITIES_SEED ?? '').toLowerCase() === 'false') return;
    try {
      const { created, linked } = await seedSaudiUniversities(
        this.prisma as unknown as UniversityStore,
      );
      this.logger.log(
        `Saudi universities catalogue ready (${created} added, ${linked} linked)`,
      );
    } catch (error) {
      this.logger.warn(
        `Saudi universities catalogue not updated: ${(error as Error).message}`,
      );
    }
  }
}
