import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  DocumentCategory,
  MeetingStatus,
  MilestoneStatus,
  Priority,
  ProjectCategory,
  ProjectOrigin,
  ProjectSetupStep,
  ProjectStatus,
  SubmissionStatus,
  TaskStatus,
  TeamRole,
} from '@prisma/client';
import { PublicUserDto } from '@modules/teams/dto/team-response.dto';
import { FeedbackViewDto } from '@modules/feedback/dto/feedback-response.dto';

// ---------------------------------------------------------------------------
// Progress & readiness (shared)
// ---------------------------------------------------------------------------

export class ProgressComponentDto {
  @ApiProperty({ enum: ['TASKS', 'MILESTONES', 'REQUIRED_DOCUMENTS_APPROVED'] })
  key!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ description: 'Nominal weight' }) weight!: number;
  @ApiProperty({
    description: 'Weight after leaving out components with no items',
  })
  effectiveWeight!: number;
  @ApiProperty() done!: number;
  @ApiProperty() total!: number;
  @ApiProperty() percent!: number;
  @ApiProperty({ description: 'Points added to the overall percent' })
  contribution!: number;
  @ApiProperty({ description: 'false when the component has no items' })
  included!: boolean;
}

export class ProgressDto {
  @ApiProperty({ minimum: 0, maximum: 100 }) percent!: number;
  @ApiProperty({ type: [ProgressComponentDto] })
  components!: ProgressComponentDto[];
  @ApiProperty() formula!: string;
  @ApiProperty({ example: 'progress-v1' }) version!: string;
}

export class RequiredDocumentStatusDto {
  @ApiProperty({ enum: DocumentCategory }) category!: DocumentCategory;
  @ApiProperty({
    enum: [...Object.values(SubmissionStatus), 'MISSING'],
    description: 'Most advanced status among the documents of this category',
  })
  status!: SubmissionStatus | 'MISSING';
  @ApiProperty() documentCount!: number;
}

export class ReadinessCriterionDto {
  @ApiProperty({
    enum: [
      'TASKS_COMPLETED',
      'MILESTONES_COMPLETED',
      'REQUIRED_DOCUMENTS_SUBMITTED',
      'REQUIRED_DOCUMENTS_APPROVED',
      'FEEDBACK_ADDRESSED',
      'NO_OVERDUE_WORK',
    ],
  })
  key!: string;
  @ApiProperty() label!: string;
  @ApiProperty() weight!: number;
  @ApiProperty({ description: '0..1 share fulfilled' }) ratio!: number;
  @ApiProperty() points!: number;
  @ApiProperty() met!: boolean;
  @ApiProperty() detail!: string;
  @ApiProperty({ nullable: true, type: String, description: 'Next step' })
  action!: string | null;
}

export class ReadinessDto {
  @ApiProperty({ minimum: 0, maximum: 100 }) score!: number;
  @ApiProperty({ enum: ['NOT_READY', 'IN_PROGRESS', 'ALMOST_READY', 'READY'] })
  level!: string;
  @ApiProperty({ type: [ReadinessCriterionDto] })
  criteria!: ReadinessCriterionDto[];
  @ApiProperty({ type: [String], description: 'Next steps, in order' })
  missing!: string[];
  @ApiProperty({ type: [RequiredDocumentStatusDto] })
  requiredDocuments!: RequiredDocumentStatusDto[];
  @ApiProperty({ enum: ['RULE_BASED'] }) method!: 'RULE_BASED';
  @ApiProperty({ description: 'Always false: no AI is involved' })
  aiUsed!: false;
  @ApiProperty({ example: 'readiness-v1' }) version!: string;
  @ApiProperty() levels!: string;
}

