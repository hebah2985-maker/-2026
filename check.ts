// موجّه التحقق والسؤال — قلب «نَقَل»: استرجاع مقيَّد بالمصدر + امتناع عند غياب الدليل
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { sources, chunks, checks } from "../../db/schema";
import { scoreChunks, alignPairs, tokenPairs, verdictFor, ABSTAIN_REASON } from "../lib/engine";
import { composeAnswer, classifyAiError } from "../lib/ai";
import { AiUnavailable, AiMisconfigured, ContentRejected } from "../lib/ai-client";
import type {
  VerifyResponse,
  AskResponse,
  MatchResult,
  EvidencePassage,
} from "@contracts/types";
import { VERDICT_LABELS } from "@contracts/types";

async function loadScopedChunks(sourceId?: number) {
  const db = getDb();
  const ready = await db
    .select({ id: sources.id })
    .from(sources)
    .where(
      sourceId
        ? eq(sources.id, sourceId)
        : eq(sources.status, "ready"),
    );
  const ids = ready.map((r) => r.id);
  if (ids.length === 0) return { chunkRows: [], sourceMap: new Map<number, typeof sources.$inferSelect>() };
  const chunkRows = await db
    .select({
      id: chunks.id,
      sourceId: chunks.sourceId,
      page: chunks.page,
      text: chunks.text,
    })
    .from(chunks)
    .where(inArray(chunks.sourceId, ids));
  const sourceRows = await db.select().from(sources).where(inArray(sources.id, ids));
  return { chunkRows, sourceMap: new Map(sourceRows.map((s) => [s.id, s])) };
}

async function logCheck(mode: "verify" | "ask", queryText: string, verdict: string, score: number, durationMs: number) {
  try {
    await getDb().insert(checks).values({ mode, queryText: queryText.slice(0, 2000), verdict, score, durationMs });
  } catch {
    /* السجل إحصائي فقط — لا يعطّل الخدمة */
  }
}

