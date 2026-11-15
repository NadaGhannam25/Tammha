import { Controller, Get } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { PrismaService } from '@/prisma/prisma.service';

export class UniversityOptionDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Almaarefa University' }) name!: string;
  @ApiProperty({ example: 'UM' }) code!: string;
  @ApiProperty({
    type: [String],
    example: ['um.edu.sa'],
    description:
      'University e-mail domains (subdomains match). Empty = not configured: any university e-mail is accepted (after verification).',
  })
  emailDomains!: string[];
}

/**
 * Public, read-only list used by the registration form to pick a universityId.
 * Universities are created by the operator with `npm run university:create`.
 */
@Controller('universities')
@ApiTags('Universities')
export class UniversitiesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'List active universities (public)' })
  @ApiOkResponse({ type: [UniversityOptionDto] })
  list(): Promise<UniversityOptionDto[]> {
    return this.prisma.university.findMany({
      where: { isActive: true },
      select: { id: true, name: true, code: true, emailDomains: true },
      orderBy: { name: 'asc' },
    });
  }
}
