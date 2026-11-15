import { ApiProperty } from '@nestjs/swagger';

export const STORAGE_STATUSES = [
  'NORMAL',
  'WARNING',
  'CRITICAL',
  'FULL',
  'NOT_LIMITED',
] as const;
export type StorageStatus = (typeof STORAGE_STATUSES)[number];

export class StorageProjectUsageDto {
  @ApiProperty() projectId!: string;
  @ApiProperty({ nullable: true, type: String }) projectName!: string | null;
  @ApiProperty({ description: 'bytes uploaded by you in this project' })
  usedBytes!: number;
}

export class StorageBreakdownDto {
  @ApiProperty({ description: 'document files and all their versions (bytes)' })
  documentBytes!: number;
  @ApiProperty({ description: 'project handbook PDFs you uploaded (bytes)' })
  handbookBytes!: number;
  @ApiProperty({ description: 'stored objects counted' })
  files!: number;
  @ApiProperty({
    description:
      'older document versions whose size is not known yet (uploaded before quotas; counted as 0 until reconciled)',
  })
  filesWithUnknownSize!: number;
}

export class StorageUsageDto {
  @ApiProperty({
    description: 'false for SUPERVISOR / ADMIN accounts (no student quota)',
  })
  quotaApplies!: boolean;
  @ApiProperty({
    example: 7730941133,
    description: 'bytes used, across ALL your projects',
  })
  usedBytes!: number;
  @ApiProperty({
    nullable: true,
    type: Number,
    example: 10737418240,
    description:
      'STUDENT_STORAGE_QUOTA_GB × 1024³ (null when quotaApplies is false)',
  })
  quotaBytes!: number | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'max(quota − used, 0)',
  })
  remainingBytes!: number | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    example: 72,
    description: 'used / quota × 100, one decimal, capped at 100',
  })
  percentageUsed!: number | null;
  @ApiProperty({
    enum: STORAGE_STATUSES,
    description:
      'NORMAL < 80% ≤ WARNING < 95% ≤ CRITICAL < 100% ≤ FULL (uploads that add data are refused). ' +
      'NOT_LIMITED for accounts without a quota.',
  })
  status!: StorageStatus;
  @ApiProperty({
    example: { warningAt: 0.8, criticalAt: 0.95 },
    description: 'thresholds used for status (fractions of the quota)',
  })
  thresholds!: { warningAt: number; criticalAt: number };
  @ApiProperty({ type: StorageBreakdownDto }) breakdown!: StorageBreakdownDto;
  @ApiProperty({
    type: [StorageProjectUsageDto],
    description: 'your usage per project',
  })
  projects!: StorageProjectUsageDto[];
}
