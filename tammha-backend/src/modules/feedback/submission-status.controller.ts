import { Body, Controller, Param, Patch, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '@modules/auth/guards/roles.guard';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { AuthUser } from '@common/types/auth-user.type';
import { FeedbackService } from './feedback.service';
import { UpdateSubmissionStatusDto } from './dto/feedback.dto';
import { FeedbackViewDto } from './dto/feedback-response.dto';

/** PATCH /documents/:id/submission-status — kept next to the feedback logic it records. */
@Controller('documents')
@ApiTags('Documents')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles([UserRole.SUPERVISOR])
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
@ApiResponse({
  status: 403,
  description: 'Not a supervisor, or PROJECT_ACCESS_DENIED',
})
export class SubmissionStatusController {
  constructor(private readonly feedbackService: FeedbackService) {}

  @Patch(':id/submission-status')
  @ApiOperation({
    summary:
      'Set the submission status of a document (supervisor of the project)',
    description:
      'UNDER_REVIEW, CHANGES_REQUESTED, APPROVED or REJECTED, with an optional comment. ' +
      'Recorded as a feedback item (review history); students are notified. ' +
      'A new document version resets the status to SUBMITTED.',
  })
  @ApiOkResponse({
    type: FeedbackViewDto,
    description: 'The feedback item that records the decision',
  })
  @ApiResponse({
    status: 400,
    description: 'Validation error (SUBMITTED cannot be set by supervisors)',
  })
  @ApiResponse({ status: 404, description: 'DOCUMENT_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'SUBMISSION_STATUS_UNCHANGED' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateSubmissionStatusDto,
  ) {
    return this.feedbackService.updateSubmissionStatus(user, id, dto);
  }
}