export class ProjectProgressResponseDto {
  @ApiProperty() projectId!: string;
  @ApiProperty() calculatedAt!: Date;
  @ApiProperty({ type: ProgressDto }) progress!: ProgressDto;
  @ApiProperty({ type: ReadinessDto }) readiness!: ReadinessDto;
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

export class TaskSummaryDto {
  @ApiProperty({ description: 'All tasks except cancelled' }) total!: number;
  @ApiProperty() completed!: number;
  @ApiProperty({
    description: 'Not completed (TODO, IN_PROGRESS, IN_REVIEW, BLOCKED)',
  })
  pending!: number;
  @ApiProperty({ description: 'Pending with a past due date' })
  overdue!: number;
  @ApiProperty() cancelled!: number;
  @ApiProperty({ description: 'completed / total' }) completionPercent!: number;
  @ApiProperty({
    description: 'Count per status',
    example: { TODO: 2, IN_PROGRESS: 1, COMPLETED: 3 },
  })
  byStatus!: Record<TaskStatus, number>;
}

export class MilestoneProgressItemDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() dueDate!: Date;
  @ApiProperty({ enum: MilestoneStatus }) status!: MilestoneStatus;
  @ApiProperty() isOverdue!: boolean;
  @ApiProperty() totalTasks!: number;
  @ApiProperty() completedTasks!: number;
  @ApiProperty() percent!: number;
}

export class MilestoneSummaryDto {
  @ApiProperty() total!: number;
  @ApiProperty() completed!: number;
  @ApiProperty() pending!: number;
  @ApiProperty() overdue!: number;
  @ApiProperty({ type: [MilestoneProgressItemDto], description: 'By due date' })
  items!: MilestoneProgressItemDto[];
}

export class DeadlineDto {
  @ApiProperty({ enum: ['TASK', 'MILESTONE'] }) type!: 'TASK' | 'MILESTONE';
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() dueDate!: Date;
  @ApiProperty({ description: 'Task or milestone status' }) status!: string;
  @ApiProperty({ description: '0 = due today' }) daysLeft!: number;
  @ApiPropertyOptional({ enum: Priority }) priority?: Priority;
  @ApiPropertyOptional({ type: PublicUserDto, nullable: true })
  assignedTo?: PublicUserDto | null;
}

export class DocumentSummaryItemDto {
  @ApiProperty() id!: string;
  @ApiProperty() projectId!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ enum: DocumentCategory }) category!: DocumentCategory;
  @ApiProperty({ enum: SubmissionStatus }) reviewStatus!: SubmissionStatus;
  @ApiProperty({ nullable: true, type: Date })
  reviewStatusUpdatedAt!: Date | null;
  @ApiProperty() versions!: number;
  @ApiProperty({ type: PublicUserDto }) uploadedBy!: PublicUserDto;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class SubmissionSummaryDto {
  @ApiProperty() total!: number;
  @ApiProperty({ description: 'SUBMITTED + UNDER_REVIEW' })
  awaitingReview!: number;
  @ApiProperty({ description: 'CHANGES_REQUESTED + REJECTED' })
  needsChanges!: number;
  @ApiProperty() approved!: number;
  @ApiProperty({ example: { SUBMITTED: 1, UNDER_REVIEW: 0, APPROVED: 2 } })
  byStatus!: Record<SubmissionStatus, number>;
  @ApiProperty({ type: [RequiredDocumentStatusDto] })
  requiredDocuments!: RequiredDocumentStatusDto[];
}

export class MeetingSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() projectId!: string;
  @ApiProperty() title!: string;
  @ApiProperty() scheduledAt!: Date;
  @ApiProperty({ description: 'minutes' }) duration!: number;
  @ApiProperty({ nullable: true, type: String }) location!: string | null;
  @ApiProperty({ nullable: true, type: String }) meetingUrl!: string | null;
  @ApiProperty({ enum: MeetingStatus }) status!: MeetingStatus;
}

export class TeamMemberSummaryDto {
  @ApiProperty({ enum: TeamRole, description: 'Display label only' })
  role!: TeamRole;
  @ApiProperty({ type: PublicUserDto }) user!: PublicUserDto;
}

