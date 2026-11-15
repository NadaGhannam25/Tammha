/**
 * Removes the test data created by `npm run prod:verify` (P15).
 *
 *   npm run prod:cleanup -- --run-id <runId>          # dry run: shows what would be removed
 *   npm run prod:cleanup -- --run-id <runId> --yes    # removes it
 *
 * Uses DATABASE_URL, SUPABASE_URL and SUPABASE_SECRET_KEY from your root .env (point them at
 * production). Never prints secret values.
 *
 * SAFETY — removes ONLY:
 * - users whose e-mail is exactly <name>.<runId>@example.test (the verifier's pattern),
 *   STUDENT/SUPERVISOR only, at most 10 of them;
 * - teams whose members are ALL such users (their project, tasks, milestones, documents,
 *   feedback, meetings and AI requests go with them through the existing cascades);
 * - the storage files of those projects' documents (bucket project-documents).
 * A team that also contains a real user is never touched (reported instead).
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';
import { PrismaClient, UserRole } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';

loadEnv({ path: resolve(__dirname, '..', '..', '.env') });

const BUCKET = 'project-documents';
const MAX_USERS = 10;

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--run-id');
  const runId = i >= 0 ? (argv[i + 1] ?? '').trim() : '';
  const execute = argv.includes('--yes');
  if (!/^[a-z0-9]{6,24}$/.test(runId)) {
    fail(
      'Usage: npm run prod:cleanup -- --run-id <runId from the verification report> [--yes]',
    );
  }
  const suffix = `.${runId}@example.test`;
  const prisma = new PrismaClient();
  try {
    const users = await prisma.user.findMany({
      where: { email: { endsWith: suffix } },
      select: { id: true, email: true, role: true },
    });
    const valid = users.filter((u) =>
      /^[a-z0-9]+$/.test(u.email.slice(0, -suffix.length)),
    );
    if (valid.length === 0)
      fail(`No verification users found for run ${runId}.`);
    if (valid.length > MAX_USERS)
      fail(`Refusing: ${valid.length} users match (max ${MAX_USERS}).`);
    if (valid.some((u) => u.role === UserRole.ADMIN))
      fail('Refusing: an ADMIN account matches.');
    const userIds = new Set(valid.map((u) => u.id));

    const memberships = await prisma.teamMember.findMany({
      where: { userId: { in: [...userIds] } },
      select: { teamId: true },
    });
    const candidateTeams = [...new Set(memberships.map((m) => m.teamId))];
    const teamIds: string[] = [];
    for (const teamId of candidateTeams) {
      const members = await prisma.teamMember.findMany({
        where: { teamId },
        select: { userId: true },
      });
      if (members.every((m) => userIds.has(m.userId))) teamIds.push(teamId);
      else console.warn(`! team ${teamId} also has real members: NOT removed`);
    }
    const projects = await prisma.project.findMany({
      where: { teamId: { in: teamIds } },
      select: { id: true, name: true },
    });
    const projectIds = projects.map((p) => p.id);
    const documents = await prisma.document.findMany({
      where: { projectId: { in: projectIds } },
      select: { fileUrl: true, versions: { select: { fileUrl: true } } },
    });
    const paths = [
      ...new Set(
        documents.flatMap((d) => [
          d.fileUrl,
          ...d.versions.map((v) => v.fileUrl),
        ]),
      ),
    ].filter((p) => projectIds.some((id) => p.startsWith(`${id}/`)));

    console.log(`Run ${runId}:`);
    console.log(
      `  users     ${valid.length}: ${valid.map((u) => u.email).join(', ')}`,
    );
    console.log(
      `  teams     ${teamIds.length}, projects ${projects.length}: ${projects.map((p) => p.name).join(', ')}`,
    );
    console.log(`  files     ${paths.length} in bucket ${BUCKET}`);
    if (!execute) {
      console.log(
        '\nDry run only. Add --yes to remove these records and files.',
      );
      return;
    }

    if (paths.length) {
      const url = process.env.SUPABASE_URL?.trim();
      const key = process.env.SUPABASE_SECRET_KEY?.trim();
      if (!url || !key)
        fail(
          'SUPABASE_URL / SUPABASE_SECRET_KEY missing in .env (needed to delete the files).',
        );
      const storage = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      }).storage.from(BUCKET);
      const { error } = await storage.remove(paths);
      if (error)
        fail(
          `Storage delete failed (nothing removed from the database): ${error.message}`,
        );
    }
    await prisma.$transaction(async (tx) => {
      // projects (and their tasks, milestones, documents, meetings...) cascade from the team
      await tx.team.deleteMany({ where: { id: { in: teamIds } } });
      // supervision requests, notifications, AI requests, refresh tokens cascade from the user
      await tx.user.deleteMany({ where: { id: { in: [...userIds] } } });
    });
    console.log(
      `\n✔ Removed ${valid.length} users, ${teamIds.length} teams/projects and ${paths.length} files.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: Error) =>
  fail(`Cleanup failed: ${error.message?.trim() || error.name}`),
);