export const checkRouter = createRouter({
  /** التحقق من اقتباس: مقابلة حرفية/دلالية داخل المصادر فقط */
  verify: publicQuery
    .input(
      z.object({
        quote: z.string().min(8, "الاقتباس قصير جدًا للتحقق").max(4000),
        sourceId: z.number().optional(),
      }),
    )
    .mutation(async ({ input }): Promise<VerifyResponse> => {
      const t0 = Date.now();
      const { chunkRows, sourceMap } = await loadScopedChunks(input.sourceId);
      const qPairs = tokenPairs(input.quote);

      if (qPairs.length < 3 || chunkRows.length === 0) {
        const durationMs = Date.now() - t0;
        await logCheck("verify", input.quote, "none", 0, durationMs);
        return {
          verdict: "none",
          verdictLabel: VERDICT_LABELS.none,
          quote: input.quote,
          matches: [],
          durationMs,
          abstainReason:
            chunkRows.length === 0
              ? "لا توجد مصادر جاهزة في النطاق المحدد. ارفع مصدرًا أو وسّع النطاق."
              : ABSTAIN_REASON,
        };
      }

      const scored = scoreChunks(input.quote, chunkRows).slice(0, 3);
      const matches: MatchResult[] = scored.map((s) => {
        const src = sourceMap.get(s.sourceId);
        // المحاذاة على القطعة كاملة ثم قصّ الحواف الزائدة (سياق لا يخص الاقتباس)
        const full = alignPairs(qPairs, s.pairs);
        const first = full.findIndex((d) => d.op !== "removed");
        const last = (() => {
          for (let k = full.length - 1; k >= 0; k--) if (full[k].op !== "removed") return k;
          return full.length - 1;
        })();
        const diff = first <= last ? full.slice(first, last + 1) : full;
        // النص الأصلي المعروض = منطقة المطابقة فقط، بلفظ المصدر حرفيًا
        const originalText = diff
          .filter((d) => d.op !== "added")
          .map((d) => d.source)
          .filter(Boolean)
          .join(" ");
        return {
          chunkId: s.chunkId,
          sourceId: s.sourceId,
          sourceTitle: src?.title ?? "مصدر غير معروف",
          sourceAuthor: src?.author ?? null,
          sourceOrigin: (src?.origin ?? "upload") as MatchResult["sourceOrigin"],
          category: src?.category ?? "other",
          page: s.page,
          originalText,
          score: Math.round(s.score * 100),
          diff,
        };
      });

      const best = matches[0];
      const bestDiff = best?.diff ?? [];
      const verdict = verdictFor(best ? best.score / 100 : 0, bestDiff);
      const durationMs = Date.now() - t0;
      await logCheck("verify", input.quote, verdict, best?.score ?? 0, durationMs);

      if (verdict === "none") {
        return {
          verdict,
          verdictLabel: VERDICT_LABELS.none,
          quote: input.quote,
          matches: [],
          durationMs,
          abstainReason: ABSTAIN_REASON,
        };
      }
      return {
        verdict,
        verdictLabel: VERDICT_LABELS[verdict],
        quote: input.quote,
        matches,
        durationMs,
        abstainReason: null,
      };
    }),

  /** اسأل داخل المصادر: استرجاع + إجابة ميسّرة مقيّدة بالنصوص، مع الامتناع عند غياب الدليل */
  ask: publicQuery
    .input(
      z.object({
        question: z.string().min(4).max(2000),
        sourceId: z.number().optional(),
      }),
    )
    .mutation(async ({ input }): Promise<AskResponse> => {
      const t0 = Date.now();
      const { chunkRows, sourceMap } = await loadScopedChunks(input.sourceId);
      const scored = scoreChunks(input.question, chunkRows)
        .filter((s) => s.score >= 0.3)
        .slice(0, 5);

      const passages: EvidencePassage[] = scored.map((s) => {
        const src = sourceMap.get(s.sourceId);
        return {
          sourceId: s.sourceId,
          sourceTitle: src?.title ?? "مصدر غير معروف",
          sourceAuthor: src?.author ?? null,
          page: s.page,
          text: s.rawText,
          score: Math.round(s.score * 100),
        };
      });

      // الامتناع أولًا: لا دليل كافٍ → لا توليد
      if (passages.length === 0) {
        const durationMs = Date.now() - t0;
        await logCheck("ask", input.question, "none", 0, durationMs);
        return {
          status: "abstained",
          question: input.question,
          answer: null,
          passages: [],
          abstainReason: ABSTAIN_REASON,
          durationMs,
        };
      }

      try {
        const { answer } = await composeAnswer(input.question, passages);
        const durationMs = Date.now() - t0;
        await logCheck("ask", input.question, "answered", passages[0].score, durationMs);
        return {
          status: "answered",
          question: input.question,
          answer,
          passages,
          abstainReason: null,
          durationMs,
        };
      } catch (err) {
        const durationMs = Date.now() - t0;
        const classified = classifyAiError(err);
        // التدهور المقبول: نُظهر النصوص المسترجعة حتى لو تعذّر التوليد
        const reason =
          classified instanceof AiUnavailable
            ? "حصة الذكاء الاصطناعي مستنفدة حاليًا — نعرض النصوص المسترجعة كما هي دون تلخيص."
            : classified instanceof AiMisconfigured
              ? "إعداد خدمة الذكاء الاصطناعي غير مكتمل — نعرض النصوص المسترجعة كما هي."
              : classified instanceof ContentRejected
                ? "تعذّر توليد الإجابة لهذا السؤال — نعرض النصوص المسترجعة كما هي."
                : "خدمة التوليد غير متاحة لحظيًا — نعرض النصوص المسترجعة كما هي دون تلخيص.";
        await logCheck("ask", input.question, "ai_unavailable", passages[0].score, durationMs);
        return {
          status: "ai_unavailable",
          question: input.question,
          answer: null,
          passages,
          abstainReason: reason,
          durationMs,
        };
      }
    }),
});
