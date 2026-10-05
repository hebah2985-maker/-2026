// محرك المعالجة العربية — التطبيع، التقطيع، التشابه، والمقابلة النصية
// كل العمليات على النص المطبَّع تُستخدم للمطابقة فقط؛ العرض دائمًا بالنص الأصلي.

const DIACRITICS = /[ً-ْٰـۖ-ۭ]/g;

/** تطبيع عربي للمطابقة: إزالة التشكيل والتطويل، توحيد الألف والهمزات والياء والتاء المربوطة */
export function normalizeArabic(input: string): string {
  return input
    .replace(DIACRITICS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ء/g, "")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[«»"''""''`´()\[\]{}<>.,،؛:!?؟…ـ—–-]/g, " ")
    .replace(/[^\u0600-\u06FFa-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(normalized: string): string[] {
  return normalized.split(" ").filter((w) => w.length > 0);
}

/** n-grams محرفية للتشابه الضبابي */
export function charNgrams(s: string, n = 3): Set<string> {
  const grams = new Set<string>();
  const padded = ` ${s} `;
  for (let i = 0; i + n <= padded.length; i++) grams.add(padded.slice(i, i + n));
  return grams;
}

export function diceCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const g of a) if (b.has(g)) overlap++;
  return (2 * overlap) / (a.size + b.size);
}

/** تشابه المجموعات على مستوى الكلمات (F1) */
export function tokenF1(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const bCounts = new Map<string, number>();
  for (const w of b) bCounts.set(w, (bCounts.get(w) ?? 0) + 1);
  let hit = 0;
  for (const w of a) {
    const c = bCounts.get(w) ?? 0;
    if (c > 0) {
      hit++;
      bCounts.set(w, c - 1);
    }
  }
  const precision = hit / a.length;
  const recall = hit / b.length;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

// ---------- المقابلة النصية على مستوى الكلمة (LCS) ----------

export type RawDiffOp = "same" | "added" | "removed" | "changed";

export interface RawDiff {
  op: RawDiffOp;
  quote?: string;
  source?: string;
}

/**
 * محاذاة كلمات الاقتباس مع كلمات المصدر باستخدام أطول تتابع مشترك (LCS).
 * added   = كلمة زائدة في الاقتباس لا وجود لها في الأصل (زيادة)
 * removed = كلمة من الأصل ساقطة من الاقتباس (نقصان)
 * changed = استبدال متقابل (تحريف محتمل)
 */
export function alignWords(quoteTokens: string[], sourceTokens: string[]): RawDiff[] {
  const n = quoteTokens.length;
  const m = sourceTokens.length;
  if (n === 0 || m === 0) {
    return [
      ...quoteTokens.map((q): RawDiff => ({ op: "added", quote: q })),
      ...sourceTokens.map((s): RawDiff => ({ op: "removed", source: s })),
    ];
  }
  // جدول LCS
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        quoteTokens[i] === sourceTokens[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: RawDiff[] = [];
  let i = 0;
  let j = 0;
  const pushChanged = (q: string | undefined, s: string | undefined) => {
    const last = out[out.length - 1];
    if (last && last.op === "changed") {
      last.quote = [last.quote, q].filter(Boolean).join(" ");
      last.source = [last.source, s].filter(Boolean).join(" ");
    } else {
      out.push({ op: "changed", quote: q, source: s });
    }
  };
  while (i < n && j < m) {
    if (quoteTokens[i] === sourceTokens[j]) {
      out.push({ op: "same", quote: quoteTokens[i], source: sourceTokens[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      // حذف من الاقتباس أولًا ثم قد يليه إدراج → نجمعهما لاحقًا كـ changed عند التقائهما
      out.push({ op: "added", quote: quoteTokens[i] });
      i++;
    } else {
      out.push({ op: "removed", source: sourceTokens[j] });
      j++;
    }
  }
  while (i < n) out.push({ op: "added", quote: quoteTokens[i++] });
  while (j < m) out.push({ op: "removed", source: sourceTokens[j++] });

  // دمج أزواج (added,removed) المتجاورة إلى changed
  const merged: RawDiff[] = [];
  for (let k = 0; k < out.length; k++) {
    const cur = out[k];
    const next = out[k + 1];
    if (cur.op === "added" && next?.op === "removed") {
      merged.push({ op: "changed", quote: cur.quote, source: next.source });
      k++;
    } else if (cur.op === "removed" && next?.op === "added") {
      merged.push({ op: "changed", quote: next.quote, source: cur.source });
      k++;
    } else {
      merged.push(cur);
    }
  }
  void pushChanged;
  return merged;
}

/**
 * يجد أفضل نافذة مطابقة داخل رموز المصدر لاقتباس معطى،
 * ويعيد [بداية، نهاية) النافذة ونسبة تغطية الاقتباس داخلها.
 */
export function bestWindow(
  quoteTokens: string[],
  sourceTokens: string[],
): { start: number; end: number; coverage: number } {
  const n = quoteTokens.length;
  const m = sourceTokens.length;
  if (n === 0 || m === 0) return { start: 0, end: m, coverage: 0 };
  const winSize = Math.max(n, 4);
  let best = { start: 0, end: Math.min(m, winSize), coverage: 0 };
  const step = Math.max(1, Math.floor(winSize / 8));
  for (let s = 0; s < m; s += step) {
    const e = Math.min(m, s + Math.ceil(winSize * 1.35));
    const coverage = tokenF1(quoteTokens, sourceTokens.slice(s, e));
    if (coverage > best.coverage) best = { start: s, end: e, coverage };
    if (e === m) break;
  }
  // توسيع دقيق حول الأفضل
  const s0 = Math.max(0, best.start - step);
  const e0 = Math.min(m, best.end + step);
  for (let s = s0; s < e0; s++) {
    const e = Math.min(m, s + Math.ceil(winSize * 1.35));
    if (s >= e) break;
    const coverage = tokenF1(quoteTokens, sourceTokens.slice(s, e));
    if (coverage > best.coverage) best = { start: s, end: e, coverage };
  }
  return best;
}
