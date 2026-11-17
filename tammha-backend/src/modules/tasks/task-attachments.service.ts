import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@common/types/auth-user.type';
import { WorkspaceAccessService } from '@common/workspace/workspace-access.service';
import {
  WorkspaceErrorCode as E,
  workspaceError,
} from '@common/workspace/workspace-errors';
import { fileNameFromStoragePath } from '@modules/documents/document-files';
import {
  AddTaskAttachmentDto,
  TaskAttachmentViewDto,
} from './dto/task-attachment.dto';

/** An attachment row points to a project file: fileUrl = "document:<documentId>". */
const DOCUMENT_REF = 'document:';

/**
 * Task attachments = files of the task's project linked to the task. The file itself stays in
 * the project files (one stored copy, counted once in the storage quota, deleted with the file).
 * Students of the project and its supervisor see them; the Team Leader and the task's assignee
 * link or unlink them.
 */
@Injectable()
export class TaskAttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
  ) {}

  async list(user: AuthUser, taskId: string): Promise<TaskAttachmentViewDto[]> {
    const task = await this.getTask(taskId);
    await this.access.assertCanViewProject(user, task.projectId);
    return this.views(taskId, task.projectId);
  }

  async add(
    user: AuthUser,
    taskId: string,
    dto: AddTaskAttachmentDto,
  ): Promise<TaskAttachmentViewDto[]> {
    const task = await this.assertCanEdit(user, taskId);
    const doc = await this.prisma.document.findUnique({
      where: { id: dto.documentId },
      select: {
        id: true,
        projectId: true,
        title: true,
        fileUrl: true,
        fileSize: true,
      },
    });
    if (!doc || doc.projectId !== task.projectId) {
      throw new BadRequestException({
        code: 'ATTACHMENT_DOCUMENT_INVALID',
        message: "Choose a file of this task's project",
      });
    }
    const existing = await this.prisma.attachment.findFirst({
      where: { taskId, fileUrl: `${DOCUMENT_REF}${doc.id}` },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException({
        code: 'ATTACHMENT_EXISTS',
        message: 'This file is already attached to the task',
      });
    }
    await this.prisma.attachment.create({
      data: {
        taskId,
        fileUrl: `${DOCUMENT_REF}${doc.id}`,
        fileName: fileNameFromStoragePath(doc.fileUrl) || doc.title,
        fileSize: doc.fileSize,
      },
    });
    return this.views(taskId, task.projectId);
  }

  async remove(
    user: AuthUser,
    taskId: string,
    attachmentId: string,
  ): Promise<TaskAttachmentViewDto[]> {
    const task = await this.assertCanEdit(user, taskId);
    const row = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
      select: { id: true, taskId: true },
    });
    if (!row || row.taskId !== taskId) {
      throw new NotFoundException({
        code: 'ATTACHMENT_NOT_FOUND',
        message: 'Attachment not found',
      });
    }
    await this.prisma.attachment.delete({ where: { id: attachmentId } });
    return this.views(taskId, task.projectId);
  }

  /** Attachments whose project file still exists (a deleted file disappears from the task). */
  private async views(
    taskId: string,
    projectId: string,
  ): Promise<TaskAttachmentViewDto[]> {
    const rows = await this.prisma.attachment.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
    });
    const ids = rows
      .filter((r) => r.fileUrl.startsWith(DOCUMENT_REF))
      .map((r) => r.fileUrl.slice(DOCUMENT_REF.length));
    const docs = ids.length
      ? await this.prisma.document.findMany({
          where: { id: { in: ids }, projectId },
          select: { id: true, title: true, fileUrl: true, fileSize: true },
        })
      : [];
    const byId = new Map(docs.map((d) => [d.id, d]));
    return rows.flatMap((r) => {
      const doc = byId.get(r.fileUrl.slice(DOCUMENT_REF.length));
      if (!r.fileUrl.startsWith(DOCUMENT_REF) || !doc) return [];
      return [
        {
          id: r.id,
          taskId,
          documentId: doc.id,
          title: doc.title,
          fileName: fileNameFromStoragePath(doc.fileUrl) || r.fileName,
          fileSize: doc.fileSize,
          createdAt: r.createdAt,
        },
      ];
    });
  }

  private async getTask(taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, projectId: true, assignedToId: true },
    });
    if (!task) {
      throw new NotFoundException(
        workspaceError(E.TASK_NOT_FOUND, 'Task not found'),
      );
    }
    return task;
  }

  /** Team Leader of the project, or the student the task is assigned to. */
  private async assertCanEdit(user: AuthUser, taskId: string) {
    const task = await this.getTask(taskId);
    const project = await this.access.assertStudentOfProject(
      user,
      task.projectId,
    );
    const leader = await this.access.isLeaderOfTeam(user.id, project.teamId);
    if (!leader && task.assignedToId !== user.id) {
      throw new ForbiddenException({
        code: 'TASK_ATTACHMENT_FORBIDDEN',
        message:
          "The Team Leader or the task's assignee manages its attachments",
      });
    }
    return task;
  }
}
