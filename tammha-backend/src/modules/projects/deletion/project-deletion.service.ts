import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { AuthTokenType, StoredObjectKind } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@common/types/auth-user.type';
import { WorkspaceAccessService } from '@common/workspace/workspace-access.service';
import {
  AUTH_TOKEN_TTL_MS,
  AuthTokensService,
} from '@modules/auth/auth-tokens.service';
import { AccountEmailService } from '@modules/auth/account-email.service';
import {
  StorageDeletionService,
  StoredObjectToDelete,
} from '@modules/storage/storage-deletion.service';
import { isInProjectScope } from '@modules/documents/document-files';
import { isProjectHandbookPath } from '@modules/ai-support/handbook/project-handbook.service';

/** A new code can be asked for once a minute. */
const CODE_COOLDOWN_MS = 60_000;

const err = (code: string, message: string, details?: object) => ({
  code,
  message,
  ...(details ? { details } : {}),
});

const personName = (u: { firstName: string | null; lastName: string | null }) =>
  [u.firstName, u.lastName].filter(Boolean).join(' ').trim();

/**
 * Deleting a whole project (only its owner, the team LEADER):
 *  1) POST /projects/:id/deletion/request e-mails a 6-digit code to the owner;
 *  2) POST /projects/:id/deletion/confirm { code } deletes the project and its team with
 *     every stage, task, file, meeting and AI record (database cascade); the stored files
 *     are queued for removal and removed at once when possible; every student of the
 *     team receives a confirmation e-mail.
 * The code is bound to the project (a code for another project does not work here).
 */
@Injectable()
export class ProjectDeletionService {
  private readonly logger = new Logger(ProjectDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly authTokens: AuthTokensService,
    private readonly mail: AccountEmailService,
    private readonly deletions: StorageDeletionService,
  ) {}

  async request(user: AuthUser, projectId: string, now = new Date()) {
    const project = await this.access.assertOwnerOfProject(user, projectId);
    const last = await this.authTokens.lastCodeIssuedAt(
      user.id,
      AuthTokenType.PROJECT_DELETION,
    );
    const waitMs = last
      ? last.getTime() + CODE_COOLDOWN_MS - now.getTime()
      : 0;
    if (waitMs > 0) {
      throw new HttpException(
        err('DELETION_CODE_RECENTLY_SENT', 'A code was sent a moment ago', {
          retryAfterSeconds: Math.ceil(waitMs / 1000),
        }),
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const owner = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: {
        email: true,
        firstName: true,
        lastName: true,
        preferredLanguage: true,
      },
    });
    const code = await this.authTokens.issueCode(
      user.id,
      AuthTokenType.PROJECT_DELETION,
      AUTH_TOKEN_TTL_MS[AuthTokenType.PROJECT_DELETION],
      this.prisma,
      now,
      project.id,
    );
    await this.mail.sendProjectDeletionCode(
      owner!.email,
      owner!.firstName,
      project.name,
      code,
      owner!.preferredLanguage,
    );
    return {
      sent: true,
      expiresInSeconds: Math.round(
        AUTH_TOKEN_TTL_MS[AuthTokenType.PROJECT_DELETION] / 1000,
      ),
      emailDelivery: this.mail.deliveryState,
    };
  }

  async confirm(
    user: AuthUser,
    projectId: string,
    code: string,
    now = new Date(),
  ) {
    const project = await this.access.assertOwnerOfProject(user, projectId);
    const check = await this.authTokens.checkCode(
      user.id,
      AuthTokenType.PROJECT_DELETION,
      code,
      now,
      project.id,
    );
    if (check !== 'OK') {
      throw new BadRequestException(
        err(
          'DELETION_CODE_INVALID',
          'The code is incorrect or has expired. Request a new one.',
        ),
      );
    }

    // who is told afterwards: every student of the team (read before the cascade)
    const students = await this.prisma.teamMember.findMany({
      where: { teamId: project.teamId },
      select: {
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            preferredLanguage: true,
            isActive: true,
          },
        },
      },
    });
    const owner = students.find((s) => s.user.id === user.id)?.user;

    // 1) database: record the stored files as pending deletions, then delete the team
    //    (its project, and everything in the project, follow by cascade)
    const paths = await this.prisma.$transaction(async (tx) => {
      const [documents, handbooks] = await Promise.all([
        tx.document.findMany({
          where: { projectId: project.id },
          select: {
            fileUrl: true,
            uploadedById: true,
            versions: {
              select: { fileUrl: true, fileSize: true, uploadedById: true },
            },
          },
        }),
        tx.projectHandbook.findMany({
          where: { projectId: project.id },
          select: { storagePath: true, fileSize: true, uploadedById: true },
        }),
      ]);
      const objects: StoredObjectToDelete[] = [
        ...documents.flatMap((d) => [
          ...d.versions.map((v) => ({
            storagePath: v.fileUrl,
            fileSize: v.fileSize,
            uploadedById: v.uploadedById,
          })),
          { storagePath: d.fileUrl, fileSize: null, uploadedById: d.uploadedById },
        ]).map((o) => ({
          ...o,
          kind: StoredObjectKind.DOCUMENT_FILE,
          projectId: project.id,
          safeToDelete: isInProjectScope(o.storagePath, project.id),
        })),
        ...handbooks.map((h) => ({
          storagePath: h.storagePath,
          kind: StoredObjectKind.PROJECT_HANDBOOK,
          fileSize: h.fileSize,
          uploadedById: h.uploadedById,
          projectId: project.id,
          safeToDelete: isProjectHandbookPath(h.storagePath, project.id),
        })),
      ];
      // the same path may appear twice (the current file is also a version)
      const unique = [
        ...new Map(objects.map((o) => [o.storagePath, o])).values(),
      ];
      if (unique.length) await this.deletions.queue(tx, unique);
      await tx.project.delete({ where: { id: project.id } });
      await tx.team.delete({ where: { id: project.teamId } });
      return unique.map((o) => o.storagePath);
    });

    // 2) storage: removed now when possible (otherwise retried in the background)
    if (paths.length) {
      const storage = await this.deletions.removeNow(paths);
      if (storage.status !== 'REMOVED') {
        this.logger.error(
          `Project ${project.id} deleted; ${storage.pendingObjects} stored object(s) not removed yet (retried later)`,
        );
      }
    }

    // 3) every student of the team is told by e-mail
    const by = owner ? personName(owner) || owner.email : '';
    for (const { user: s } of students) {
      if (!s.isActive) continue;
      await this.mail.sendProjectDeleted(
        s.email,
        s.firstName,
        project.name,
        by,
        s.preferredLanguage,
      );
    }
    return { deleted: true };
  }
}
