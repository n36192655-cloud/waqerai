/**
 * عميل قراءة عداد المياه من الصورة عبر Supabase Edge Function.
 * يستدعي دالة meter-vision المنشورة على Supabase التي تستخدم مفتاح Gemini API
 * المخزَّن كـ Secret — لا حاجة لأي مفتاح في كود الواجهة.
 *
 * عند انقطاع الشبكة أو فشل الدالة البعيدة، يُستخدم OCR المحلي
 * (meter-ocr.ts) كمسار بديل — هذا ما يفعله readings.tsx.
 */

export interface MeterVisionResult {
  readingValue: number | null;
  confidence: number;
  meterNumber: string | null;
  otherNumbers: string[];
  ambiguous: boolean;
  serialMatch: "match" | "mismatch" | "unknown";
}

interface VisionInput {
  imageDataUrl: string;
  knownMeterNumber?: string;
  previousReading?: number | null;
}

export async function readMeterFromImageEdge(
  input: VisionInput,
): Promise<MeterVisionResult> {
  const supabaseUrl = import.meta.env["VITE_SUPABASE_URL"] as string;
  const supabaseKey =
    (import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] as string) ||
    (import.meta.env["VITE_SUPABASE_ANON_KEY"] as string);

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("إعدادات Supabase غير متوفرة");
  }

  const { supabase } = await import("@/lib/supabase");
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData?.session?.access_token;
  if (!accessToken) {
    throw new Error("انتهت الجلسة — سجّل الدخول مرة أخرى");
  }

  const url = `${supabaseUrl}/functions/v1/meter-vision`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      apikey: supabaseKey,
    },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ error: `فشل الطلب (${res.status})` }));
    throw new Error(errBody.error ?? `فشل الطلب (${res.status})`);
  }

  const data = (await res.json()) as MeterVisionResult;
  return data;
}
