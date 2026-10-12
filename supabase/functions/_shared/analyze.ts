export interface Brand {
  id: string;
  name: string;
  aliases: string[];
  domains: string[];
  is_own: boolean;
}

export interface MentionHit {
  brand_id: string;
  mention_count: number;
  first_pos: number;
  rank: number;
  linked: boolean;
  context: string;
  sentiment?: string | null;
  recommended?: boolean | null;
  reasons?: string[] | null;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// srpski/hrvatski padeži: Zara → Zare, Zaru; Nike → Nike-a; Fashion&Friends-u
const SUFFIX = "(?:-?(?:a|e|u|i|o|om|em|ov|ova|ove|ovu|ovi|in|ina|ine|inu|ima))?";

function termRegex(term: string): RegExp {
  // razmaci/& u nazivu su fleksibilni: "Fashion & Friends" = "Fashion&Friends" = "Fashion and Friends"
  const body = term.trim().split(/\s*&\s*|\s+and\s+|\s+i\s+/i).map((p) => esc(p).replace(/\s+/g, "[\\s-]*")).join("\\s*(?:&|and|i|n)\\s*");
  const t = term.trim();
  const suffix = t.length >= 4 ? SUFFIX : "";
  let alt = `${body}${suffix}`;
  // ženski rod na -a: Zara → Zare, Zari, Zaru, Zarom (osnova bez -a)
  if (t.length >= 4 && /\p{L}a$/iu.test(t) && !/\s/.test(t)) {
    alt = `(?:${alt}|${esc(t.slice(0, -1))}(?:e|i|u|om|ama))`;
  }
  return new RegExp(`(?<![\\p{L}\\p{N}])${alt}(?![\\p{L}\\p{N}])`, "giu");
}

function sentenceAt(text: string, pos: number): string {
  const s = Math.max(text.lastIndexOf(".", pos - 1), text.lastIndexOf("\n", pos - 1)) + 1;
  let e = text.length;
  for (const ch of [".", "\n"]) {
    const i = text.indexOf(ch, pos);
    if (i >= 0 && i < e) e = i + 1;
  }
  return text.slice(s, e).trim().slice(0, 400);
}

export function detectMentions(answer: string, brands: Brand[], citedDomains: Set<string>): MentionHit[] {
  const hits: Omit<MentionHit, "rank">[] = [];
  for (const b of brands) {
    const terms = [b.name, ...b.aliases].filter((t) => t && t.trim().length >= 2);
    let count = 0;
    let first = Infinity;
    for (const t of terms) {
      for (const m of answer.matchAll(termRegex(t))) {
        count++;
        if (m.index! < first) first = m.index!;
      }
    }
    // domen brenda u tekstu (npr. "fashionandfriends.com") se takođe računa
    for (const d of b.domains) {
      const i = answer.toLowerCase().indexOf(d.toLowerCase());
      if (i >= 0) {
        count++;
        first = Math.min(first, i);
      }
    }
    const linked = b.domains.some((d) => [...citedDomains].some((cd) => cd === d || cd.endsWith("." + d)));
    if (count > 0) hits.push({ brand_id: b.id, mention_count: count, first_pos: first, linked, context: sentenceAt(answer, first) });
  }
  hits.sort((a, b) => a.first_pos - b.first_pos);
  return hits.map((h, i) => ({ ...h, rank: i + 1 }));
}

// LLM procena: sentiment, preporuka, razlozi + brendovi koje ne pratimo
export async function judge(answer: string, prompt: string, brands: Brand[], hits: MentionHit[]): Promise<{ hits: MentionHit[]; discovered: string[] }> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key || !answer.trim()) return { hits, discovered: [] };
  const model = Deno.env.get("ANALYSIS_MODEL") ?? "gemini-2.5-flash";
  const mentioned = hits.map((h) => brands.find((b) => b.id === h.brand_id)!.name);
  const known = brands.flatMap((b) => [b.name, ...b.aliases]);
  const instr = `Analiziraš odgovor AI asistenta na pitanje korisnika. Vrati JSON.
Pitanje: ${prompt}
Brendovi koje pratimo i koji se pominju: ${JSON.stringify(mentioned)}
Svi praćeni nazivi (ne ponavljaj ih u other_brands): ${JSON.stringify(known)}

Za svaki pomenuti brend odredi:
- sentiment: "positive" | "neutral" | "negative" | "mixed" (kako je brend predstavljen)
- recommended: true ako odgovor brend aktivno preporučuje korisniku
- reasons: do 4 kratka razloga/atributa zbog kojih AI pominje brend (npr. "povoljne cene", "širok izbor", "brza dostava"), na srpskom
other_brands: ostali nazivi prodavnica/brendova/sajtova koji se preporučuju ili pominju u odgovoru (samo nazivi, bez duplikata).

Odgovor:
"""${answer.slice(0, 12000)}"""`;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: instr }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0,
          responseSchema: {
            type: "OBJECT",
            properties: {
              brands: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    name: { type: "STRING" },
                    sentiment: { type: "STRING", enum: ["positive", "neutral", "negative", "mixed"] },
                    recommended: { type: "BOOLEAN" },
                    reasons: { type: "ARRAY", items: { type: "STRING" } },
                  },
                  required: ["name", "sentiment", "recommended"],
                },
              },
              other_brands: { type: "ARRAY", items: { type: "STRING" } },
            },
            required: ["brands", "other_brands"],
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const txt = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? "{}";
    const out = JSON.parse(txt);
    const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const knownN = new Set(known.map(norm));
    for (const h of hits) {
      const b = brands.find((x) => x.id === h.brand_id)!;
      const names = new Set([b.name, ...b.aliases].map(norm));
      const j = (out.brands ?? []).find((x: any) => names.has(norm(x.name ?? "")));
      if (j) {
        h.sentiment = j.sentiment;
        h.recommended = !!j.recommended;
        h.reasons = (j.reasons ?? []).slice(0, 4);
      }
    }
    const discovered = [...new Set<string>((out.other_brands ?? []).map((s: string) => s.trim()).filter((s: string) => s && !knownN.has(norm(s))))].slice(0, 25);
    return { hits, discovered };
  } catch (e) {
    console.error("judge failed", e);
    return { hits, discovered: [] };
  }
}
