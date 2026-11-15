import { ApiProperty } from '@nestjs/swagger';
import { FeedbackCategory, SubmissionStatus } from '@prisma/client';
import { PageMetaDto } from '@common/dtos/pagination.dto';
import { PublicUserDto } from '@modules/teams/dto/team-response.dto';

export class FeedbackDocumentRefDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
}

export class FeedbackTaskRefDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
}

export class FeedbackViewDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true, type: String }) projectId!: string | null;
  @ApiProperty({ nullable: true, type: String }) documentId!: string | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Document version that was reviewed',
  })
  documentVersion!: number | null;
  @ApiProperty({ nullable: true, type: FeedbackDocumentRefDto })
  document!: FeedbackDocumentRefDto | null;
  @ApiProperty({ nullable: true, type: String }) taskId!: string | null;
  @ApiProperty({ nullable: true, type: FeedbackTaskRefDto })
  task!: FeedbackTaskRefDto | null;
  @ApiProperty() supervisorId!: string;
  @ApiProperty({ type: PublicUserDto }) supervisor!: PublicUserDto;
  @ApiProperty({ nullable: true, type: String }) comment!: string | null;
  @ApiProperty({ enum: FeedbackCategory }) category!: FeedbackCategory;
  @ApiProperty({
    enum: SubmissionStatus,
    nullable: true,
    description: 'Decision recorded with this feedback',
  })
  status!: SubmissionStatus | null;
  @ApiProperty({ description: 'true when edited after creation' })
  edited!: boolean;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class FeedbackPageDto {
  @ApiProperty({ type: [FeedbackViewDto] }) items!: FeedbackViewDto[];
  @ApiProperty({ type: PageMetaDto }) meta!: PageMetaDto;
}
