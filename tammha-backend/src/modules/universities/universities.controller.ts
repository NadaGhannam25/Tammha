import { Controller, Get } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { PrismaService } from '@/prisma/prisma.service';
import { catalogFor, isCustomUniversityCode } from './saudi-universities';

export class UniversityOptionDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Almaarefa University' }) name!: string;
  @ApiProperty({ example: 'Almaarefa University' }) nameEn!: string;
  @ApiProperty({ example: 'جامعة المعرفة' }) nameAr!: string;
  @ApiProperty({ example: 'UM' }) code!: string;
  @ApiPropertyOptional({ enum: ['PUBLIC', 'PRIVATE'], nullable: true })
  type!: 'PUBLIC' | 'PRIVATE' | null;
  @ApiProperty({
    description:
      'true = typed by a user at registration ("Other"); not offered in the registration list',
  })
  isCustom!: boolean;
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
 * Listed Saudi universities are added at start-up (UniversitiesCatalogSeeder); a university
 * that is not listed is typed at registration (universityName) and marked isCustom.
 */
@Controller('universities')
@ApiTags('Universities')
export class UniversitiesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'List active universities (public)' })
  @ApiOkResponse({ type: [UniversityOptionDto] })
  async list(): Promise<UniversityOptionDto[]> {
    const rows = await this.prisma.university.findMany({
      where: { isActive: true },
      select: { id: true, name: true, code: true, emailDomains: true },
      orderBy: { name: 'asc' },
    });
    return rows.map((row) => {
      const listed = catalogFor(row);
      return {
        ...row,
        nameEn: listed?.en ?? row.name,
        nameAr: listed?.ar ?? row.name,
        type: listed?.type ?? null,
        isCustom: isCustomUniversityCode(row.code),
      };
    });
  }
}
