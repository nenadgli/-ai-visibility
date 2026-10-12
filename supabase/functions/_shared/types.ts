export type Provider = "chatgpt" | "claude" | "gemini" | "perplexity" | "google_aio";

export interface NormSource {
  url: string;
  title?: string | null;
  snippet?: string | null;
  query_idx?: number | null;   // index u queries[] iz koje pretrage je izvor stigao
  retrieved_rank?: number | null;
}

export interface NormCitation {
  url: string;
  title?: string | null;
  start_index?: number | null;
  end_index?: number | null;
  answer_text?: string | null; // deo odgovora koji se oslanja na izvor
  cited_text?: string | null;  // deo izvora (ako ga API daje)
}

export interface NormResult {
  model: string;
  answer: string;
  used_search: boolean;
  queries: string[];           // fan-out pretrage
  sources: NormSource[];       // sve što je pročitano
  citations: NormCitation[];   // šta je citirano i gde
  usage?: unknown;
  raw?: unknown;
  empty?: boolean;             // npr. Google nije prikazao AI Overview
}

export interface Market {
  code: string;
  country: string;
  city: string;
  region?: string;
  timezone: string;
  hl: string;        // jezik za Google
  gl: string;        // zemlja za Google
  google_domain: string;
}

export const MARKETS: Record<string, Market> = {
  RS: { code: "RS", country: "RS", city: "Belgrade", region: "Belgrade", timezone: "Europe/Belgrade", hl: "sr", gl: "rs", google_domain: "google.rs" },
  HR: { code: "HR", country: "HR", city: "Zagreb", region: "Zagreb", timezone: "Europe/Zagreb", hl: "hr", gl: "hr", google_domain: "google.hr" },
  BA: { code: "BA", country: "BA", city: "Sarajevo", region: "Sarajevo", timezone: "Europe/Sarajevo", hl: "bs", gl: "ba", google_domain: "google.ba" },
  EN: { code: "EN", country: "US", city: "New York", region: "New York", timezone: "America/New_York", hl: "en", gl: "us", google_domain: "google.com" },
};

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  } catch {
    return "";
  }
}

export function cleanUrl(url: string): string {
  try {
    const u = new URL(url);
    // OpenAI dodaje utm_source=openai; uklanjamo tracking parametre radi deduplikacije
    for (const k of [...u.searchParams.keys()]) {
      if (/^utm_|^gclid$|^fbclid$|^srsltid$/i.test(k)) u.searchParams.delete(k);
    }
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}
