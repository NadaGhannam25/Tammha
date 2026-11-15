import { Prisma } from '@prisma/client';
import type { PrismaService } from '@/prisma/prisma.service';

/** A PROCESSING upload older than this was interrupted (e.g. a restart during processing). */
export const HANDBOOK_PROCESSING_STALE_MS = 10 * 60 * 1000;

export type ProjectHandbookState = 'NONE' | 'PROCESSING' | 'READY' | 'FAILED';

/**
 * The one definition of a project's handbook state (handbook API, workspace, dashboard
 * and the Project Setup readiness check all use it):
 *  - NONE        nothing uploaded
 *  - PROCESSING  the latest upload is still being read (and not stale)
 *  - READY       an active, READY version exists and nothing newer is processing
 *  - FAILED      the latest upload failed (or was interrupted) and no READY version is active
 */
export function projectHandbookState(
  active: { status: string } | null,
  latest: { status: string; processingStartedAt?: Date | null } | null,
  now: Date = new Date(),
): ProjectHandbookState {
  if (!latest) return 'NONE';
  if (latest.status === 'PROCESSING') {
    const started = latest.processingStartedAt?.getTime() ?? now.getTime();
    if (now.getTime() - started <= HANDBOOK_PROCESSING_STALE_MS) {
      return 'PROCESSING';
    }
  }
  if (active && active.status === 'READY') return 'READY';
  return 'FAILED';
}

/** The handbook a project uses: its own upload, or a university's official handbook (library version). */
export interface EffectiveProjectHandbook {
  state: ProjectHandbookState;
  source: 'UPLOAD' | 'LIBRARY';
  /** title of the shown handbook (null when NONE) */
  title: string | null;
  /** upload version number, or the library version number */
  version: number | null;
  libraryVersion: {
    id: string;
    handbookId: string;
    title: string;
    versionLabel: string;
    /** real file name of the official PDF */
    fileName: string;
    universityId: string;
    universityName: string;
    pageCount: number | null;
  } | null;
}

type HandbookDb = Pick<
  PrismaService | Prisma.TransactionClient,
  'project' | 'projectHandbook'
>;

/**
 * The ONE answer to "which handbook applies to this project, and is it ready?" (setup
 * readiness, workspace, dashboard, handbook page and the AI all use it).
 *  - handbookSource = LIBRARY: the selected library version; READY when it still exists
 *    and has text, else NONE (e.g. the version was removed from the library).
 *  - otherwise (UPLOAD or not chosen yet): the state of the leader's uploads.
 */
export async function loadEffectiveHandbook(
  db: HandbookDb,
  projectId: string,
  now: Date = new Date(),
): Promise<EffectiveProjectHandbook> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: {
      handbookSource: true,
      libraryHandbook: {
        select: {
          id: true,
          handbookId: true,
          title: true,
          version: true,
          versionLabel: true,
          fileName: true,
          pageCount: true,
          extractedChars: true,
          universityId: true,
          university: { select: { name: true } },
          handbook: { select: { title: true } },
        },
      },
    },
  });
  if (project?.handbookSource === 'LIBRARY') {
    const v = project.libraryHandbook;
    if (!v || !v.extractedChars) {
      return {
        state: 'NONE',
        source: 'LIBRARY',
        title: null,
        version: null,
        libraryVersion: null,
      };
    }
    return {
      state: 'READY',
      source: 'LIBRARY',
      title: v.handbook?.title ?? v.title,
      version: v.version,
      libraryVersion: {
        id: v.id,
        handbookId: v.handbookId,
        title: v.handbook?.title ?? v.title,
        versionLabel: v.versionLabel,
        fileName: v.fileName,
        universityId: v.universityId,
        universityName: v.university?.name ?? '',
        pageCount: v.pageCount ?? null,
      },
    };
  }
  const [active, latest] = await Promise.all([
    db.projectHandbook.findFirst({
      where: { projectId, isActive: true },
      select: { title: true, version: true, status: true },
    }),
    db.projectHandbook.findFirst({
      where: { projectId },
      orderBy: { version: 'desc' },
      select: {
        title: true,
        version: true,
        status: true,
        processingStartedAt: true,
      },
    }),
  ]);
  const state = projectHandbookState(active, latest, now);
  const shown = state === 'READY' ? active : state === 'NONE' ? null : latest;
  return {
    state,
    source: 'UPLOAD',
    title: shown?.title ?? null,
    version: shown?.version ?? null,
    libraryVersion: null,
  };
}
