// محرك «نَقَل»: التقطيع، الاسترجاع المقيَّد بالمصدر، والمقابلة النصية
import {
  normalizeArabic,
  charNgrams,
  diceCoefficient,
  bestWindow,
} from "./arabic";
import type { DiffToken, Verdict } from "@contracts/types";

// ---------- أزواج (خام/مُطبَّع) تربط العرض الأصلي بالمطابقة ----------
export interface TokenPair {
  norm: string;
  raw: string;
}

export function tokenPairs(rawText: string): TokenPair[] {
  return rawText
    .split(/\s+/)
    .map((raw) => ({ raw, norm: normalizeArabic(raw) }))
    .filter((p) => p.norm.length > 0);
}

// ---------- التقطيع مع الحفاظ على رقم الصفحة ----------
export interface ChunkDraft {
  page: number;
  text: string;
}

const CHUNK_TARGET = 750;
const CHUNK_OVERLAP = 140;

export function chunkPages(pages: { page: number; text: string }[]): ChunkDraft[] {
  const out: ChunkDraft[] = [];
  for (const { page, text } of pages) {
    const lines = text
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    let buf = "";
    const flush = () => {
      if (buf.trim().length >= 40) {
        out.push({ page, text: buf.trim() });
        buf = buf.slice(-CHUNK_OVERLAP);
      }
    };
    for (const line of lines) {
      if (buf.length + line.length > CHUNK_TARGET) flush();
      buf += (buf ? "\n" : "") + line;
    }
    if (buf.trim().length >= 40) out.push({ page, text: buf.trim() });
  }
  return out;
}

// ---------- الاسترجاع ----------
export interface ScoredChunk {
  chunkId: number;
  sourceId: number;
  page: number;
  rawText: string;
  score: number;
  windowStart: number;
  windowEnd: number;
  pairs: TokenPair[];
}

export function scoreChunks(
  query: string,
  chunks: { id: number; sourceId: number; page: number; text: string }[],
): ScoredChunk[] {
  const qPairs = tokenPairs(query);
  const qNorm = qPairs.map((p) => p.norm);
  const qNormStr = qNorm.join(" ");
  const qGrams = charNgrams(qNormStr);
  const results: ScoredChunk[] = [];

  for (const c of chunks) {
    const pairs = tokenPairs(c.text);
    const cNorm = pairs.map((p) => p.norm);
    if (cNorm.length === 0) continue;
    // إن وُجد الاقتباس حرفيًا (بعد التطبيع) داخل القطعة: حدّد النافذة بدقة على الامتداد نفسه
    let containsAt = -1;
    outer: for (let i = 0; i + qNorm.length <= cNorm.length; i++) {
      for (let k = 0; k < qNorm.length; k++) if (cNorm[i + k] !== qNorm[k]) continue outer;
      containsAt = i;
      break;
    }
    let winStart: number, winEnd: number, score: number;
    if (containsAt >= 0) {
      winStart = containsAt;
      winEnd = containsAt + qNorm.length;
      score = 1;
    } else {
      const win = bestWindow(qNorm, cNorm);
      const windowNorm = cNorm.slice(win.start, win.end).join(" ");
      const dice = diceCoefficient(qGrams, charNgrams(windowNorm));
      winStart = win.start;
      winEnd = win.end;
      score = 0.6 * win.coverage + 0.4 * dice;
    }
    if (score >= 0.22) {
      results.push({
        chunkId: c.id,
        sourceId: c.sourceId,
        page: c.page,
        rawText: c.text,
        score,
        windowStart: winStart,
        windowEnd: winEnd,
        pairs,
      });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

// ---------- المقابلة النصية (LCS على الأزواج، العرض بالنص الخام) ----------
export function alignPairs(q: TokenPair[], s: TokenPair[]): DiffToken[] {
  const n = q.length;
  const m = s.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        q[i].norm === s[j].norm
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const raw: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (q[i].norm === s[j].norm) {
      raw.push({ op: "same", quote: q[i].raw, source: s[j].raw });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({ op: "added", quote: q[i].raw });
      i++;
    } else {
      raw.push({ op: "removed", source: s[j].raw });
      j++;
    }
  }
  while (i < n) raw.push({ op: "added", quote: q[i++].raw });
  while (j < m) raw.push({ op: "removed", source: s[j++].raw });

  // دمج أزواج الإضافة/الحذف المتجاورة إلى «تحريف» واحد
  const merged: DiffToken[] = [];
  for (let k = 0; k < raw.length; k++) {
    const cur = raw[k];
    const next = raw[k + 1];
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
  return merged;
}

// ---------- قرار التحقق ----------
export function verdictFor(score: number, diff: DiffToken[]): Verdict {
  const hasDiff = diff.some((d) => d.op !== "same");
  if (score >= 0.9) return hasDiff ? "near" : "exact";
  if (score >= 0.7) return "near";
  if (score >= 0.45) return "partial";
  return "none";
}

export const ABSTAIN_REASON =
  "لم يُعثر على مطابقة كافية للنص داخل المصادر المتاحة. التزامًا بمنهجية الموثوقية، يمتنع «نَقَل» عن تأكيد النقل بدلًا من توليد جواب غير موثوق — يُنصح بمراجعة المصدر الورقي أو مختص.";
