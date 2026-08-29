/**
 * قراءة أرقام عداد المياه من صورة (OCR) — وحدة محلية قابلة للنقل.
 *
 * لا تعتمد على قاعدة بيانات ولا على متغيرات بيئة، وتستخدم مكتبة tesseract.js
 * الموجودة أصلاً ضمن اعتماديات المشروع، ويتم تحميلها بشكل كسول (dynamic import)
 * داخل المتصفح فقط حتى لا تدخل في مسار SSR.
 *
 * المبدأ:
 *  - رقم العداد (Meter Number) معروف مسبقاً من بيانات المشترك، ولا يُستنتج من الصورة.
 *    نستخدم OCR فقط للتحقق: هل يظهر نفس الرقم على جسم العداد؟
 *  - القراءة الحالية (Current Reading) تُستخرج من أكبر مجموعة أرقام في شاشة العداد
 *    (خانات العدّاد الميكانيكية عادةً أكبر ارتفاعاً من باقي الطباعة)، مع استبعاد
 *    الرقم المطابق لرقم العداد المعروف.
 *  - كل ما تبقى (أرقام تسلسلية، وحدات، تواريخ، علامة تجارية، رموز فنية) يُعاد
 *    كقائمة "أرقام/نصوص أخرى" للعرض فقط، ولا يدخل في أي حساب.
 */

export interface OcrToken {
  text: string;
  confidence: number;
  /** ارتفاع الكلمة بالبكسل — مؤشر على حجم الخط داخل الصورة */
  height: number;
  kind: "reading" | "meter-number" | "date" | "unit" | "other";
}

export interface MeterOcrResult {
  rawText: string;
  tokens: OcrToken[];
  /** رقم العداد المعروف إن تم العثور عليه في الصورة (تحقق فقط) */
  meterNumberMatch: string | null;
  /** القراءة الحالية المرشحة (نص كما ظهر) */
  readingCandidate: string | null;
  /** القراءة الحالية كرقم، أو null إن تعذر الاستخراج بثقة */
  readingValue: number | null;
  /** درجة ثقة القراءة المرشحة 0-100 */
  readingConfidence: number;
  /** عدة مرشحين متقاربين — لا يجوز التخمين، يُطلب إدخال يدوي */
  readingAmbiguous: boolean;
  /** بقية الأرقام والنصوص التي ظهرت على العداد (للعرض فقط) */
  otherTokens: OcrToken[];
}

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

/** توحيد الأرقام العربية/الفارسية إلى أرقام لاتينية */
export function normalizeDigits(input: string): string {
  return input.replace(ARABIC_DIGITS, (d) => {
    const code = d.charCodeAt(0);
    if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
    return String(code - 0x06f0);
  });
}

/** تطبيع للمقارنة: إزالة المسافات والشرطات ورفع الحروف */
export function normalizeSerial(v: string): string {
  return normalizeDigits(v).replace(/[-\s._]/g, "").toUpperCase();
}

const DATE_RE = /^(19|20)\d{2}$|^\d{1,2}[./-]\d{1,2}([./-]\d{2,4})?$/;
const UNIT_RE = /^(m3|m³|cbm|kwh|lt|l|kg|bar|°c|mm|cm)$/i;

function classify(
  text: string,
  knownSerialNorm: string,
  isReadingCandidate: boolean
): OcrToken["kind"] {
  const norm = normalizeSerial(text);
  if (knownSerialNorm && norm === knownSerialNorm) return "meter-number";
  if (UNIT_RE.test(text.trim())) return "unit";
  if (DATE_RE.test(normalizeDigits(text.trim()))) return "date";
  if (isReadingCandidate) return "reading";
  return "other";
}

/** هل يصلح النص كقراءة عدّاد؟ خانات أرقام متتالية مع كسر عشري اختياري */
function readingShape(text: string): { ok: boolean; value: number | null } {
  const t = normalizeDigits(text).replace(/[^\d.,]/g, "").replace(/,/g, ".");
  if (!/^\d{1,8}(\.\d{1,3})?$/.test(t)) return { ok: false, value: null };
  const digits = t.replace(/\D/g, "");
  // خانات العداد عادة بين 3 و 8 أرقام
  if (digits.length < 3 || digits.length > 8) return { ok: false, value: null };
  const value = Number(t);
  if (!Number.isFinite(value)) return { ok: false, value: null };
  return { ok: true, value };
}

