const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

const GEMINI_MODELS = [
  "gemini-flash-latest",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
];

interface VisionInput {
  imageDataUrl: string;
  knownMeterNumber?: string;
  previousReading?: number | null;
}

interface MeterVisionResult {
  readingValue: number | null;
  confidence: number;
  meterNumber: string | null;
  otherNumbers: string[];
  ambiguous: boolean;
  serialMatch: "match" | "mismatch" | "unknown";
}

function validate(body: unknown): VisionInput {
  const obj = (body ?? {}) as Record<string, unknown>;
  const imageDataUrl = typeof obj["imageDataUrl"] === "string" ? obj["imageDataUrl"] : "";
  if (!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(imageDataUrl)) {
    throw new Error("صورة غير صالحة");
  }
  if (imageDataUrl.length > 8_000_000) throw new Error("حجم الصورة كبير جداً");
  const knownMeterNumber =
    typeof obj["knownMeterNumber"] === "string" ? obj["knownMeterNumber"].slice(0, 40) : undefined;
  const prev = obj["previousReading"];
  const previousReading = typeof prev === "number" && Number.isFinite(prev) ? prev : null;
  return { imageDataUrl, knownMeterNumber, previousReading };
}

const SYSTEM_PROMPT = `أنت خبير متخصص في قراءة عدادات المياه من الصور (ميكانيكية بأسطوانات أرقام، أو شاشات رقمية LCD).

خطوات إلزامية قبل الإجابة:
1) حدّد مكان «شبّاك القراءة» (صف الخانات المتجاورة داخل إطار مستطيل في منتصف وجه العداد). هذا هو المصدر الوحيد للقراءة.
2) اقرأ الخانات من اليسار إلى اليمين خانةً خانة، ولا تُسقط الأصفار في البداية.
3) الخانات ذات الخلفية/الإطار الأحمر (أو المفصولة بفاصلة عشرية) هي كسور — استبعدها تماماً وأعد الجزء الصحيح فقط (عادة 4 إلى 8 خانات).
4) إذا كانت أسطوانة بين رقمين (نصف دوران)، خذ الرقم الأدنى الظاهر بالكامل.

ما يجب تجاهله تماماً (لا يدخل في readingValue إطلاقاً):
- رقم العداد التسلسلي المطبوع على الجسم أو على ملصق/باركود (غالباً بخط أصغر وخارج شبّاك القراءة).
- سنة الصنع والتواريخ، أرقام المعايرة، القطر (Q3, R160, DN15, 15mm)، الضغط، الوحدات (m3, m³, L)، أرقام الهاتف، اسم الشركة والموديل، أرقام الأختام والرموز الفنية.

قواعد الحسم:
- إن كانت هناك «قراءة سابقة» معطاة: القراءة الحالية يجب أن تكون أكبر منها أو مساوية لها وبفارق منطقي. إن خالفت نتيجتك ذلك فأعد فحص الخانات قبل الإجابة.
- لا تخمّن أبداً: إن كان شبّاك القراءة غير واضح أو ضبابي أو محجوب أو تحتمل خانة أكثر من رقم، اضبط ambiguous=true و readingValue=null.
- confidence رقم من 0 إلى 100 يعبّر عن وضوح الخانات فعلياً.
- readingDigits هو نص الخانات الصحيحة كما قرأتها بالضبط (مثال "00123").
- meterNumber: اقرأ الرقم التسلسلي المطبوع على جسم العداد أو الملصق/الباركود كما هو بالضبط (حروف وأرقام)، وإن لم يظهر بوضوح أعده null.
- otherNumbers: بقية الأرقام الظاهرة في الصورة (ملصقات، باركود، تواريخ) كنص.
- أعد JSON فقط بلا أي شرح.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    readingDigits: { type: "string", description: "خانات القراءة الصحيحة، أو نص فارغ إذا تعذّر" },
    confidence: { type: "number" },
    meterNumber: { type: "string", description: "الرقم التسلسلي، أو نص فارغ" },
    otherNumbers: { type: "array", items: { type: "string" } },
    ambiguous: { type: "boolean" },
  },
  required: ["readingDigits", "confidence", "meterNumber", "otherNumbers", "ambiguous"],
};

function compareSerial(seen: string | null, others: string[], known: string): "match" | "mismatch" | "unknown" {
  const clean = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const digits = (v: string) => v.replace(/\D/g, "").replace(/^0+/, "");
  const k = clean(known);
  const kd = digits(known);
  if (!k) return "unknown";
  const pool = [seen, ...others].filter((v): v is string => typeof v === "string" && v.trim() !== "");
  if (pool.length === 0) return "unknown";
  for (const raw of pool) {
    const c = clean(raw);
    const d = digits(raw);
    if (!c) continue;
    if (c === k || c.includes(k) || k.includes(c)) return "match";
    if (kd && d && kd.length >= 3 && (d === kd || d.endsWith(kd) || kd.endsWith(d))) return "match";
  }
  return seen && clean(seen) ? "mismatch" : "unknown";
}

async function geminiChat(apiKey: string, body: Record<string, unknown>): Promise<unknown> {
  let lastErr: Error | null = null;
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
    console.error("[gemini] model failed", model, res.status, text.slice(0, 300));
    lastErr = new Error(`${res.status}: ${text.slice(0, 200)}`);
    const retryable = res.status === 429 || res.status === 404 || res.status === 400 || res.status === 403 || res.status >= 500;
    if (!retryable) break;
  }
  throw lastErr ?? new Error("تعذّر الوصول إلى محرك الذكاء الاصطناعي.");
}

interface Pass {
  readingValue: number | null;
  confidence: number;
  meterNumber: string | null;
  otherNumbers: string[];
  ambiguous: boolean;
}

async function runPass(apiKey: string, data: VisionInput): Promise<Pass> {
  const hints = [
    data.knownMeterNumber ? `رقم العداد المعروف مسبقاً: ${data.knownMeterNumber}` : null,
    data.previousReading != null ? `القراءة السابقة المسجلة: ${data.previousReading}` : null,
  ].filter(Boolean).join("\n");

  const json = (await geminiChat(apiKey, {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `اقرأ «القراءة الحالية» من شبّاك القراءة في صورة عداد المياه هذه، وتجاهل كل رقم آخر في الصورة.\n${hints}`,
          },
          { type: "image_url", image_url: { url: data.imageDataUrl } },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "meter_reading", schema: SCHEMA },
    },
  })) as { choices?: Array<{ message?: { content?: string } }> };

  const content = json.choices?.[0]?.message?.content ?? "";
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) {
      try { parsed = JSON.parse(m[0]) as Record<string, unknown>; } catch { parsed = {}; }
    }
  }

  const rawReading = parsed["readingValue"];
  let readingValue =
    typeof rawReading === "number" && Number.isFinite(rawReading) && rawReading >= 0
      ? rawReading
      : null;
  if (readingValue == null && typeof parsed["readingDigits"] === "string") {
    const d = (parsed["readingDigits"] as string).replace(/[^\d]/g, "");
    if (d.length >= 3 && d.length <= 8) readingValue = Number(d);
  }
  const rawConf = parsed["confidence"];
  const confidence =
    typeof rawConf === "number" && Number.isFinite(rawConf)
      ? Math.max(0, Math.min(100, Math.round(rawConf <= 1 ? rawConf * 100 : rawConf)))
      : 0;

  return {
    readingValue,
    confidence,
    meterNumber: typeof parsed["meterNumber"] === "string" ? parsed["meterNumber"] : null,
    otherNumbers: Array.isArray(parsed["otherNumbers"])
      ? parsed["otherNumbers"].map((v) => String(v)).slice(0, 8)
      : [],
    ambiguous: parsed["ambiguous"] === true,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "خدمة الذكاء الاصطناعي غير مهيأة (GEMINI_API_KEY مفقود)." }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const body = await req.json();
    const data = validate(body);

    const first = await runPass(apiKey, data);

    const knownDigits = (data.knownMeterNumber ?? "").replace(/\D/g, "").replace(/^0+/, "");
    const looksLikeSerial =
      knownDigits.length >= 4 &&
      first.readingValue != null &&
      String(Math.trunc(first.readingValue)) === knownDigits;

    const belowPrevious =
      data.previousReading != null &&
      first.readingValue != null &&
      first.readingValue < data.previousReading;

    const needsVerify =
      first.readingValue == null ||
      first.ambiguous ||
      first.confidence < 85 ||
      looksLikeSerial ||
      belowPrevious;

    const known = (data.knownMeterNumber ?? "").trim();

    if (!needsVerify) {
      const result: MeterVisionResult = {
        ...first,
        serialMatch: compareSerial(first.meterNumber, first.otherNumbers, known),
      };
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let second: Pass | null = null;
    try {
      second = await runPass(apiKey, data);
    } catch {
      second = null;
    }

    if (!second) {
      const m = compareSerial(first.meterNumber, first.otherNumbers, known);
      const result: MeterVisionResult = looksLikeSerial || belowPrevious
        ? { ...first, readingValue: null, ambiguous: true, serialMatch: m }
        : { ...first, serialMatch: m };
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const secondBelow =
      data.previousReading != null &&
      second.readingValue != null &&
      second.readingValue < data.previousReading;
    const secondSerial =
      knownDigits.length >= 4 &&
      second.readingValue != null &&
      String(Math.trunc(second.readingValue)) === knownDigits;

    if (second.readingValue == null || second.ambiguous || secondBelow || secondSerial) {
      const result: MeterVisionResult = {
        ...second,
        readingValue: null,
        ambiguous: true,
        serialMatch: compareSerial(second.meterNumber, second.otherNumbers, known),
      };
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const agree = first.readingValue === second.readingValue;
    const result: MeterVisionResult = {
      ...second,
      confidence: agree ? Math.max(second.confidence, 95) : Math.min(second.confidence, 80),
      ambiguous: false,
      serialMatch: compareSerial(second.meterNumber, second.otherNumbers, known),
    };

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
