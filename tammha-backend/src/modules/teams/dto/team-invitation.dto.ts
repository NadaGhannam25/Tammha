import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { TeamInvitationStatus } from '@prisma/client';
import { Trim } from '@common/utils/trim.transform';
import { NormalizeEmail } from '@common/utils/normalize-email.transform';
import {
  NormalizeStudentNumber,
  STUDENT_NUMBER_PATTERN,
} from '@common/utils/student-number';

/** Exactly one of studentNumber / universityEmail (400 STUDENT_IDENTIFIER_REQUIRED). */
export class CreateTeamInvitationDto {
  @ApiPropertyOptional({
    example: '2026001234',
    description: 'Student number of a classmate (same university)',
  })
  @IsOptional()
  @NormalizeStudentNumber()
  @IsString()
  @Matches(STUDENT_NUMBER_PATTERN, {
    message: 'studentNumber must be 3-20 letters, digits or dashes',
  })
  studentNumber?: string;

  @ApiPropertyOptional({
    example: 'n.alharbi@um.edu.sa',
    description: 'Verified university e-mail of a classmate (same university)',
  })
  @IsOptional()
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  universityEmail?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  message?: string;
}

export class TeamInvitationQueryDto {
  @ApiPropertyOptional({ enum: TeamInvitationStatus })
  @IsOptional()
  @IsEnum(TeamInvitationStatus)
  status?: TeamInvitationStatus;
}

class InvitationPartyDto {
  @ApiProperty({ example: 'Nada A.' }) displayName!: string;
  @ApiProperty({ nullable: true, type: String, example: '2026001234' })
  studentNumber!: string | null;
}

class InvitationTeamDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) projectId!: string | null;
  @ApiProperty({ nullable: true, type: String }) projectName!: string | null;
}

export class TeamInvitationViewDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: TeamInvitationStatus }) status!: TeamInvitationStatus;
  @ApiProperty({ nullable: true, type: String }) message!: string | null;
  @ApiProperty({ type: InvitationTeamDto }) team!: InvitationTeamDto;
  @ApiProperty({ type: InvitationPartyDto }) invitee!: InvitationPartyDto;
  @ApiProperty({ type: InvitationPartyDto }) invitedBy!: InvitationPartyDto;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ nullable: true, type: Date }) respondedAt!: Date | null;
}
