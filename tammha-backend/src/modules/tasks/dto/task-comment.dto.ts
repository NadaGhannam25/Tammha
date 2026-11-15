import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { PageMetaDto } from '@common/dtos/pagination.dto';
import { PublicUserDto } from '@modules/teams/dto/team-response.dto';

export class TaskCommentInputDto {
  @ApiProperty({ maxLength: 2000, example: 'I uploaded the survey draft.' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  content!: string;
}

export class TaskCommentViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() taskId!: string;
  @ApiProperty() projectId!: string;
  @ApiProperty() content!: string;
  @ApiProperty({ type: PublicUserDto }) author!: PublicUserDto;
  @ApiProperty({ description: 'true when edited after it was written' })
  edited!: boolean;
  @ApiProperty({ description: 'The viewer wrote it (may edit / delete)' })
  isMine!: boolean;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class TaskCommentPageDto {
  @ApiProperty({ type: [TaskCommentViewDto] }) items!: TaskCommentViewDto[];
  @ApiProperty({ type: PageMetaDto }) meta!: PageMetaDto;
}
