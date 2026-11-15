import { BadRequestException } from '@nestjs/common';
import {
  assertAllowedFile,
  BLOCKED_EXTENSIONS,
  buildStoragePath,
  documentFolderOf,
  fileNameFromStoragePath,
  isInProjectScope,
  MAX_FILE_SIZE_BYTES,
  repairMultipartFileName,
  sanitizeDisplayFileName,
  storageContentType,
  withDownloadName,
} from '../document-files';

/** Supabase Storage key rule (supabase/storage src/storage/limits.ts isValidKey). */
const SUPABASE_VALID_KEY =
  /^(\w|\/|!|-|\.|\*|'|\(|\)| |&|\$|@|=|;|:|\+|,|\?)*$/;

const file = (originalname: string, size = 10) => ({
  originalname,
  mimetype: 'application/pdf',
  size,
  buffer: Buffer.alloc(size, 1),
});

describe('document-files', () => {
  describe('limits', () => {
    it('max size is exactly 25 MB', () => {
      expect(MAX_FILE_SIZE_BYTES).toBe(26_214_400);
    });

    it('accepts exactly 25 MB and rejects more', () => {
      expect(() =>
        assertAllowedFile(file('a.pdf', MAX_FILE_SIZE_BYTES)),
      ).not.toThrow();
      expect(() =>
        assertAllowedFile(file('a.pdf', MAX_FILE_SIZE_BYTES + 1)),
      ).toThrow(BadRequestException);
    });

    it('rejects missing and empty files', () => {
      expect(() => assertAllowedFile(undefined)).toThrow(BadRequestException);
      expect(() => assertAllowedFile(file('a.pdf', 0))).toThrow(
        BadRequestException,
      );
    });
  });

  describe('file type rule', () => {
    it.each([
      'setup.exe',
      'REPORT.PDF.EXE',
      'x.msi',
      'a.bat',
      'a.cmd',
      'a.vbs',
      'a.jar',
      'a.apk',
      'a.dmg',
      'a.scr',
      'a.lnk',
      'a.dll',
    ])('blocks %s', (name) => {
      expect(() => assertAllowedFile(file(name))).toThrow('not allowed');
    });

    it.each([
      'report.pdf',
      'slides.pptx',
      'thesis.docx',
      'data.xlsx',
      'main.py',
      'app.js',
      'index.ts',
      'run.sh',
      'schema.sql',
      'index.html',
      'archive.zip',
      'README',
      'exe.pdf',
    ])('allows %s', (name) => {
      expect(() => assertAllowedFile(file(name))).not.toThrow();
    });

    it('the blocklist is the documented one', () => {
      expect([...BLOCKED_EXTENSIONS].sort()).toEqual(
        [
          'app',
          'apk',
          'appx',
          'bat',
          'cmd',
          'com',
          'cpl',
          'deb',
          'dll',
          'dmg',
          'drv',
          'exe',
          'hta',
          'jar',
          'jse',
          'lnk',
          'msi',
          'msix',
          'msp',
          'pif',
          'pkg',
          'reg',
          'rpm',
          'scr',
          'sys',
          'vbe',
          'vbs',
          'wsf',
          'wsh',
        ].sort(),
      );
    });

    it('active content is stored as a download', () => {
      expect(storageContentType('text/html')).toBe('application/octet-stream');
      expect(storageContentType('image/svg+xml')).toBe(
        'application/octet-stream',
      );
      expect(storageContentType('TEXT/HTML; charset=utf-8')).toBe(
        'application/octet-stream',
      );
      expect(storageContentType('application/pdf')).toBe('application/pdf');
      expect(storageContentType('')).toBe('application/octet-stream');
    });
  });

  describe('file names', () => {
    it('repairs multer latin1-decoded UTF-8 names (Arabic)', () => {
      const original = 'تقرير المشروع.pdf';
      const mangled = Buffer.from(original, 'utf8').toString('latin1');
      expect(mangled).not.toBe(original);
      expect(repairMultipartFileName(mangled)).toBe(original);
    });

    it('leaves ASCII, real latin1 and already-decoded names alone', () => {
      expect(repairMultipartFileName('report.pdf')).toBe('report.pdf');
      expect(repairMultipartFileName('caf\u00e9.pdf')).toBe('caf\u00e9.pdf'); // not valid UTF-8 bytes
      expect(repairMultipartFileName('تقرير.pdf')).toBe('تقرير.pdf');
    });

    it.each([
      ['../../etc/passwd', 'passwd'],
      ['C:\\Users\\x\\report.pdf', 'report.pdf'],
      ['  تقرير   المشروع .pdf ', 'تقرير المشروع .pdf'],
      ['a\u0000b\u001fc.pdf', 'abc.pdf'],
      ['invoice\u202Efdp.exe', 'invoicefdp.exe'], // right-to-left override removed
      ['..', 'file'],
      ['', 'file'],
      ['   ', 'file'],
    ])('sanitizes %j -> %j', (input, expected) => {
      expect(sanitizeDisplayFileName(input)).toBe(expected);
    });

    it('limits length but keeps the extension', () => {
      const long = `${'ب'.repeat(300)}.pdf`;
      const out = sanitizeDisplayFileName(long);
      expect([...out].length).toBeLessThanOrEqual(120);
      expect(out.endsWith('.pdf')).toBe(true);
    });

    it('normalizes to NFC', () => {
      const decomposed = 'e\u0301.pdf';
      expect(sanitizeDisplayFileName(decomposed)).toBe('\u00e9.pdf');
    });
  });

  describe('storage paths', () => {
    const projectId = 'cm0project123';
    const folder = '0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0';

    it('is project/folder/object, ASCII-only, and round-trips the Arabic name', () => {
      const name = 'تقرير المشروع (نهائي).pdf';
      const path = buildStoragePath(projectId, folder, name);
      const parts = path.split('/');
      expect(parts).toHaveLength(3);
      expect(parts.slice(0, 2)).toEqual([projectId, folder]);
      expect(path).toMatch(SUPABASE_VALID_KEY);
      expect(fileNameFromStoragePath(path)).toBe(name);
      expect(documentFolderOf(path)).toBe(folder);
      expect(isInProjectScope(path, projectId)).toBe(true);
    });

    it('never produces the same path twice', () => {
      const paths = new Set(
        Array.from({ length: 200 }, () =>
          buildStoragePath(projectId, folder, 'same.pdf'),
        ),
      );
      expect(paths.size).toBe(200);
    });

    it('user input cannot change the folder structure', () => {
      for (const name of [
        '../../x',
        'a/b/c',
        '..\\..\\x',
        '/etc/passwd',
        '%2e%2e%2f',
      ]) {
        const path = buildStoragePath(projectId, folder, name);
        expect(path.split('/')).toHaveLength(3);
        expect(path.split('/').pop()).toMatch(
          /^[0-9a-f-]{36}\.[A-Za-z0-9_-]+$/,
        );
      }
    });

    it('rejects unsafe project/folder segments (defence in depth)', () => {
      expect(() => buildStoragePath('../x', folder, 'a')).toThrow('Unsafe');
      expect(() => buildStoragePath(projectId, 'a/b', 'a')).toThrow('Unsafe');
    });

    it('reads first-draft P07 paths', () => {
      expect(
        fileNameFromStoragePath('p/f/v2-1760000000000-final-report.pdf'),
      ).toBe('final-report.pdf');
    });

    it('scope check rejects other projects and malformed paths', () => {
      expect(isInProjectScope(`other/${folder}/x`, projectId)).toBe(false);
      expect(isInProjectScope(`${projectId}/../x`, projectId)).toBe(false);
      expect(isInProjectScope(`${projectId}/x`, projectId)).toBe(false);
      expect(isInProjectScope(`${projectId}/a/b/c`, projectId)).toBe(false);
      expect(isInProjectScope(`${projectId}//x`, projectId)).toBe(false);
    });
  });

  describe('download URLs', () => {
    it('appends a correctly encoded name (no double encoding)', () => {
      const url = withDownloadName(
        'https://x.supabase.co/storage/v1/object/sign/b/p?token=abc',
        'تقرير & خطة.pdf',
      );
      expect(url).toBe(
        `https://x.supabase.co/storage/v1/object/sign/b/p?token=abc&download=${encodeURIComponent('تقرير & خطة.pdf')}`,
      );
      expect(url).not.toContain('%25');
      expect(
        decodeURIComponent(new URL(url).searchParams.get('download')!),
      ).toBe('تقرير & خطة.pdf');
    });
  });
});
