// استخراج النص من ملفات PDF — صفحة بصفحة (لتتبع رقم الصفحة)
// يعتمد على pdf.js المضمَّن في pdf-parse (نسخة CJS ذاتية الاحتواء تتوافق مع التجميع)

export interface ExtractedPage {
  page: number;
  text: string;
}

// استيراد الملف الداخلي مباشرة لتجنّب كتلة التصحيح في نقطة دخول الحزمة
/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-ignore — حزمة CJS بلا تعريفات أنواع للمسار الداخلي
import pdfParse from "pdf-parse/lib/pdf-parse.js";

export async function extractPdfPages(data: Uint8Array): Promise<ExtractedPage[]> {
  const pages: ExtractedPage[] = [];
  await pdfParse(Buffer.from(data), {
    pagerender: async (pageData: {
      pageNumber: number;
      getTextContent: () => Promise<{
        items: Array<{ str: string; hasEOL?: boolean }>;
      }>;
    }) => {
      const tc = await pageData.getTextContent();
      const text = tc.items
        .map((it) => it.str + (it.hasEOL ? "\n" : " "))
        .join("")
        .replace(/[ \t]+/g, " ")
        .trim();
      pages.push({ page: pageData.pageNumber, text });
      return "";
    },
    max: 0,
  });
  return pages;
}
