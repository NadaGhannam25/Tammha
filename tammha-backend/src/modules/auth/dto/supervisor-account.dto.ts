import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { NormalizeEmail } from '@common/utils/normalize-email.transform';
import { Trim } from '@common/utils/trim.transform';

export class CreateSupervisorDto {
  @ApiProperty({
    example: 'n.alharbi@um.edu.sa',
    description:
      "The supervisor's university e-mail (sign-in address). Must match the university's e-mail domains when configured; personal providers are refused.",
  })
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ example: 'Noha' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  firstName!: string;

  @ApiPropertyOptional({ example: 'Alharbi' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(128)
  lastName?: string;

  @ApiProperty({ description: 'ID of an active university' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  universityId!: string;
}

export class SupervisorAccountDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ nullable: true }) firstName!: string | null;
  @ApiProperty({ nullable: true }) lastName!: string | null;
  @ApiProperty() universityId!: string;
  @ApiProperty({
    description: 'false until the supervisor used the activation link',
  })
  activated!: boolean;
  @ApiProperty({ enum: ['ENABLED', 'NOT_CONFIGURED'] })
  emailDelivery!: 'ENABLED' | 'NOT_CONFIGURED';
}
