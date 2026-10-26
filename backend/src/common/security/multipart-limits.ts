/**
 * P14 — limits for the non-file parts of multipart uploads (busboy/multer).
 * The file size is set per endpoint. Without these, a request could send thousands
 * of fields or a huge text field that multer buffers in memory.
 */
export const MULTIPART_FIELD_LIMITS = {
  fields: 20,
  fieldNameSize: 100,
  fieldSize: 64 * 1024,
  parts: 25,
  headerPairs: 100,
} as const;
