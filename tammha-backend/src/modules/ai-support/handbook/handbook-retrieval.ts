import { PAGE_SEPARATOR } from './handbook-text';

/**
 * Relevant-excerpt selection (P13): instead of sending the whole handbook, it is split
 * into page-tagged chunks, every chunk is scored against the request (question,
 * project context and kind-specific keywords) with a BM25-style score, and only the
 * best chunks that fit the character budget are sent.
 * Works for English and Arabic (Unicode letters, Arabic normalisation, small stopword lists).
 */
export interface HandbookChunk {
  index: number;
  page: number;
  heading: string | null;
  text: string;
}

export interface HandbookExcerpt extends HandbookChunk {
  /** Label shown to the model, e.g. "H2" */
  id: string;
  score: number;
}

const CHUNK_TARGET_CHARS = 900;
const CHUNK_MAX_CHARS = 1400;

const STOPWORDS = new Set(
  (
    'a an and are as at be by can do does for from has have how i in is it its may must of on or our ' +
    'should that the their them there these this to was we what when where which who will with you your ' +
    'في من على إلى الى عن مع هذا هذه ذلك التي الذي التى ان أن إن او أو ما ماذا كيف هل لا كل بعد قبل عند ' +
    'كان يكون تكون هو هي هم نحن انا أنا'
  ).split(/\s+/),
);

/** Lowercase, strip Arabic diacritics/tatweel and unify common letter forms. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/[ىئ]/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ة/g, 'ه');
}

export function tokenize(text: string): string[] {
  return (normalize(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t),
  );
}

/** Splits stored handbook text (pages separated by \f) into page-tagged chunks. */
export function chunkHandbook(extractedText: string): HandbookChunk[] {
  const chunks: HandbookChunk[] = [];
  let heading: string | null = null;

  extractedText.split(PAGE_SEPARATOR).forEach((pageText, i) => {
    const page = i + 1;
    // PDF lines -> paragraphs: blank lines and heading lines start a new paragraph
    const paragraphs: { text: string; heading: boolean }[] = [];
    let current: string[] = [];
    const endParagraph = () => {
      if (current.length)
        paragraphs.push({ text: current.join(' '), heading: false });
      current = [];
    };
    for (const raw of pageText.split('\n')) {
      const line = raw.trim();
      if (!line) {
        endParagraph();
      } else if (looksLikeHeading(line)) {
        endParagraph();
        paragraphs.push({ text: line, heading: true });
      } else {
        current.push(line);
      }
    }
    endParagraph();

    let buffer = '';
    const flush = () => {
      if (buffer.trim())
        chunks.push({
          index: chunks.length,
          page,
          heading,
          text: buffer.trim(),
        });
      buffer = '';
    };
    for (const p of paragraphs) {
      if (p.heading) {
        flush();
        heading = p.text.slice(0, 120);
        buffer = p.text;
        continue;
      }
      if (
        buffer.length + p.text.length + 1 > CHUNK_TARGET_CHARS &&
        buffer &&
        buffer !== heading
      )
        flush();
      buffer = buffer ? `${buffer}\n${p.text}` : p.text;
      while (buffer.length > CHUNK_MAX_CHARS) {
        const cut = buffer.lastIndexOf(' ', CHUNK_TARGET_CHARS);
        const at = cut > 200 ? cut : CHUNK_TARGET_CHARS;
        chunks.push({
          index: chunks.length,
          page,
          heading,
          text: buffer.slice(0, at).trim(),
        });
        buffer = buffer.slice(at).trim();
      }
    }
    flush();
  });
  return chunks;
}

/** Western and Arabic-Indic digits */
const DIGIT = '[0-9\u0660-\u0669\u06F0-\u06F9]';
const NUMBERED = new RegExp(
  `^${DIGIT}+([.\u066B]${DIGIT}+)*[.)\u066B-]?\\s+\\S`,
);

function looksLikeHeading(line: string): boolean {
  if (line.length > 90) return false;
  if (NUMBERED.test(line) && !/[.!?؟]$/.test(line)) return true;
  // \b does not work after Arabic letters: use an explicit boundary
  return /^(chapter|section|part|appendix|الفصل|القسم|الباب|الملحق)(?=[\s:]|$)/i.test(
    line,
  );
}

/**
 * Picks the most relevant chunks for the query terms within the budget,
 * then returns them in reading order with ids H1..Hn.
 */
export function selectExcerpts(
  chunks: HandbookChunk[],
  queryText: string,
  options: { maxChars: number; maxExcerpts: number },
): HandbookExcerpt[] {
  if (chunks.length === 0) return [];
  const query = [...new Set(tokenize(queryText))];
  const docs = chunks.map((c) => tokenize(`${c.heading ?? ''} ${c.text}`));
  const avgLen = docs.reduce((s, d) => s + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const d of docs)
    for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);

  const k1 = 1.2;
  const b = 0.75;
  const N = docs.length;
  const scored = chunks.map((chunk, i) => {
    const tf = new Map<string, number>();
    for (const t of docs[i]) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const term of query) {
      const f = tf.get(term) ?? 0;
      if (!f) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score +=
        (idf * f * (k1 + 1)) /
        (f + k1 * (1 - b + (b * docs[i].length) / avgLen));
    }
    return { chunk, score };
  });

  const ranked = scored
    .filter((s) => s.score > 0)
    .sort((a, b2) => b2.score - a.score || a.chunk.index - b2.chunk.index);
  // nothing matched: fall back to the beginning of the handbook (overview pages)
  const pool =
    ranked.length > 0 ? ranked : scored.map((s) => ({ ...s, score: 0 }));

  const picked: { chunk: HandbookChunk; score: number }[] = [];
  let used = 0;
  for (const item of pool) {
    if (picked.length >= options.maxExcerpts) break;
    if (used + item.chunk.text.length > options.maxChars) continue;
    picked.push(item);
    used += item.chunk.text.length;
  }
  return picked
    .sort((a, b2) => a.chunk.index - b2.chunk.index)
    .map((p, i) => ({
      ...p.chunk,
      id: `H${i + 1}`,
      score: Math.round(p.score * 100) / 100,
    }));
}
