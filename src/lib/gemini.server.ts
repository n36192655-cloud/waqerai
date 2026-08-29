/**
 * اتصال Gemini المشترك (الشات + OCR).
 * لا يثبّت النظام على اسم نموذج محدد: يجرّب قائمة نماذج مجانية متاحة بالترتيب،
 * وينتقل تلقائياً إلى البديل عند تعذّر النموذج أو بلوغ حد الاستخدام.
 */
const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

/** نماذج مجانية متاحة — الترتيب = أولوية المحاولة. */
const GEMINI_MODELS = [
  "gemini-flash-latest",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
];

export class GeminiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * ينفّذ طلب chat/completions مع تبديل تلقائي للنموذج عند الفشل القابل للتعافي.
 * body يُمرَّر كما هو (بدون حقل model).
 */
export async function geminiChat(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  let last: GeminiError | null = null;

  for (const model of GEMINI_MODELS) {
    const res = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...body, model }),
    });

    if (res.ok) return await res.json();

    const text = await res.text().catch(() => "");
    last = new GeminiError(res.status, text.slice(0, 300));
    console.error("[gemini] model failed", model, res.status, text.slice(0, 300));

    // 429 حد استخدام، 404/400 نموذج غير متاح، 5xx عطل مؤقت → جرّب التالي
    const retryable =
      res.status === 429 ||
      res.status === 404 ||
      res.status === 400 ||
      res.status === 403 ||
      res.status >= 500;
    if (!retryable) break;
  }

  throw last ?? new GeminiError(500, "تعذّر الوصول إلى محرك الذكاء الاصطناعي.");
}