export class DashboardProjectDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty({ enum: ProjectStatus }) status!: ProjectStatus;
  @ApiProperty({ nullable: true, type: Date }) startDate!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) endDate!: Date | null;
  @ApiProperty() teamId!: string;
  @ApiProperty() teamName!: string;
  @ApiProperty({ type: [TeamMemberSummaryDto] })
  members!: TeamMemberSummaryDto[];
  @ApiProperty({ type: PublicUserDto, nullable: true })
  supervisor!: PublicUserDto | null;
  // P16 project details
  @ApiProperty({ nullable: true, type: String }) overview!: string | null;
  @ApiProperty({ type: [String] }) objectives!: string[];
  @ApiProperty({ enum: ProjectCategory, nullable: true })
  category!: ProjectCategory | null;
  @ApiProperty({ enum: ProjectOrigin, nullable: true })
  origin!: ProjectOrigin | null;
  @ApiProperty({ nullable: true, type: Date })
  expectedCompletionDate!: Date | null;
  @ApiProperty({ type: PublicUserDto, nullable: true })
  leader!: PublicUserDto | null;
}

// ---------------------------------------------------------------------------
// Student dashboard
// ---------------------------------------------------------------------------

export const STUDENT_DASHBOARD_STATES = [
  'NO_PROJECT',
  'SETUP_IN_PROGRESS',
  'EMPTY_PROJECT',
  'ACTIVE',
] as const;

export class DashboardViewerDto {
  @ApiProperty({ enum: TeamRole, nullable: true })
  teamRole!: TeamRole | null;
  @ApiProperty() isLeader!: boolean;
  @ApiProperty({ description: 'A student of the team: every student manages the project alike' })
  canManage!: boolean;
  @ApiProperty({
    description:
      'false when the student has no student number and no verified university e-mail ' +
      '(cannot create a project or lead a team: 403 UNIVERSITY_IDENTITY_REQUIRED)',
  })
  profileComplete!: boolean;
}

export class DashboardSetupDto {
  @ApiProperty({ enum: ProjectSetupStep }) step!: ProjectSetupStep;
  @ApiProperty() completed!: boolean;
  @ApiProperty({ nullable: true, type: Date }) completedAt!: Date | null;
}

export class DashboardTaskItemDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ enum: TaskStatus }) status!: TaskStatus;
  @ApiProperty({ enum: Priority }) priority!: Priority;
  @ApiProperty({ nullable: true, type: Date }) dueDate!: Date | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Whole days until the due date (negative = overdue)',
  })
  daysLeft!: number | null;
  @ApiProperty() isOverdue!: boolean;
  @ApiProperty({ nullable: true, type: String }) assignedStudentId!:
    string | null;
}

export class MyTasksDto {
  @ApiProperty({ description: 'Open tasks assigned to you' }) open!: number;
  @ApiProperty() overdue!: number;
  @ApiProperty({
    type: [DashboardTaskItemDto],
    description: 'Overdue first, then by due date (tasks without a date last)',
  })
  items!: DashboardTaskItemDto[];
}

export class DashboardHandbookDto {
  @ApiProperty({ enum: ['NONE', 'PROCESSING', 'READY', 'FAILED'] })
  state!: 'NONE' | 'PROCESSING' | 'READY' | 'FAILED';
  @ApiProperty({ enum: ['UPLOAD', 'LIBRARY'] }) source!: 'UPLOAD' | 'LIBRARY';
  @ApiProperty({ nullable: true, type: String }) title!: string | null;
  @ApiProperty({ nullable: true, type: Number }) version!: number | null;
}
// ---------------------------------------------------------------------------

/** One of the student's projects (for the project switcher). */
export class DashboardProjectRefDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['LEADER', 'MEMBER'] }) teamRole!: 'LEADER' | 'MEMBER';
  @ApiProperty() status!: string;
  @ApiProperty() setupStep!: string;
}

