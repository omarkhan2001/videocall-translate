// app/api/translate/route.ts
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs"; // ensure Node runtime for DeepL REST

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

// --- helpers ---
const hasCyrillic = (s: string) => /[\u0400-\u04FF]/.test(s);
const looksItalian = (s: string) =>
  /\b(che|perché|ciao|grazie|sei|sono|andiamo|troppo|molto|amore|tesoro)\b/i.test(s);
const isShortOrOneWord = (s: string) => {
  const words = s.trim().split(/\s+/).filter(Boolean);
  return s.length <= 12 || words.length === 1;
};

// protect names/pet-names so they aren't mistranslated
const protectMap: Record<string, string> = {
  "Даша": "__NAME_DASHA__",
  "Dasha": "__NAME_DASHA_LAT__",
  "Omar": "__NAME_OMAR__",
  "amore": "__AMORE__",
  "tesoro": "__TESORO__",
};
const protect = (t: string) =>
  Object.entries(protectMap).reduce((s, [k, v]) => s.replaceAll(k, v), t);
const unprotect = (t: string) =>
  Object.entries(protectMap).reduce((s, [k, v]) => s.replaceAll(v, k), t);

// one REST call to DeepL
async function deeplTranslateREST(params: URLSearchParams, authKey: string) {
  const baseUrl = authKey.endsWith(":fx")
    ? "https://api-free.deepl.com/v2/translate"
    : "https://api.deepl.com/v2/translate";

  const resp = await fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const json = await resp.json();
  if (!resp.ok) {
    throw new Error(json?.message || JSON.stringify(json));
  }

  const first = json?.translations?.[0];
  return {
    out: first?.text as string,
    detected: first?.detected_source_language as string | undefined,
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const text = (body?.text ?? "").toString().trim();
    if (!text) {
      return NextResponse.json({ error: "text required" }, { status: 400 });
    }

    // Inputs
    const myLang = (body?.myLang ?? "auto") as string; // "en" | "it" | "ru" | "auto"
    const targetLang = (body?.targetLang ?? "ru") as string; // "EN" | "EN-GB" | "EN-US" | "IT" | "RU"
    const tone = (body?.tone ?? "neutral") as "neutral" | "affectionate";

    const authKey = need("DEEPL_AUTH_KEY");

    // Build params
    const params = new URLSearchParams();
    params.append("auth_key", authKey);
    params.append("text", protect(text));

    // normalize target
    const tgt = targetLang.toUpperCase();
    params.append(
      "target_lang",
      ["EN", "EN-GB", "EN-US", "IT", "RU"].includes(tgt) ? tgt : "EN"
    );

    // Decide source
    let firstSource: string | undefined;
    if (myLang !== "auto") {
      firstSource = myLang.toUpperCase(); // EN | IT | RU
    } else if (isShortOrOneWord(text)) {
      // DeepL warns short texts can be misdetected → pick smart guess
      firstSource = hasCyrillic(text) ? "RU" : looksItalian(text) ? "IT" : "EN";
    }
    if (firstSource) params.append("source_lang", firstSource);

    // First attempt
    let { out, detected } = await deeplTranslateREST(params, authKey);
    let translated = unprotect(out || "");

    // If unchanged, retry with RU -> IT -> EN
    if (translated.trim().toLowerCase() === text.trim().toLowerCase()) {
      const tried = new Set<string>(firstSource ? [firstSource] : []);
      for (const fb of ["RU", "IT", "EN"]) {
        if (tried.has(fb)) continue;

        const retryParams = new URLSearchParams(params);
        retryParams.delete("source_lang");
        retryParams.append("source_lang", fb);

        const r = await deeplTranslateREST(retryParams, authKey);
        const candidate = unprotect(r.out || "");
        if (candidate.trim().toLowerCase() !== text.trim().toLowerCase()) {
          translated = candidate;
          detected = r.detected;
          break;
        }
      }
    }

    // Add affectionate prefix
    if (tone === "affectionate") {
      if (tgt.startsWith("RU")) translated = `любимая, ${translated}`;
      if (tgt.startsWith("EN")) translated = `darling, ${translated}`;
      if (tgt.startsWith("IT")) translated = `amore, ${translated}`;
    }

    return NextResponse.json({
      version: "deepl-rest-v2",
      original: text,
      translated,
      detectedSource: detected,
      provider: "deepl-rest",
    });
  } catch (e: any) {
    return NextResponse.json(
      {
        error: "Translation failed",
        detail: e?.message || String(e),
        version: "deepl-rest-v2",
      },
      { status: 500 }
    );
  }
}
