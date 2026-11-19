import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { AuthUser } from '@common/types/auth-user.type';
import { HandbookFileUrlDto } from '../dto/handbook.dto';
import { HandbookLibraryService } from './handbook-library.service';
import { UniversityHandbookOptionDto } from './library.dto';

/**
 * Official university handbooks for the handbook page: the four handbook universities with
 * the real file name of each official handbook (or null = not available yet).
 */
@Controller('handbooks/universities')
@ApiTags('University Handbooks')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard)
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
export class UniversityHandbooksController {
  constructor(private readonly library: HandbookLibraryService) {}

  @Get()
  @ApiOperation({
    summary: 'The four handbook universities and their official handbook',
    description:
      'Any signed-in user. Always exactly four, in this order: almaarefa, najran, pnu, tabuk (other universities ' +
      'are never offered). isMyUniversity marks your registered university. handbook = null means the official ' +
      'PDF is not available yet (the UI shows "الدليل غير متاح حاليًا"); universityId = null means that university ' +
      'has not been set up on the server yet. Choosing one never changes your registered university.',
  })
  @ApiOkResponse({ type: [UniversityHandbookOptionDto] })
  list(@CurrentUser() user: AuthUser) {
    return this.library.listHandbookOptions(user);
  }

  @Get(':universityKey/file')
  @ApiOperation({
    summary: "Signed URL of a handbook university's official PDF (short-lived)",
  })
  @ApiOkResponse({ type: HandbookFileUrlDto })
  @ApiResponse({
    status: 404,
    description:
      'UNIVERSITY_NOT_IN_HANDBOOK_LIST or UNIVERSITY_HANDBOOK_NOT_AVAILABLE',
  })
  file(@Param('universityKey') universityKey: string) {
    return this.library.officialFileUrl(universityKey);
  }
}