export class StudentDashboardDto {
  @ApiProperty({
    enum: STUDENT_DASHBOARD_STATES,
    description:
      'NO_PROJECT: no team yet. SETUP_IN_PROGRESS: first-project setup not finished (resume at setup.step). ' +
      'EMPTY_PROJECT: set up (or skipped) but no tasks/milestones yet. ACTIVE: work in progress.',
  })
  state!: (typeof STUDENT_DASHBOARD_STATES)[number];
  @ApiProperty({
    description: 'false when the student has no team/project yet',
  })
  hasProject!: boolean;
  @ApiProperty({ type: DashboardViewerDto }) viewer!: DashboardViewerDto;
  @ApiProperty({ type: DashboardSetupDto, nullable: true })
  setup!: DashboardSetupDto | null;
  @ApiProperty({ type: MyTasksDto, nullable: true })
  myTasks!: MyTasksDto | null;
  @ApiProperty({
    type: [DashboardTaskItemDto],
    description: 'Open project tasks past their due date (most overdue first)',
  })
  overdueTasks!: DashboardTaskItemDto[];
  @ApiProperty({ type: DashboardHandbookDto, nullable: true })
  handbook!: DashboardHandbookDto | null;
  @ApiProperty({
    description:
      'Pending team invitations addressed to you (useful in NO_PROJECT)',
  })
  pendingTeamInvitations!: number;
  @ApiProperty({
    type: [DashboardProjectRefDto],
    description:
      'All projects of the student (most recently joined first); `project` is the one shown (?projectId=)',
  })
  projects!: DashboardProjectRefDto[];
  @ApiProperty({ type: DashboardProjectDto, nullable: true })
  project!: DashboardProjectDto | null;
  @ApiProperty({
    description: 'Overall project progress percent (= progress.percent)',
  })
  completionPercent!: number;
  @ApiProperty({ type: TaskSummaryDto, nullable: true })
  tasks!: TaskSummaryDto | null;
  @ApiProperty({ type: MilestoneSummaryDto, nullable: true })
  milestones!: MilestoneSummaryDto | null;
  @ApiProperty({
    type: [DeadlineDto],
    description: 'Open tasks and milestones due in the window',
  })
  upcomingDeadlines!: DeadlineDto[];
  @ApiProperty({ type: [DocumentSummaryItemDto] })
  latestDocuments!: DocumentSummaryItemDto[];
  @ApiProperty({
    type: [FeedbackViewDto],
    description: 'Hidden scores are null (P08 rules)',
  })
  latestFeedback!: FeedbackViewDto[];
  @ApiProperty({
    type: [MeetingSummaryDto],
    description: 'Empty when there are no meeting records',
  })
  upcomingMeetings!: MeetingSummaryDto[];
  @ApiProperty() unreadNotifications!: number;
  @ApiProperty({ type: SubmissionSummaryDto, nullable: true })
  submissions!: SubmissionSummaryDto | null;
  @ApiProperty({ type: ProgressDto, nullable: true })
  progress!: ProgressDto | null;
  @ApiProperty({ type: ReadinessDto, nullable: true })
  readiness!: ReadinessDto | null;
  @ApiProperty() generatedAt!: Date;
}

// ---------------------------------------------------------------------------
// Supervisor dashboard
// ---------------------------------------------------------------------------

export class WorkCountDto {
  @ApiProperty() total!: number;
  @ApiProperty() completed!: number;
  @ApiProperty() pending!: number;
  @ApiProperty() overdue!: number;
}

export class SupervisedProjectDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ProjectStatus }) status!: ProjectStatus;
  @ApiProperty({ nullable: true, type: Date }) endDate!: Date | null;
  @ApiProperty() teamId!: string;
  @ApiProperty() teamName!: string;
  @ApiProperty() memberCount!: number;
  @ApiProperty() progressPercent!: number;
  @ApiProperty() readinessScore!: number;
  @ApiProperty({ enum: ['NOT_READY', 'IN_PROGRESS', 'ALMOST_READY', 'READY'] })
  readinessLevel!: string;
  @ApiProperty({ type: WorkCountDto }) tasks!: WorkCountDto;
  @ApiProperty({ type: WorkCountDto }) milestones!: WorkCountDto;
  @ApiProperty() awaitingReview!: number;
  @ApiProperty() needsChanges!: number;
  @ApiProperty() hasOverdue!: boolean;
}

