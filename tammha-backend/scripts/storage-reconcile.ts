/**
 * STORAGE QUOTA RECONCILIATION:  npm run storage:reconcile [-- --apply]
 *
 * Student storage usage is calculated from file metadata (document_versions.fileSize,
 * project_handbooks.fileSize), never from a counter. Versions uploaded BEFORE quotas
 * existed may have no recorded size (only the current file's size was known); they count
 * as 0 until their size is read here from the stored object in Supabase Storage.
 *
 * Default = dry run (prints what would change). --apply writes the sizes.
 * Reads SUPABASE_URL, SUPABASE_SECRET_KEY and DATABASE_URL from .env. Never deletes anything.
 */
import { config as loadEnv } from 'dotenv';
import { resolve, posix } from 'path';
import { PrismaClient } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';
import { DOCUMENTS_BUCKET } from '../src/modules/documents/supabase-storage.service';

loadEnv({ path: resolve(__dirname, '..', '.env') });

async function main() {
  const apply = process.argv.includes('--apply');
  const url = process.env.SUPABASE_URL?.trim() ?? '';
  const secret = process.env.SUPABASE_SECRET_KEY?.trim() ?? '';
  if (!url || !secret || !process.env.DATABASE_URL) {
    console.log(
      'NOT RUN: set DATABASE_URL, SUPABASE_URL and SUPABASE_SECRET_KEY in .env',
    );
    process.exit(2);
  }
  const prisma = new PrismaClient();
  const bucket = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).storage.from(DOCUMENTS_BUCKET);
  try {
    const missing = await prisma.documentVersion.findMany({
      where: { fileSize: null },
      select: { id: true, fileUrl: true },
    });
    console.log(
      `${missing.length} document version(s) without a recorded size`,
    );
    let fixed = 0;
    let notFound = 0;
    for (const v of missing) {
      const dir = posix.dirname(v.fileUrl);
      const name = posix.basename(v.fileUrl);
      const { data, error } = await bucket.list(dir, {
        search: name,
        limit: 100,
      });
      const object = error ? null : data?.find((o) => o.name === name);
      const size = Number(
        (object?.metadata as { size?: unknown } | null)?.size,
      );
      if (!object || !Number.isFinite(size)) {
        notFound++;
        console.log(`  ? ${v.id}: stored object not found (left as unknown)`);
        continue;
      }
      console.log(`  ${apply ? '✔' : '→'} ${v.id}: ${size} bytes`);
      if (apply) {
        await prisma.documentVersion.updateMany({
          where: { id: v.id, fileSize: null },
          data: { fileSize: size },
        });
      }
      fixed++;
    }
    console.log(
      `${apply ? 'Updated' : 'Would update'} ${fixed}; not found ${notFound}.` +
        (apply ? '' : ' Run with -- --apply to write.'),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: Error & { code?: string }) => {
  console.error(`✖ reconcile failed: ${e.code ?? e.name}`);
  process.exit(1);
});
