import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  WorkspaceErrorCode as E,
  workspaceError,
} from '@common/workspace/workspace-errors';

/**
 * File rules and storage-path helpers for project documents.
 * Pure functions (no I/O) so every rule is unit-tested in document-files.spec.ts.
 */

/** Maximum upload size: 25 MB (enforced by multer before the file is buffered). */
export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

/** Lifetime of signed URLs returned by the API. */
export const SIGNED_URL_TTL_SECONDS = 60 * 60;

/** Longest display file name kept (characters, extension preserved). */
const MAX_FILE_NAME_LENGTH = 120;

/**
 * Rejected extensions: native executables, installers and Windows script hosts that
 * run on double-click. Source code a graduation project legitimately shares
 * (.js, .ts, .py, .java, .sh, .ps1, .sql, .html, ...) is ALLOWED.
 * Checked on the LAST extension, case-insensitive ("report.pdf.exe" -> exe).
 */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  // Windows executables / installers / libraries
  'exe',
  'msi',
  'msp',
  'msix',
  'appx',
  'com',
  'scr',
  'pif',
  'cpl',
  'dll',
  'sys',
  'drv',
  // Windows script hosts and shortcuts that execute on open
  'bat',
  'cmd',
  'vbs',
  'vbe',
  'wsf',
  'wsh',
  'hta',
  'lnk',
  'reg',
  'jse',
  // macOS / Linux / mobile packages
  'app',
  'dmg',
  'pkg',
  'apk',
  'deb',
  'rpm',
  // Java executable archives
  'jar',
]);

/**
 * Types a browser would execute/render as a page when opened from a signed URL.
 * They are still allowed (e.g. a web project's HTML), but stored in Supabase as
 * application/octet-stream so opening the link downloads instead of rendering.
 */
const ACTIVE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/xml',
  'application/xml',
  'text/javascript',
  'application/javascript',
]);

export interface UploadedDocumentFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * multer 2.x lets busboy decode the multipart `filename="..."` parameter as latin1,
 * so a browser upload of "تقرير.pdf" arrives as "ØªÙ...". Re-decode those bytes as
 * UTF-8 when they form valid UTF-8; otherwise keep the name unchanged.
 */
export function repairMultipartFileName(name: string): string {
  if (!name || [...name].some((ch) => ch.charCodeAt(0) > 0xff)) return name; // already Unicode
  const bytes = Buffer.from(name, 'latin1');
  if (bytes.every((b) => b < 0x80)) return name; // plain ASCII
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return name; // genuinely latin1
  }
}

/**
 * Display name kept for users (Unicode/Arabic preserved): no directory part,
 * no control characters, NFC-normalized, length-limited, never empty.
 */
export function sanitizeDisplayFileName(input: string): string {
  const base = (input ?? '').split(/[\\/]/).pop() ?? '';
  let name = base
    .normalize('NFC')
    // control chars, bidi overrides/isolates (filename spoofing), zero-width chars
    .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩​-‏﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (name === '' || /^\.+$/.test(name)) return 'file';

  const chars = [...name];
  if (chars.length > MAX_FILE_NAME_LENGTH) {
    const ext = getExtension(name);
    const suffix = ext && ext.length <= 10 ? `.${ext}` : '';
    name =
      chars
        .slice(0, MAX_FILE_NAME_LENGTH - suffix.length)
        .join('')
        .trimEnd() + suffix;
  }
  return name;
}

/** Last extension, lower-case, without dot ("" when none). */
export function getExtension(name: string): string {
  const match = /\.([^.\s]+)$/.exec(name);
  return match ? match[1].toLowerCase() : '';
}

/**
 * Validates an uploaded file (size limit itself is enforced by multer).
 * Returns the safe display name.
 */
export function assertAllowedFile(
  file: UploadedDocumentFile | undefined,
): string {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw new BadRequestException(
      workspaceError(
        E.FILE_REQUIRED,
        'A file is required (multipart field "file")',
      ),
    );
  }
  if (file.size === 0 || file.buffer.length === 0) {
    throw new BadRequestException(
      workspaceError(E.FILE_EMPTY, 'The uploaded file is empty'),
    );
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new BadRequestException(
      workspaceError(E.FILE_TOO_LARGE, 'File exceeds the 25 MB limit'),
    );
  }

  const name = sanitizeDisplayFileName(
    repairMultipartFileName(file.originalname),
  );
  const extension = getExtension(name);
  if (BLOCKED_EXTENSIONS.has(extension)) {
    throw new BadRequestException(
      workspaceError(
        E.FILE_TYPE_NOT_ALLOWED,
        `Files of type .${extension} are not allowed (executables and installers are blocked)`,
      ),
    );
  }
  // P14: the extension can be renamed; also check the real content (magic bytes)
  if (isNativeExecutable(file.buffer)) {
    throw new BadRequestException(
      workspaceError(
        E.FILE_TYPE_NOT_ALLOWED,
        'Executable files are not allowed (the file content is a program)',
      ),
    );
  }
  return name;
}

