// توليد الإجابة الميسّرة — مقيّدة حصرًا بالنصوص المسترجعة من المصادر
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { listModels, classifyAiError } from "./ai-client";
import type { EvidencePassage } from "@contracts/types";

const kimiGw = createOpenAICompatible({
  name: "kimi-gw",
  baseURL: process.env.KIMI_AGENTGW_BASE_URL!,
  apiKey: process.env.KIMI_AGENTGW_API_KEY!,
});

const SYSTEM_PROMPT = `أنت «نَقَل»، محقق نقل علمي مقيَّد بالمصادر. قواعد صارمة لا تُخالف:
1. أجب فقط من «النصوص المسترجعة» المرفقة. ممنوع استخدام أي معرفة خارجها.
2. عند الاستشهاد انقل حرفيًا بين علامتي تنصيص «»، واذكر بعد كل نقلة: (المصدر، الصفحة).
3. فرّق بوضوح بين النص المنقول حرفيًا وبين صياغتك الميسّرة له.
4. إن لم تكفِ النصوص للإجابة فقل صراحة: «النصوص المتاحة لا تكفي للإجابة» ولا تسترسل.
5. لا تصدر فتوى ولا حكمًا شرعيًا مستقلًا، ولا تحكم على أشخاص، ولا تقطع في مسائل الخلاف.
6. أجب بالعربية الفصيحة الميسّرة، بإيجاز (لا تتجاوز 8 أسطر).`;

export interface ComposeResult {
  answer: string;
}

export async function composeAnswer(
  question: string,
  passages: EvidencePassage[],
): Promise<ComposeResult> {
  const { defaultModelId } = await listModels();
  const context = passages
    .map(
      (p, i) =>
        `[نص مسترجع ${i + 1}] المصدر: «${p.sourceTitle}»${p.sourceAuthor ? ` — ${p.sourceAuthor}` : ""} — الصفحة: ${p.page}\n${p.text}`,
    )
    .join("\n\n---\n\n");

  const { text } = await generateText({
    model: kimiGw(defaultModelId),
    system: SYSTEM_PROMPT,
    prompt: `السؤال: ${question}\n\nالنصوص المسترجعة:\n${context}`,
    providerOptions: { "kimi-gw": { max_completion_tokens: 1200 } },
  });
  return { answer: text.trim() };
}

export { classifyAiError };
