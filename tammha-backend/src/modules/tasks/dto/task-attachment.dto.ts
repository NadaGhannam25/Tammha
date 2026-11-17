import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Trim } from '@common/utils/trim.transform';

export class AddTaskAttachmentDto {
  @ApiProperty({
    description:
      "A file of the task's project (GET /documents?projectId=…). The file stays in the project files; the " +
      'task only links to it, so no storage is used twice.',
    example: 'clvt7doc0001',
  })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  documentId!: string;
}

export class TaskAttachmentViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() taskId!: string;
  @ApiProperty({
    description: 'Open it with GET /documents/:documentId (signed URL)',
  })
  documentId!: string;
  @ApiProperty({ example: 'Project plan' }) title!: string;
  @ApiProperty({ example: 'plan.pdf' }) fileName!: string;
  @ApiProperty({ example: 182044 }) fileSize!: number;
  @ApiProperty({ type: Date }) createdAt!: Date;
}