export interface RecognizeOptions {
  /** رقم العداد المعروف مسبقاً من بيانات المشترك (لا يُستنتج من الصورة) */
  knownMeterNumber?: string;
  /** القراءة السابقة — تُستخدم فقط لترجيح المرشح، لا لتغيير أي منطق حسابي */
  previousReading?: number | null;
  /** أرقام معروفة من بيانات المشترك (هاتف، معرفات) تُستبعد من المرشحين */
  excludeNumbers?: (string | number | null | undefined)[];
}

/**
 * تشغيل OCR على صورة العداد. لا يقوم بأي حفظ ولا أي حساب استهلاك —
 * يعيد النتيجة فقط ليؤكدها المستخدم يدوياً.
 */
/** كلمة مستخرجة من نتيجة tesseract */
interface FlatWord {
  text: string;
  confidence: number;
  height: number;
}

/** tesseract.js v7 لا يعيد data.words — الكلمات موجودة داخل blocks */
function flattenWords(data: unknown): FlatWord[] {
  const out: FlatWord[] = [];
  type W = { text?: string; confidence?: number; bbox?: { y0: number; y1: number } };
  type L = { words?: W[] };
  type P = { lines?: L[] };
  type B = { paragraphs?: P[] };
  const d = data as { blocks?: B[] | null; words?: W[] | null };

  const push = (w?: W) => {
    const text = (w?.text ?? "").trim();
    if (!text) return;
    out.push({
      text,
      confidence: typeof w?.confidence === "number" ? w.confidence : 0,
      height: w?.bbox ? Math.abs(w.bbox.y1 - w.bbox.y0) : 0,
    });
  };

  for (const b of d.blocks ?? []) {
    for (const p of b?.paragraphs ?? []) {
      for (const l of p?.lines ?? []) {
        for (const w of l?.words ?? []) push(w);
      }
    }
  }
  // توافق مع الإصدارات القديمة
  if (out.length === 0) for (const w of d.words ?? []) push(w);
  return out;
}

/**
 * تحسين الصورة قبل التعرف: تصغير معقول + تدرّج رمادي + زيادة تباين.
 * يجري كلياً في المتصفح على canvas — بلا شبكة وبلا اعتماديات جديدة.
 */
async function preprocess(image: Blob | File | string): Promise<HTMLCanvasElement | Blob | File | string> {
  try {
    const src =
      typeof image === "string" ? image : URL.createObjectURL(image);
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("image load failed"));
      img.src = src;
    });
    const maxW = 1600;
    const scale = img.naturalWidth > maxW ? maxW / img.naturalWidth : 1;
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return image;
    ctx.drawImage(img, 0, 0, w, h);
    if (typeof image !== "string") URL.revokeObjectURL(src);

    const px = ctx.getImageData(0, 0, w, h);
    const a = px.data;
    // رمادي + متوسط للسطوع
    let sum = 0;
    for (let i = 0; i < a.length; i += 4) {
      const g = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
      a[i] = a[i + 1] = a[i + 2] = g;
      sum += g;
    }
    const mean = sum / (a.length / 4);
    // زيادة تباين حول المتوسط (بدون عتبة قاطعة تُفقد الخانات الرقمية)
    const k = 1.6;
    for (let i = 0; i < a.length; i += 4) {
      const v = Math.max(0, Math.min(255, (a[i] - mean) * k + mean));
      a[i] = a[i + 1] = a[i + 2] = v;
    }
    ctx.putImageData(px, 0, 0);
    return canvas;
  } catch {
    return image;
  }
}

/**
 * تحويل صورة العداد إلى data URL مضغوط (JPEG) لإرسالها إلى نموذج الرؤية.
 * يجري كلياً في المتصفح — بلا اعتماديات جديدة وبلا إعدادات خاصة.
 */
export async function imageToCompressedDataUrl(
  image: Blob | File,
  maxSide = 1280,
  quality = 0.82
): Promise<string> {
  const src = URL.createObjectURL(image);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("image load failed"));
      img.src = src;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", quality);
  } finally {
    URL.revokeObjectURL(src);
  }
}

/**
 * تشغيل OCR على صورة العداد. لا يقوم بأي حفظ ولا أي حساب استهلاك —
 * يعيد النتيجة فقط ليؤكدها المستخدم يدوياً.
 */
