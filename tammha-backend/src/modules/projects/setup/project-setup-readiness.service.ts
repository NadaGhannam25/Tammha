import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  ProjectCategory,
  ProjectOrigin,
  SupervisionRequestStatus,
  TeamRole,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { hasUniversityIdentity } from '@common/identity/university-identity';
import {
  loadEffectiveHandbook,
  ProjectHandbookState,
} from '@modules/ai-support/handbook/handbook-state';

type Db = PrismaService | Prisma.TransactionClient;

/**
 * Every requirement of Complete Project Setup, in the order the setup screens ask for
 * them. A code in `missingRequirements` names exactly what is still missing.
 */
export const SETUP_REQUIREMENT_CODES = [
  'TEAM_LEADER_REQUIRED',
  'EMAIL_NOT_VERIFIED',
  'UNIVERSITY_IDENTITY_REQUIRED',
  'TEAM_NAME_REQUIRED',
  'PROJECT_NAME_REQUIRED',
  'PROJECT_DESCRIPTION_REQUIRED',
  'PROJECT_OVERVIEW_REQUIRED',
  'PROJECT_OBJECTIVES_REQUIRED',
  'PROJECT_CATEGORY_REQUIRED',
  'PROJECT_ORIGIN_REQUIRED',
  'PROJECT_START_DATE_REQUIRED',
  'PROJECT_END_DATE_REQUIRED',
  'PROJECT_DATES_INVALID',
  'SUPERVISOR_REQUEST_REQUIRED',
  'SUPERVISOR_APPROVAL_REQUIRED',
  'HANDBOOK_REQUIRED',
  'HANDBOOK_PROCESSING',
  'HANDBOOK_FAILED',
] as const;
export type SetupRequirementCode = (typeof SETUP_REQUIREMENT_CODES)[number];

export interface ProjectSetupReadiness {
  /** every requirement is met (completion would succeed) */
  canComplete: boolean;
  /** what is still missing, in setup order (empty when canComplete) */
  missingRequirements: SetupRequirementCode[];
  /** setup already completed */
  completed: boolean;
  handbookState: ProjectHandbookState;
  /** where the applicable handbook comes from */
  handbookSource: 'UPLOAD' | 'LIBRARY';
  /** the request that satisfies the supervisor step (PENDING or ACCEPTED), if any */
  supervisorRequestStatus: 'PENDING' | 'ACCEPTED' | null;
}

const PROJECT_SELECT = {
  id: true,
  teamId: true,
  name: true,
  description: true,
  overview: true,
  objectives: true,
  category: true,
  origin: true,
  startDate: true,
  endDate: true,
  expectedCompletionDate: true,
  setupStep: true,
} satisfies Prisma.ProjectSelect;

const blank = (value: string | null | undefined) => !value || !value.trim();
const isDate = (d: Date | null | undefined): d is Date =>
  d instanceof Date && !Number.isNaN(d.getTime());

/**
 * The ONE Project Setup readiness check. Used by the setup responses (workspace
 * `setupReadiness`, GET /projects/:id/setup) and enforced again by the completion
 * endpoint inside its transaction, so the frontend cannot skip a requirement.
 *
 * Required:
 *  - a team LEADER whose account e-mail is verified and who has a university identity
 *    (student number or verified university e-mail)
 *  - project name, description, overview (not blank), at least one non-blank objective,
 *    a valid category and origin, a start date and an expected completion (or end) date
 *    after the start date (an end date, when set, must also be after the start date)
 *  - an active team with a name (TEAM_NAME_REQUIRED)
 *  - an academic supervisor is OPTIONAL by default: the leader may invite one later from
 *    the project. Only with SETUP_REQUIRE_SUPERVISOR=true must a request be PENDING or
 *    ACCEPTED (REJECTED / CANCELLED do not count), and with SETUP_REQUIRE_SUPERVISOR_APPROVAL=true
 *    it must be ACCEPTED (SUPERVISOR_APPROVAL_REQUIRED while the request is pending; this
 *    implies SETUP_REQUIRE_SUPERVISOR)
 *  - the applicable handbook in state READY: a version selected from the handbook
 *    library, or the leader's own upload (NONE / PROCESSING / FAILED block completion)
 * Not required: invited students accepting (outside the leader's control).
 */
