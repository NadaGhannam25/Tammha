import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TeamRole, UserRole } from '@prisma/client';

export class PublicUserDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ nullable: true, type: String }) firstName!: string | null;
  @ApiProperty({ nullable: true, type: String }) lastName!: string | null;
  @ApiProperty({ nullable: true, type: String }) avatar!: string | null;
  @ApiProperty({ enum: UserRole }) role!: UserRole;
  @ApiProperty({ nullable: true, type: String }) universityId!: string | null;
}

export class TeamMemberViewDto {
  @ApiProperty() userId!: string;
  @ApiProperty({
    enum: TeamRole,
    description: 'Display label only — grants no extra permissions',
  })
  teamRole!: TeamRole;
  @ApiProperty() joinedAt!: Date;
  @ApiProperty({ type: PublicUserDto }) user!: PublicUserDto;
}

export class InvitationViewDto {
  @ApiProperty({ example: 'K7QXM2PA' }) code!: string;
  @ApiProperty({ example: 'http://localhost:5173/join.html?code=K7QXM2PA' })
  link!: string;
  @ApiProperty({ nullable: true, type: Date }) updatedAt!: Date | null;
}

export class TeamViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty({ nullable: true, type: String }) avatar!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({ nullable: true, type: String }) projectId!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'University shared by all students of the team',
  })
  universityId!: string | null;
  @ApiProperty() memberCount!: number;
  @ApiProperty({ type: [TeamMemberViewDto] }) members!: TeamMemberViewDto[];
}

export class InvitationPreviewDto {
  @ApiProperty() code!: string;
  @ApiProperty() teamId!: string;
  @ApiProperty() teamName!: string;
  @ApiProperty() projectId!: string;
  @ApiProperty() projectName!: string;
  @ApiProperty() memberCount!: number;
  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description: 'null = no limit',
  })
  maxMembers!: number | null;
}

export class JoinTeamResultDto {
  @ApiProperty({ example: 'Joined team successfully' }) message!: string;
  @ApiProperty() teamId!: string;
  @ApiProperty() projectId!: string;
}

export class MessageDto {
  @ApiProperty() message!: string;
}