export async function recognizeMeterImage(
  image: Blob | File | string,
  options: RecognizeOptions = {}
): Promise<MeterOcrResult> {
  if (typeof window === "undefined") {
    throw new Error("OCR متاح في المتصفح فقط");
  }

  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");

  try {
    const input = await preprocess(image);

    // ممر 1: نص عام (لالتقاط رقم العداد والوحدات والتواريخ)
    const general = await worker.recognize(
      input as never,
      {},
      { text: true, blocks: true } as never
    );
    const rawText = general.data.text ?? "";
    const generalWords = flattenWords(general.data);

    // ممر 2: أرقام فقط — أدق بكثير لخانات العداد
    let digitWords: FlatWord[] = [];
    try {
      await worker.setParameters({
        tessedit_char_whitelist: "0123456789.,",
      });
      const digits = await worker.recognize(
        input as never,
        {},
        { text: true, blocks: true } as never
      );
      digitWords = flattenWords(digits.data);
      await worker.setParameters({ tessedit_char_whitelist: "" });
    } catch {
      digitWords = [];
    }

    const knownSerialNorm = options.knownMeterNumber
      ? normalizeSerial(options.knownMeterNumber)
      : "";

    const fallback: FlatWord[] =
      generalWords.length === 0 && digitWords.length === 0
        ? rawText
            .split(/\s+/)
            .filter(Boolean)
            .map((t) => ({ text: t.trim(), confidence: 0, height: 0 }))
        : [];

    const cleaned = [...generalWords, ...digitWords, ...fallback].filter(
      (w) => w.text.length > 0
    );

    // أرقام معروفة أخرى من بيانات المشترك (هاتف، معرفات) — تُستبعد كلياً.
    const excluded = new Set(
      (options.excludeNumbers ?? [])
        .filter((v) => v != null && String(v).trim() !== "")
        .map((v) => normalizeSerial(String(v)))
    );

    // مرشحو القراءة: أشكال أرقام صالحة، وليست رقم العداد المعروف، وليست تاريخاً.
    const candidates = cleaned
      .map((w) => ({ ...w, shape: readingShape(w.text) }))
      .filter(
        (w) =>
          w.shape.ok &&
          w.shape.value != null &&
          w.shape.value >= 0 &&
          normalizeSerial(w.text) !== knownSerialNorm &&
          !excluded.has(normalizeSerial(w.text)) &&
          !UNIT_RE.test(w.text.trim()) &&
          !DATE_RE.test(normalizeDigits(w.text.trim()))
      );


    // الترجيح: حجم الخط (خانات العداد أكبر) ثم الثقة ثم عدد الخانات ثم القرب من القراءة السابقة.
    const prev = options.previousReading ?? null;
    const scored = candidates
      .map((c) => {
        const digitLen = normalizeDigits(c.text).replace(/\D/g, "").length;
        let score = c.height * 2 + c.confidence + digitLen * 8;
        if (prev != null && c.shape.value != null) {
          if (c.shape.value >= prev) score += 25;
          const delta = Math.abs(c.shape.value - prev);
          if (delta <= Math.max(50, prev * 0.5)) score += 25;
        }
        return { ...c, score };
      })
      .sort((a, b) => b.score - a.score);

    // استبعاد ما يساوي القراءة السابقة تماماً (لا يمثل تغيّراً جديداً)
    const filteredPrev = scored.filter((c) => prev == null || c.shape.value !== prev);
    // توحيد المرشحين المتطابقين في القيمة (الممرّان قد يعيدان نفس الرقم)
    const seen = new Set<number>();
    const usable = filteredPrev.filter((c) => {
      const v = c.shape.value as number;
      if (seen.has(v)) return false;
      seen.add(v);
      return true;
    });
    const best = usable[0] ?? null;

    // تقارب حقيقي بين قيمتين مختلفتين ⇒ لا تخمين
    const second = usable[1] ?? null;
    const readingAmbiguous = !!best && !!second && second.score >= best.score * 0.97;


    const tokens: OcrToken[] = cleaned.map((w) => ({
      text: w.text,
      confidence: Math.round(w.confidence),
      height: Math.round(w.height),
      kind: classify(w.text, knownSerialNorm, best ? w.text === best.text : false),
    }));

    // مطابقة رقم العداد: على مستوى الكلمة أو على النص المُجمَّع (قد يُقسَّم لكلمتين)
    const joinedNorm = normalizeSerial(rawText);
    const meterNumberMatch =
      knownSerialNorm &&
      (cleaned.some((w) => normalizeSerial(w.text) === knownSerialNorm) ||
        joinedNorm.includes(knownSerialNorm))
        ? (options.knownMeterNumber ?? null)
        : null;


    return {
      rawText,
      tokens,
      meterNumberMatch,
      readingCandidate: best ? best.text : null,
      readingValue: best ? best.shape.value : null,
      readingConfidence: best ? Math.round(best.confidence) : 0,
      readingAmbiguous,
      otherTokens: tokens.filter((t) => t.kind !== "reading"),
    };
  } finally {
    await worker.terminate();
  }
}
