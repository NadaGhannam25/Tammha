import { ApiProperty } from '@nestjs/swagger';
import { Priority, TaskSource, TaskStatus } from '@prisma/client';
import { PageMetaDto } from '@common/dtos/pagination.dto';
import { PublicUserDto } from '@modules/teams/dto/team-response.dto';

export class TaskMilestoneRefDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
}

export class TaskViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty() projectId!: string;
  @ApiProperty({ enum: TaskStatus }) status!: TaskStatus;
  @ApiProperty({ enum: Priority }) priority!: Priority;
  @ApiProperty({ nullable: true, type: Date }) dueDate!: Date | null;
  @ApiProperty({
    nullable: true,
    type: Date,
    description: 'Set by the server when status becomes COMPLETED',
  })
  completedAt!: Date | null;
  @ApiProperty({
    description: 'dueDate passed and task not COMPLETED/CANCELLED',
  })
  isOverdue!: boolean;
  @ApiProperty({ nullable: true, type: String }) assignedStudentId!:
    string | null;
  @ApiProperty({ nullable: true, type: PublicUserDto })
  assignedStudent!: PublicUserDto | null;
  @ApiProperty({ nullable: true, type: TaskMilestoneRefDto })
  milestone!: TaskMilestoneRefDto | null;
  @ApiProperty({ type: PublicUserDto }) createdBy!: PublicUserDto;
  @ApiProperty({
    enum: TaskSource,
    description:
      'MANUAL, or AI_SUGGESTION when created from an approved AI suggestion',
  })
  source!: TaskSource;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Estimated effort in days',
  })
  estimatedDays!: number | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class TaskPageDto {
  @ApiProperty({ type: [TaskViewDto] }) items!: TaskViewDto[];
  @ApiProperty({ type: PageMetaDto }) meta!: PageMetaDto;
}
