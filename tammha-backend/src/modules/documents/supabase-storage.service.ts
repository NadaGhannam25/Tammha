import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  WorkspaceErrorCode as E,
  workspaceError,
} from '@common/workspace/workspace-errors';
import { SIGNED_URL_TTL_SECONDS } from './document-files';

/**
 * The only bucket the API uses. PRIVATE: files are reachable only through
 * short-lived signed URLs. Never taken from client input.
 */
export const DOCUMENTS_BUCKET = 'project-documents';

/**
 * Upper bound for one Storage request (upload of up to 25 MB, delete, signing).
 * Without it a stalled connection would keep the API request open for minutes;
 * an aborted request becomes the usual 503 STORAGE_ERROR (and a failed deletion
 * is retried through storage_pending_deletions).
 */
export const STORAGE_REQUEST_TIMEOUT_MS = 120_000;

/** `fetch` that aborts after `timeoutMs`, keeping any caller-provided signal. */
export function fetchWithTimeout(
  timeoutMs: number,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  return (input, init = {}) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeout])
      : timeout;
    return baseFetch(input, { ...init, signal });
  };
}

/**
 * Server-side access to Supabase Storage with the SECRET key (SUPABASE_SECRET_KEY).
 * The key never leaves this class: it is not logged and never part of a response.
 * Supabase error details are logged server-side; clients get a generic message.
 */
@Injectable()
export class SupabaseStorageService {
  private readonly logger = new Logger(SupabaseStorageService.name);
  private readonly client: SupabaseClient;

  constructor(configService: ConfigService) {
    // Presence and format are validated at startup by validateEnv (src/config/env.validation.ts).
    this.client = createClient(
      configService.getOrThrow<string>('SUPABASE_URL'),
      configService.getOrThrow<string>('SUPABASE_SECRET_KEY'),
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        global: { fetch: fetchWithTimeout(STORAGE_REQUEST_TIMEOUT_MS) },
      },
    );
  }

  private get bucket() {
    return this.client.storage.from(DOCUMENTS_BUCKET);
  }

  /** Uploads a new object. Never overwrites (upsert: false). */
  async upload(
    storagePath: string,
    file: Buffer,
    contentType: string,
  ): Promise<void> {
    const { error } = await this.bucket.upload(storagePath, file, {
      contentType,
      upsert: false,
    });
    if (error) throw this.failure('upload', error);
  }

  /** Removes the given objects in one request. */
  async remove(storagePaths: string[]): Promise<void> {
    if (storagePaths.length === 0) return;
    const { error } = await this.bucket.remove(storagePaths);
    if (error) throw this.failure('delete', error);
  }

  /** One signed URL (valid SIGNED_URL_TTL_SECONDS). */
  async createSignedUrl(storagePath: string): Promise<string> {
    const { data, error } = await this.bucket.createSignedUrl(
      storagePath,
      SIGNED_URL_TTL_SECONDS,
    );
    if (error || !data?.signedUrl) throw this.failure('sign', error);
    return data.signedUrl;
  }

  /** Signed URLs for many paths in ONE request, returned in the same order. */
  async createSignedUrls(storagePaths: string[]): Promise<string[]> {
    if (storagePaths.length === 0) return [];
    const { data, error } = await this.bucket.createSignedUrls(
      storagePaths,
      SIGNED_URL_TTL_SECONDS,
    );
    if (error || !data) throw this.failure('sign', error);
    const byPath = new Map(data.map((d) => [d.path, d]));
    return storagePaths.map((path) => {
      const entry = byPath.get(path);
      if (!entry?.signedUrl || entry.error) {
        throw this.failure(
          'sign',
          entry?.error ? { message: entry.error } : null,
        );
      }
      return entry.signedUrl;
    });
  }

  private failure(
    operation: 'upload' | 'delete' | 'sign',
    error: { message?: string } | null,
  ) {
    // Only the operation and Supabase's message are logged (no key, no file contents).
    this.logger.error(
      `Storage ${operation} failed: ${error?.message ?? 'unknown error'}`,
    );
    return new ServiceUnavailableException(
      workspaceError(
        E.STORAGE_ERROR,
        `File storage is temporarily unavailable (${operation})`,
      ),
    );
  }
}
