import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  DOCUMENT_CATEGORY_LABELS,
  DOCUMENT_STATUS_LABELS,
  FEEDBACK_CATEGORY_LABELS,
  Label,
  LEADER_ONLY_TASK_STATUSES,
  PRIORITY_LABELS,
  PROJECT_CATEGORY_LABELS,
  PROJECT_ORIGIN_LABELS,
  PROJECT_STATUS_LABELS,
  STAGE_STATUS_LABELS,
  TASK_STATUS_LABELS,
  TASK_STATUS_TRANSITIONS,
} from '@common/status/status-catalog';
import { STUDENT_TRANSITIONS } from '@modules/projects/status/project-status.service';
import { REVIEW_STATUSES } from '@modules/feedback/dto/feedback.dto';

const list = <K extends string>(labels: Record<K, Label>) =>
  (Object.keys(labels) as K[]).map((code) => ({ code, ...labels[code] }));

/**
 * Public, static reference values: the ONE vocabulary of statuses and classifications
 * (codes = database values, Arabic/English labels, allowed transitions). The frontend
 * mirrors it in domain.js and can load it at runtime after integration.
 */
@Controller('reference')
@ApiTags('Reference')
export class ReferenceController {
  @Get('values')
  @ApiOperation({
    summary: 'Statuses, classifications and allowed transitions (public)',
    description:
      'Derived states (overdue, due soon) are not statuses: they are computed from the due date.',
  })
  @ApiOkResponse({ schema: { type: 'object' } })
  values() {
    return {
      taskStatuses: list(TASK_STATUS_LABELS),
      taskStatusTransitions: TASK_STATUS_TRANSITIONS,
      leaderOnlyTaskStatuses: LEADER_ONLY_TASK_STATUSES,
      priorities: list(PRIORITY_LABELS),
      stageStatuses: list(STAGE_STATUS_LABELS),
      projectStatuses: list(PROJECT_STATUS_LABELS),
      projectStatusTransitions: {
        teamLeader: STUDENT_TRANSITIONS,
        supervisor: 'ANY',
      },
      documentStatuses: list(DOCUMENT_STATUS_LABELS),
      documentReviewDecisions: REVIEW_STATUSES,
      projectCategories: list(PROJECT_CATEGORY_LABELS),
      projectOrigins: list(PROJECT_ORIGIN_LABELS),
      documentCategories: list(DOCUMENT_CATEGORY_LABELS),
      feedbackCategories: list(FEEDBACK_CATEGORY_LABELS),
      derived: {
        overdue: {
          ar: 'متأخرة',
          en: 'Overdue',
          rule: 'open task or stage whose due date has passed',
        },
        dueSoon: {
          ar: 'تقترب من الموعد',
          en: 'Due soon',
          rule: 'open task due within 24 hours',
        },
      },
    };
  }
}
