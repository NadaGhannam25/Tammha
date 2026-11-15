import { ApiProperty } from '@nestjs/swagger';
import { SupervisionRequestStatus } from '@prisma/client';
import { PublicUserDto } from '@modules/teams/dto/team-response.dto';

export class SupervisionProjectRefDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() teamId!: string;
}

export class SupervisionRequestViewDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: SupervisionRequestStatus })
  status!: SupervisionRequestStatus;
  @ApiProperty({ nullable: true, type: String }) message!: string | null;
  @ApiProperty({ nullable: true, type: String }) responseNote!: string | null;
  @ApiProperty({ nullable: true, type: Date }) respondedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ type: SupervisionProjectRefDto })
  project!: SupervisionProjectRefDto;
  @ApiProperty({ type: PublicUserDto }) supervisor!: PublicUserDto;
  @ApiProperty({ type: PublicUserDto }) requestedBy!: PublicUserDto;
}
