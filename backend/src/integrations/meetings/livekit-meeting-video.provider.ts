import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { AccessToken } from 'livekit-server-sdk';
import { LiveKitConfig } from '../integrations.config';
import {
  MeetingJoinCredentials,
  MeetingJoinRequest,
  MeetingVideoProvider,
} from './meeting-video.provider';

type EnabledLiveKitConfig = Extract<LiveKitConfig, { enabled: true }>;

/**
 * LiveKit adapter (P12). Issues room-scoped access tokens signed LOCALLY with
 * LIVEKIT_API_SECRET (HS256 JWT) — no request is sent to LiveKit to create a token.
 * The secret never leaves this class: responses contain only the server URL, the
 * short-lived token and its expiry. Rooms are created by LiveKit on first join.
 */
export class LiveKitMeetingVideoProvider implements MeetingVideoProvider {
  readonly name = 'livekit' as const;
  private readonly logger = new Logger('LiveKit');

  constructor(private readonly config: EnabledLiveKitConfig) {}

  isEnabled() {
    return true;
  }

  async createJoinCredentials(
    request: MeetingJoinRequest,
  ): Promise<MeetingJoinCredentials> {
    const ttl = Math.max(
      60,
      Math.floor(request.ttlSeconds ?? this.config.tokenTtlSeconds),
    );
    try {
      const token = new AccessToken(this.config.apiKey, this.config.apiSecret, {
        identity: request.identity,
        name: request.displayName,
        ttl,
        metadata: request.metadata,
      });
      token.addGrant({
        roomJoin: true,
        room: request.roomName,
        canPublish: request.canPublish,
        canPublishData: request.canPublish,
        canSubscribe: true,
        // participants cannot create, list or administer other rooms
        roomCreate: false,
        roomList: false,
        roomAdmin: false,
      });
      return {
        serverUrl: toWebSocketUrl(this.config.url),
        token: await token.toJwt(),
        expiresAt: new Date(Date.now() + ttl * 1000),
      };
    } catch (error) {
      // never log the token, key or secret
      this.logger.error(`token signing failed: ${(error as Error).name}`);
      throw new ServiceUnavailableException({
        code: 'MEETING_TOKEN_UNAVAILABLE',
        message: 'Could not create meeting access right now',
      });
    }
  }
}

/** Browsers connect over WebSocket: https://x -> wss://x, http://localhost -> ws://localhost */
export function toWebSocketUrl(url: string): string {
  return url.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
}