export class OverdueTaskDto {
  @ApiProperty() id!: string;
  @ApiProperty() projectId!: string;
  @ApiProperty() projectName!: string;
  @ApiProperty() title!: string;
  @ApiProperty() dueDate!: Date;
  @ApiProperty({ enum: TaskStatus }) status!: TaskStatus;
  @ApiProperty({ enum: Priority }) priority!: Priority;
  @ApiProperty() daysOverdue!: number;
  @ApiProperty({ type: PublicUserDto, nullable: true })
  assignedTo!: PublicUserDto | null;
}

export class OverdueProjectDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() overdueTasks!: number;
  @ApiProperty() overdueMilestones!: number;
}

export class OverdueSectionDto {
  @ApiProperty({ type: [OverdueProjectDto] }) projects!: OverdueProjectDto[];
  @ApiProperty({ type: [OverdueTaskDto], description: 'Most overdue first' })
  tasks!: OverdueTaskDto[];
  @ApiProperty() totalOverdueTasks!: number;
}

export class SubmissionItemDto {
  @ApiProperty() documentId!: string;
  @ApiProperty() projectId!: string;
  @ApiProperty() projectName!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ enum: DocumentCategory }) category!: DocumentCategory;
  @ApiProperty() version!: number;
  @ApiProperty() submittedAt!: Date;
  @ApiProperty({
    enum: SubmissionStatus,
    description: 'Current status of the document',
  })
  reviewStatus!: SubmissionStatus;
}

export class AwaitingReviewItemDto {
  @ApiProperty() documentId!: string;
  @ApiProperty() projectId!: string;
  @ApiProperty() projectName!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ enum: DocumentCategory }) category!: DocumentCategory;
  @ApiProperty({ enum: SubmissionStatus }) reviewStatus!: SubmissionStatus;
  @ApiProperty({ description: 'Last upload / change of the document' })
  waitingSince!: Date;
  @ApiProperty() daysWaiting!: number;
}

export class AwaitingReviewSectionDto {
  @ApiProperty() total!: number;
  @ApiProperty({
    type: [AwaitingReviewItemDto],
    description: 'Longest waiting first',
  })
  items!: AwaitingReviewItemDto[];
}

export class SupervisorSummaryDto {
  @ApiProperty() totalProjects!: number;
  @ApiProperty() projectsWithOverdue!: number;
  @ApiProperty() overdueTasks!: number;
  @ApiProperty() overdueMilestones!: number;
  @ApiProperty() awaitingReview!: number;
  @ApiProperty() needsChanges!: number;
  @ApiProperty({ description: 'Average progress of the supervised projects' })
  averageProgress!: number;
  @ApiProperty() readyProjects!: number;
  @ApiProperty() unreadNotifications!: number;
}

export class SupervisorDashboardDto {
  @ApiProperty({ type: SupervisorSummaryDto }) summary!: SupervisorSummaryDto;
  @ApiProperty({ type: [SupervisedProjectDto], description: 'Sorted by name' })
  projects!: SupervisedProjectDto[];
  @ApiProperty({ type: OverdueSectionDto }) overdue!: OverdueSectionDto;
  @ApiProperty({
    type: [SubmissionItemDto],
    description: 'Newest uploads/versions first',
  })
  latestSubmissions!: SubmissionItemDto[];
  @ApiProperty({ type: AwaitingReviewSectionDto })
  awaitingReview!: AwaitingReviewSectionDto;
  @ApiProperty({
    type: [MeetingSummaryDto],
    description: 'Empty when there are no meeting records',
  })
  upcomingMeetings!: MeetingSummaryDto[];
  @ApiProperty() generatedAt!: Date;
}