@Injectable()
export class ProjectSetupReadinessService {
  /** SETUP_REQUIRE_SUPERVISOR=true: a supervision request is needed before completion */
  private readonly requireSupervisor: boolean;
  /** SETUP_REQUIRE_SUPERVISOR_APPROVAL=true: the supervisor must ACCEPT before completion */
  private readonly requireSupervisorApproval: boolean;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() config?: ConfigService,
  ) {
    const flag = (key: string) =>
      /^(true|1|yes)$/i.test((config?.get<string>(key) ?? '').trim());
    this.requireSupervisorApproval = flag('SETUP_REQUIRE_SUPERVISOR_APPROVAL');
    this.requireSupervisor =
      flag('SETUP_REQUIRE_SUPERVISOR') || this.requireSupervisorApproval;
  }

  async evaluate(
    projectId: string,
    db: Db = this.prisma,
    now: Date = new Date(),
  ): Promise<ProjectSetupReadiness> {
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: PROJECT_SELECT,
    });
    if (!project) {
      throw new Error(`project ${projectId} not found for readiness`);
    }

    const [leaderLink, handbook, requests, supervisorLinks, team] =
      await Promise.all([
        db.teamMember.findFirst({
          where: { teamId: project.teamId, role: TeamRole.LEADER },
          select: { userId: true },
        }),
        loadEffectiveHandbook(db, projectId, now),
        db.supervisionRequest.findMany({
          where: {
            projectId,
            status: {
              in: [
                SupervisionRequestStatus.ACCEPTED,
                SupervisionRequestStatus.PENDING,
              ],
            },
          },
          select: { status: true },
        }),
        db.projectMember.findMany({
          where: { projectId },
          select: { user: { select: { role: true } } },
        }),
        db.team.findUnique({
          where: { id: project.teamId },
          select: { name: true, isActive: true },
        }),
      ]);
    const leader = leaderLink
      ? await db.user.findUnique({
          where: { id: leaderLink.userId },
          select: {
            role: true,
            universityId: true,
            studentNumber: true,
            universityEmail: true,
            universityEmailVerifiedAt: true,
            emailVerifiedAt: true,
            isActive: true,
          },
        })
      : null;

    const missing = new Set<SetupRequirementCode>();

    // ---- team leader ----
    if (!leader || !leader.isActive) {
      missing.add('TEAM_LEADER_REQUIRED');
    } else {
      if (!leader.emailVerifiedAt) missing.add('EMAIL_NOT_VERIFIED');
      if (!hasUniversityIdentity(leader)) {
        missing.add('UNIVERSITY_IDENTITY_REQUIRED');
      }
    }

    // ---- team ----
    if (!team || !team.isActive || blank(team.name)) {
      missing.add('TEAM_NAME_REQUIRED');
    }

    // ---- project details ----
    if (blank(project.name)) missing.add('PROJECT_NAME_REQUIRED');
    if (blank(project.description)) missing.add('PROJECT_DESCRIPTION_REQUIRED');
    if (blank(project.overview)) missing.add('PROJECT_OVERVIEW_REQUIRED');
    if (!(project.objectives ?? []).some((o) => !blank(o))) {
      missing.add('PROJECT_OBJECTIVES_REQUIRED');
    }
    if (
      !project.category ||
      !(Object.values(ProjectCategory) as string[]).includes(project.category)
    ) {
      missing.add('PROJECT_CATEGORY_REQUIRED');
    }
    if (
      !project.origin ||
      !(Object.values(ProjectOrigin) as string[]).includes(project.origin)
    ) {
      missing.add('PROJECT_ORIGIN_REQUIRED');
    }

    // ---- dates ----
    const start = project.startDate;
    const finish = project.expectedCompletionDate ?? project.endDate;
    if (!isDate(start)) missing.add('PROJECT_START_DATE_REQUIRED');
    if (!isDate(finish)) missing.add('PROJECT_END_DATE_REQUIRED');
    if (isDate(start)) {
      const after = [project.expectedCompletionDate, project.endDate].filter(
        isDate,
      );
      if (after.some((d) => d.getTime() <= start.getTime())) {
        missing.add('PROJECT_DATES_INVALID');
      }
    }

    // ---- supervisor (optional unless SETUP_REQUIRE_SUPERVISOR / _APPROVAL) ----
    const hasSupervisor = supervisorLinks.some(
      (l) => l.user.role === UserRole.SUPERVISOR,
    );
    const statuses = new Set(requests.map((r) => r.status));
    const requestStatus: 'PENDING' | 'ACCEPTED' | null =
      statuses.has(SupervisionRequestStatus.ACCEPTED) || hasSupervisor
        ? 'ACCEPTED'
        : statuses.has(SupervisionRequestStatus.PENDING)
          ? 'PENDING'
          : null;
    if (!this.requireSupervisor) {
      // nothing to add: a missing or pending supervisor never blocks the project
    } else if (!requestStatus) missing.add('SUPERVISOR_REQUEST_REQUIRED');
    else if (this.requireSupervisorApproval && requestStatus === 'PENDING') {
      missing.add('SUPERVISOR_APPROVAL_REQUIRED');
    }

    // ---- handbook: the applicable one (selected library version or own upload) ----
    const handbookState = handbook.state;
    if (handbookState === 'NONE') missing.add('HANDBOOK_REQUIRED');
    if (handbookState === 'PROCESSING') missing.add('HANDBOOK_PROCESSING');
    if (handbookState === 'FAILED') missing.add('HANDBOOK_FAILED');

    const missingRequirements = SETUP_REQUIREMENT_CODES.filter((c) =>
      missing.has(c),
    );
    return {
      canComplete: missingRequirements.length === 0,
      missingRequirements,
      completed: project.setupStep === 'COMPLETED',
      handbookState,
      handbookSource: handbook.source,
      supervisorRequestStatus: requestStatus,
    };
  }
}