/**
 * P14: native executables detected by content, whatever the extension:
 * Windows PE ("MZ"), Linux ELF, macOS Mach-O (32/64-bit, both byte orders, fat).
 * (0xCAFEBABE is also a Java .class header, which a project would share as source anyway.)
 */
export function isNativeExecutable(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  if (buffer[0] === 0x4d && buffer[1] === 0x5a) return true; // MZ
  const magic = buffer.readUInt32BE(0);
  return [
    0x7f454c46, // \x7fELF
    0xfeedface,
    0xfeedfacf,
    0xcefaedfe,
    0xcffaedfe,
    0xcafebabe,
  ].includes(magic);
}

/** P14: content that a browser could render as a page, whatever type the client declared. */
export function looksLikeActiveContent(buffer: Buffer | undefined): boolean {
  if (!buffer || buffer.length === 0) return false;
  const head = buffer
    .subarray(0, 512)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();
  return /^(<!doctype html|<html|<head|<body|<script|<svg|<\?xml|<iframe|<object|<embed)/.test(
    head,
  );
}

/**
 * Content type sent to Storage: active content is neutralised (see ACTIVE_CONTENT_TYPES).
 * P14: also when the bytes are HTML/SVG/XML but the client declared another type.
 */
export function storageContentType(mimetype: string, buffer?: Buffer): string {
  const type = (mimetype || '').split(';')[0].trim().toLowerCase();
  if (!type || ACTIVE_CONTENT_TYPES.has(type) || looksLikeActiveContent(buffer))
    return 'application/octet-stream';
  return type;
}

/**
 * Object key: <projectId>/<documentFolder>/<uuid>.<base64url(display name)>
 *
 * Supabase Storage only accepts ASCII keys, so the display name (which may be
 * Arabic) is base64url-encoded: only [A-Za-z0-9_-] in the last segment. User input
 * can therefore never add "/", ".." or change the folder. Each upload gets a new
 * UUID, so two uploads can never collide (uploads also use upsert: false).
 */
export function buildStoragePath(
  projectId: string,
  documentFolder: string,
  displayName: string,
): string {
  assertSafeSegment(projectId);
  assertSafeSegment(documentFolder);
  const encoded = Buffer.from(displayName, 'utf8').toString('base64url');
  return `${projectId}/${documentFolder}/${randomUUID()}.${encoded}`;
}

const NEW_FORMAT = /^[0-9a-f-]{36}\.([A-Za-z0-9_-]+)$/;
const LEGACY_FORMAT = /^v\d+-\d+-(.+)$/; // first P07 draft: v<version>-<ms>-<sanitized name>

/** Recovers the display name from a storage path (also handles first-draft P07 paths). */
export function fileNameFromStoragePath(storagePath: string): string {
  const last = storagePath.split('/').pop() ?? '';
  const encoded = NEW_FORMAT.exec(last);
  if (encoded) {
    const decoded = Buffer.from(encoded[1], 'base64url').toString('utf8');
    if (decoded && !decoded.includes('�')) return decoded;
  }
  const legacy = LEGACY_FORMAT.exec(last);
  return legacy ? legacy[1] : last || 'file';
}

/** Folder segment of a document's storage path (shared by all its versions). */
export function documentFolderOf(storagePath: string): string | null {
  const parts = storagePath.split('/');
  return parts.length === 3 && parts[1] ? parts[1] : null;
}

/** True only for paths inside the given project's folder (guards every delete). */
export function isInProjectScope(
  storagePath: string,
  projectId: string,
): boolean {
  const parts = storagePath.split('/');
  return (
    parts.length === 3 &&
    parts[0] === projectId &&
    parts.every((p) => p.length > 0 && p !== '.' && p !== '..')
  );
}

/**
 * Adds a download file name to a signed URL. The `download` query parameter is not
 * part of the signature. Built here with encodeURIComponent because
 * storage-js double-encodes non-ASCII names passed through its `download` option.
 */
export function withDownloadName(signedUrl: string, fileName: string): string {
  const separator = signedUrl.includes('?') ? '&' : '?';
  return `${signedUrl}${separator}download=${encodeURIComponent(fileName)}`;
}

function assertSafeSegment(segment: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new Error(`Unsafe storage path segment: ${JSON.stringify(segment)}`);
  }
}
