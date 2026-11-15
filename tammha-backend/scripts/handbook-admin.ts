/**
 * Handbook admin CLI (P13) — same rules as the ADMIN API, for whoever runs the server.
 *
 *   npm run handbook -- setup-universities
 *   npm run handbook -- list
 *   npm run handbook -- show   --university <key|code|id>
 *   npm run handbook -- upload --university <key|code|id> --file <path/to/handbook.pdf> --title "..." [--description "..."]
 *   npm run handbook -- remove --university <key|code|id> --yes
 *
 * <key> = almaarefa | jouf | pnu | tabuk (the four handbook universities, handbook-universities.ts).
 * setup-universities creates any of the four that does not exist yet (name + code only; it never
 * changes or deletes an existing university). Uploading makes the PDF the university's current
 * official handbook (earlier versions stay for projects that use them).
 * Uses the project's .env (database + Supabase Storage). Background jobs are not started.
 * No secret is printed. Run it only against the database you mean to change.
 */
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { readFileSync, statSync } from 'fs';
import { basename, resolve } from 'path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { validateEnv } from '../src/config/env.validation';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SupabaseStorageService } from '../src/modules/documents/supabase-storage.service';
import { HandbookService } from '../src/modules/ai-support/handbook/handbook.service';
import { HandbookLibraryService } from '../src/modules/ai-support/library/handbook-library.service';
import { HANDBOOK_UNIVERSITY_KEYS } from '../src/modules/ai-support/library/handbook-universities';

loadEnv({ path: resolve(__dirname, '..', '.env') });

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      validate: validateEnv,
    }),
    PrismaModule,
  ],
  providers: [SupabaseStorageService, HandbookLibraryService, HandbookService],
})
class HandbookCliModule {}

const USAGE = `Usage:
  npm run handbook -- setup-universities
  npm run handbook -- list
  npm run handbook -- show   --university <key|code|id>
  npm run handbook -- upload --university <key|code|id> --file <handbook.pdf> --title "Title" [--description "..."]
  npm run handbook -- remove --university <key|code|id> --yes
  <key>: ${HANDBOOK_UNIVERSITY_KEYS.join(' | ')}`;

function args() {
  const [command, ...rest] = process.argv.slice(2);
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (!key.startsWith('--')) continue;
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key.slice(2)] = true;
    else {
      flags[key.slice(2)] = next;
      i++;
    }
  }
  return { command, flags };
}

async function main() {
  const { command, flags } = args();
  if (
    !command ||
    !['setup-universities', 'list', 'show', 'upload', 'remove'].includes(
      command,
    )
  ) {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }
  const app = await NestFactory.createApplicationContext(HandbookCliModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService);
    const handbooks = app.get(HandbookService);

    const library = app.get(HandbookLibraryService);
    const university = async () => {
      const ref = flags.university;
      if (typeof ref !== 'string')
        throw new Error('--university <key|code|id> is required');
      if (HANDBOOK_UNIVERSITY_KEYS.includes(ref as never)) {
        const id = await library.handbookUniversityId(ref);
        if (!id)
          throw new Error(
            `"${ref}" is not set up yet: run "npm run handbook -- setup-universities" first`,
          );
        return prisma.university.findUniqueOrThrow({
          where: { id },
          select: { id: true, name: true, code: true },
        });
      }
      const u = await prisma.university.findFirst({
        where: {
          OR: [{ id: ref }, { code: { equals: ref, mode: 'insensitive' } }],
        },
        select: { id: true, name: true, code: true },
      });
      if (!u)
        throw new Error(
          `University "${ref}" not found (see GET /api/v1/universities)`,
        );
      return u;
    };

    if (command === 'setup-universities') {
      for (const { def, row } of await library.resolveHandbookUniversities()) {
        if (row) {
          console.log(`${def.key}: exists (${row.name}, code ${row.code})`);
          continue;
        }
        const created = await prisma.university.create({
          data: { name: def.name.en, code: def.code },
          select: { id: true },
        });
        console.log(`${def.key}: created ${def.name.en} (${created.id})`);
      }
    }

    if (command === 'list') {
      const rows = await handbooks.list();
      if (rows.length === 0) console.log('No handbooks yet.');
      for (const h of rows) {
        console.log(
          `${h.universityName} (${h.universityId}): "${h.title}" — ${h.pageCount ?? '?'} pages, ` +
            `${h.extractedChars} chars, updated ${h.updatedAt.toISOString()}`,
        );
      }
    }

    if (command === 'show') {
      const u = await university();
      const h = await handbooks.adminView(u.id);
      console.log(
        JSON.stringify(
          { ...h, textPreview: `${h.textPreview.slice(0, 300)}…` },
          null,
          2,
        ),
      );
    }

    if (command === 'upload') {
      const u = await university();
      const file = flags.file;
      const title = flags.title;
      if (typeof file !== 'string')
        throw new Error('--file <path> is required');
      if (typeof title !== 'string')
        throw new Error('--title "..." is required');
      const path = resolve(process.cwd(), file);
      const buffer = readFileSync(path);
      const saved = await handbooks.upsert({
        universityId: u.id,
        title,
        description:
          typeof flags.description === 'string' ? flags.description : null,
        file: {
          originalname: basename(path),
          mimetype: 'application/pdf',
          size: statSync(path).size,
          buffer,
        },
        uploadedById: null,
      });
      console.log(
        `Saved handbook for ${u.name}: "${saved.title}", ${saved.pageCount} pages, ` +
          `${saved.extractedChars} characters extracted.`,
      );
    }

    if (command === 'remove') {
      const u = await university();
      if (flags.yes !== true)
        throw new Error(`Add --yes to delete the handbook of ${u.name}`);
      await handbooks.remove(u.id);
      console.log(`Deleted the handbook of ${u.name}.`);
    }
  } finally {
    await app.close();
  }
}

main().catch(
  (error: Error & { response?: { code?: string; message?: string } }) => {
    const r = error.response;
    console.error(
      `ERROR: ${r?.code ? `${r.code} — ${r.message}` : error.message}`,
    );
    process.exit(1);
  },
);
