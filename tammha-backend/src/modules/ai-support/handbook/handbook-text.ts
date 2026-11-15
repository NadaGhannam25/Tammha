// pdf-parse 1.1.1 (pure JS, Node 18 compatible). The library file is imported directly:
// the package entry point runs a self-test when it has no parent module.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

export interface ExtractedHandbookText {
  pageCount: number;
  /** One string per page */
  pages: string[];
  /** Pages joined with a form feed (\f) — the format stored in extractedText */
  text: string;
}

/** Form feed separates pages in UniversityHandbook.extractedText. */
export const PAGE_SEPARATOR = '\f';

interface PdfTextItem {
  str: string;
  transform: number[];
}

/**
 * Extracts the text of a PDF, page by page, keeping line breaks.
 * Scanned (image-only) PDFs give little or no text — the caller rejects those.
 */
export async function extractPdfText(
  buffer: Buffer,
): Promise<ExtractedHandbookText> {
  const pages: string[] = [];
  const result = await pdfParse(buffer, {
    pagerender: async (page: {
      getTextContent(o: object): Promise<{ items: PdfTextItem[] }>;
    }) => {
      const content = await page.getTextContent({
        normalizeWhitespace: true,
        disableCombineTextItems: false,
      });
      let lastY: number | undefined;
      let text = '';
      for (const item of content.items) {
        const y = item.transform[5];
        if (lastY !== undefined && y !== lastY) text += '\n';
        text += item.str;
        lastY = y;
      }
      pages.push(cleanPage(text));
      return text;
    },
  });
  return {
    pageCount: result.numpages,
    pages,
    text: pages.join(PAGE_SEPARATOR),
  };
}

function cleanPage(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
