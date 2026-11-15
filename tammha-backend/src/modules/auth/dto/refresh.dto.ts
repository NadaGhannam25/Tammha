import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RefreshTokenDto {
  @ApiProperty({
    description: 'The refresh token received during login/registration',
    example:
      '9f2c1d0e8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  refreshToken!: string;
}
