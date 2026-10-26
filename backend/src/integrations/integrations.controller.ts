import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { IntegrationsConfigService } from './integrations-config.service';
import { IntegrationsStatusDto } from './integrations-status.dto';

@Controller('integrations')
@ApiTags('Integrations')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard)
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsConfigService) {}

  @Get('status')
  @ApiOperation({
    summary: 'Which integrations are enabled (no secrets)',
    description:
      'Lets the frontend show or hide meeting video, AI and email features. ' +
      'Never returns URLs, keys, secrets or sender addresses.',
  })
  @ApiOkResponse({ type: IntegrationsStatusDto })
  status(): IntegrationsStatusDto {
    return this.integrations.summary();
  }
}
