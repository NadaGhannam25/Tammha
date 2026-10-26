import { randomUUID } from 'crypto';

/**
 * Port for embedded video meetings (LiveKit since P12).
 * The meetings feature depends on this interface only, never on a provider SDK.
 */
export const MEETING_VIDEO_PROVIDER = Symbol('MEETING_VIDEO_PROVIDER');

export interface MeetingJoinRequest {
  /** Stable room name, one per Tammha meeting (see roomNameForMeeting) */
  roomName: string;
  /** Tammha user id — becomes the participant identity */
  identity: string;
  displayName: string;
  /** Students and supervisors publish audio/video; observers could be view-only */
  canPublish: boolean;
  /** Overrides LIVEKIT_TOKEN_TTL_SECONDS */
  ttlSeconds?: number;
  /** Non-sensitive JSON visible to other participants (ids and role only) */
  metadata?: string;
}

export interface MeetingJoinCredentials {
  /** WebSocket URL the browser connects to (LIVEKIT_URL) */
  serverUrl: string;
  /** Short-lived access token for this participant and room only */
  token: string;
  expiresAt: Date;
}

export interface MeetingVideoProvider {
  readonly name: 'livekit' | 'disabled';
  isEnabled(): boolean;
  /** Issues join credentials. Never returns the API secret. */
  createJoinCredentials(
    request: MeetingJoinRequest,
  ): Promise<MeetingJoinCredentials>;
}

/** P12: a new random room name per meeting (unguessable, no titles or personal data). */
export function newMeetingRoomName(): string {
  return `tammha-${randomUUID()}`;
}

/** Room names are derived from ids only (no titles or personal data). */
export function roomNameForMeeting(meetingId: string): string {
  return `tammha-meeting-${meetingId}`;
}
