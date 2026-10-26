/**
 * TEST-ONLY stand-in for SupabaseStorageService (same public methods).
 * Keeps objects in memory, records every call, and can be told to fail, so tests
 * never contact Supabase. Excluded from the production build (src/testing).
 */
import { ServiceUnavailableException } from '@nestjs/common';
import type { SupabaseStorageService } from '@modules/documents/supabase-storage.service';

type Operation = 'upload' | 'remove' | 'sign';

export interface StoredObject {
  size: number;
  contentType: string;
  body: Buffer;
}

export class FakeStorageService implements Pick<
  SupabaseStorageService,
  'upload' | 'remove' | 'createSignedUrl' | 'createSignedUrls'
> {
  readonly objects = new Map<string, StoredObject>();
  readonly calls: { op: Operation; paths: string[] }[] = [];
  private readonly failures = new Map<Operation, number>();

  /** Make the next `times` calls of an operation fail like a Storage outage. */
  failNext(op: Operation, times = 1) {
    this.failures.set(op, (this.failures.get(op) ?? 0) + times);
  }

  reset() {
    this.objects.clear();
    this.calls.length = 0;
    this.failures.clear();
  }

  pathsOf(op: Operation): string[] {
    return this.calls.filter((c) => c.op === op).flatMap((c) => c.paths);
  }

  async upload(
    storagePath: string,
    file: Buffer,
    contentType: string,
  ): Promise<void> {
    this.record('upload', [storagePath]);
    if (this.objects.has(storagePath))
      throw new Error(`fake storage: ${storagePath} exists`);
    this.objects.set(storagePath, {
      size: file.length,
      contentType,
      body: file,
    });
  }

  async remove(storagePaths: string[]): Promise<void> {
    this.record('remove', storagePaths);
    storagePaths.forEach((p) => this.objects.delete(p));
  }

  async createSignedUrl(storagePath: string): Promise<string> {
    this.record('sign', [storagePath]);
    return this.signed(storagePath);
  }

  async createSignedUrls(storagePaths: string[]): Promise<string[]> {
    this.record('sign', storagePaths);
    return storagePaths.map((p) => this.signed(p));
  }

  private signed(path: string) {
    return `https://storage.test/object/sign/project-documents/${encodeURI(path)}?token=fake-token`;
  }

  private record(op: Operation, paths: string[]) {
    this.calls.push({ op, paths: [...paths] });
    const pending = this.failures.get(op) ?? 0;
    if (pending > 0) {
      this.failures.set(op, pending - 1);
      throw new ServiceUnavailableException({
        code: 'STORAGE_ERROR',
        message: `File storage is temporarily unavailable (${op})`,
      });
    }
  }
}
