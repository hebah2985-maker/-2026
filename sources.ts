// موجّه المصادر: رفع PDF، نصوص مباشرة، قائمة، تفاصيل، حذف، رابط الملف الأصلي، إحصاءات
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { desc, eq, sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { sources, chunks, checks } from "../../db/schema";
import { storage } from "../lib/storage";
import { extractPdfPages } from "../lib/pdf";
import { chunkPages } from "../lib/engine";
import { normalizeArabic } from "../lib/arabic";
import type { SourceSummary, LibraryStats } from "@contracts/types";

const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10MB

async function insertChunks(sourceId: number, pages: { page: number; text: string }[]) {
  const drafts = chunkPages(pages);
  if (drafts.length === 0) return 0;
  const db = getDb();
  await db.insert(chunks).values(
    drafts.map((d) => ({
      sourceId,
      page: d.page,
      text: d.text,
      normalized: normalizeArabic(d.text),
    })),
  );
  return drafts.length;
}

export const sourcesRouter = createRouter({
  list: publicQuery.query(async (): Promise<SourceSummary[]> => {
    const rows = await getDb().select().from(sources).orderBy(desc(sources.createdAt));
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      author: r.author,
      category: r.category,
      origin: r.origin,
      status: r.status,
      pageCount: r.pageCount,
      chunkCount: r.chunkCount,
      fileName: r.fileName,
      note: r.note,
      createdAt: r.createdAt,
    }));
  }),

  uploadPdf: publicQuery
    .input(
      z.object({
        title: z.string().min(2).max(400),
        author: z.string().max(200).optional(),
        category: z.string().max(64).default("other"),
        fileName: z.string().min(1).max(400),
        contentBase64: z.string().min(8),
      }),
    )
    .mutation(async ({ input }) => {
      const bytes = Uint8Array.from(Buffer.from(input.contentBase64, "base64"));
      if (bytes.length > MAX_PDF_BYTES) {
        throw new TRPCError({
          code: "PAYLOAD_TOO_LARGE",
          message: "الملف يتجاوز الحد الأقصى (10MB) لهذه النسخة التجريبية.",
        });
      }
      if (!bytes.subarray(0, 5).join(",").startsWith("37,80,68,70,45")) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "الملف ليس PDF صالحًا." });
      }
      const db = getDb();
      // 1) إنشاء السجل بحالة معالجة
      const inserted = await db.insert(sources).values({
        title: input.title,
        author: input.author ?? null,
        category: input.category,
        origin: "upload",
        status: "processing",
        fileName: input.fileName,
        note: "مصدر رفعه المستخدم — مسؤولية توثيقه عليه، ولم يخضع لاعتماد المنصة.",
      });
      const sourceId = Number(inserted[0].insertId);
      try {
        // 2) حفظ الملف الأصلي في التخزين الكائني (للعودة إلى الأصل)
        const saved = await storage.uploadFile({
          fileContent: bytes,
          fileName: `naqal/${sourceId}/${input.fileName}`,
          contentType: "application/pdf",
        });
        // 3) استخراج النص صفحة بصفحة
        const pages = await extractPdfPages(bytes);
        const totalChars = pages.reduce((a, p) => a + p.text.length, 0);
        if (pages.length === 0 || totalChars < 200) {
          await db
            .update(sources)
            .set({
              status: "failed",
              fileKey: saved.key,
              pageCount: pages.length,
              note: "لم يُستخرج نص كافٍ — يبدو أن الملف مصوَّر (يحتاج OCR). النسخة الحالية تدعم الملفات النصية فقط.",
            })
            .where(eq(sources.id, sourceId));
          return { id: sourceId, status: "failed" as const };
        }
        const count = await insertChunks(sourceId, pages);
        await db
          .update(sources)
          .set({ status: "ready", fileKey: saved.key, pageCount: pages.length, chunkCount: count })
          .where(eq(sources.id, sourceId));
        return { id: sourceId, status: "ready" as const, pageCount: pages.length, chunkCount: count };
      } catch (err) {
        await db
          .update(sources)
          .set({ status: "failed", note: `تعذّرت المعالجة: ${err instanceof Error ? err.message : "خطأ غير معروف"}` })
          .where(eq(sources.id, sourceId));
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّرت معالجة الملف." });
      }
    }),

  fileUrl: publicQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const row = await db.query.sources.findFirst({ where: eq(sources.id, input.id) });
      if (!row?.fileKey) throw new TRPCError({ code: "NOT_FOUND", message: "لا يوجد ملف أصلي لهذا المصدر." });
      const { url } = await storage.getPresignedUrl({ key: row.fileKey });
      return { url };
    }),

  remove: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const row = await db.query.sources.findFirst({ where: eq(sources.id, input.id) });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      if (row.origin === "library") {
        throw new TRPCError({ code: "FORBIDDEN", message: "مصادر المكتبة المعتمدة لا تُحذف." });
      }
      if (row.fileKey) await storage.deleteFile({ fileKey: row.fileKey }).catch(() => {});
      await db.delete(chunks).where(eq(chunks.sourceId, input.id));
      await db.delete(sources).where(eq(sources.id, input.id));
      return { ok: true };
    }),

  stats: publicQuery.query(async (): Promise<LibraryStats> => {
    const db = getDb();
    const [s] = await db.select({ c: sql<number>`count(*)` }).from(sources).where(eq(sources.status, "ready"));
    const [c] = await db.select({ c: sql<number>`count(*)` }).from(chunks);
    const [k] = await db
      .select({ c: sql<number>`count(*)`, avg: sql<number>`coalesce(avg(duration_ms),0)` })
      .from(checks);
    const [exact] = await db
      .select({ c: sql<number>`count(*)` })
      .from(checks)
      .where(sql`verdict in ('exact','near','answered')`);
    const total = Number(k?.c ?? 0);
    return {
      sources: Number(s?.c ?? 0),
      chunks: Number(c?.c ?? 0),
      checks: total,
      avgDurationMs: Math.round(Number(k?.avg ?? 0)),
      exactRate: total === 0 ? 0 : Math.round((Number(exact?.c ?? 0) / total) * 100),
    };
  }),
});
