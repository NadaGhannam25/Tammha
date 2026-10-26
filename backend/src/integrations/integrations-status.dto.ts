import { ApiProperty } from '@nestjs/swagger';

const STATE_DOC =
  'DISABLED = switched off; CONFIGURED = enabled and its variables are valid';

export class LiveKitStatusDto {
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ enum: ['DISABLED', 'CONFIGURED'], description: STATE_DOC })
  state!: string;
  @ApiProperty({ enum: ['livekit'], nullable: true, type: String })
  provider!: 'livekit' | null;
}

export class AiStatusDto {
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ enum: ['DISABLED', 'CONFIGURED'], description: STATE_DOC })
  state!: string;
  @ApiProperty({ enum: ['gemini'], nullable: true, type: String })
  provider!: 'gemini' | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Model ID (not a secret)',
  })
  model!: string | null;
}

export class EmailStatusDto {
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ enum: ['DISABLED', 'CONFIGURED'], description: STATE_DOC })
  state!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Always null: no e-mail provider in this backend (in-app notifications only)',
  })
  provider!: null;
}

export class IntegrationsStatusDto {
  @ApiProperty({ type: LiveKitStatusDto }) livekit!: LiveKitStatusDto;
  @ApiProperty({ type: AiStatusDto }) ai!: AiStatusDto;
  @ApiProperty({ type: EmailStatusDto }) email!: EmailStatusDto;
}
