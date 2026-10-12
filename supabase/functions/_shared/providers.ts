import { Market, NormCitation, NormResult, NormSource, Provider } from "./types.ts";

const env = (k: string, d?: string) => Deno.env.get(k) ?? d ?? "";

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs = 140_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 600)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// ChatGPT — OpenAI Responses API + web_search
export async function runChatGPT(prompt: string, m: Market): Promise<NormResult> {
  const model = env("OPENAI_MODEL", "gpt-5.5");
  const data = await postJson("https://api.openai.com/v1/responses", {
    authorization: `Bearer ${env("OPENAI_API_KEY")}`,
  }, {
    model,
    input: prompt,
    tools: [{
      type: "web_search",
      user_location: { type: "approximate", country: m.country, city: m.city, region: m.region, timezone: m.timezone },
    }],
    include: ["web_search_call.action.sources"],
  });

  const queries: string[] = [];
  const sources: NormSource[] = [];
  const citations: NormCitation[] = [];
  let answer = "";
  let searched = false;

  for (const item of data.output ?? []) {
    if (item.type === "web_search_call") {
      searched = true;
      const a = item.action ?? {};
      if (a.type === "search") {
        const qs: string[] = a.queries?.length ? a.queries : a.query ? [a.query] : [];
        for (const q of qs) {
          if (!queries.includes(q)) queries.push(q);
        }
        const qi = qs.length ? queries.indexOf(qs[0]) : null;
        (a.sources ?? []).forEach((s: any, i: number) => {
          if (s.url) sources.push({ url: s.url, title: s.title ?? null, query_idx: qi, retrieved_rank: i + 1 });
        });
      } else if (a.type === "open_page" && a.url) {
        sources.push({ url: a.url, title: null, query_idx: null, retrieved_rank: null });
      }
    }
    if (item.type === "message") {
      for (const c of item.content ?? []) {
        if (c.type !== "output_text") continue;
        const offset = answer.length;
        answer += c.text;
        for (const an of c.annotations ?? []) {
          if (an.type !== "url_citation") continue;
          const s = offset + (an.start_index ?? 0), e = offset + (an.end_index ?? 0);
          citations.push({
            url: an.url, title: an.title, start_index: s, end_index: e,
            answer_text: sentenceBefore(answer, s),
          });
        }
      }
    }
  }
  return { model: data.model ?? model, answer, used_search: searched, queries, sources, citations, usage: data.usage, raw: data };
}

// ---------------------------------------------------------------------------
// Claude — Messages API + web_search server tool
export async function runClaude(prompt: string, m: Market): Promise<NormResult> {
  const model = env("CLAUDE_MODEL", "claude-sonnet-5-5");
  const tool = {
    type: env("CLAUDE_SEARCH_TOOL", "web_search_20250305"),
    name: "web_search",
    max_uses: 8,
    user_location: { type: "approximate", country: m.country, city: m.city, region: m.region, timezone: m.timezone },
    ...(env("CLAUDE_SEARCH_TOOL", "web_search_20250305") !== "web_search_20250305" ? { allowed_callers: ["direct"] } : {}),
  };
  const messages: any[] = [{ role: "user", content: prompt }];
  const blocks: any[] = [];
  let data: any;
  let usage: any[] = [];
  // pause_turn: Claude može da prekine dugu pretragu — nastavljamo do 3 puta
  for (let i = 0; i < 3; i++) {
    data = await postJson("https://api.anthropic.com/v1/messages", {
      "x-api-key": env("ANTHROPIC_API_KEY"),
      "anthropic-version": "2023-06-01",
    }, { model, max_tokens: 4096, messages, tools: [tool] });
    blocks.push(...(data.content ?? []));
    usage.push(data.usage);
    if (data.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: data.content });
  }

  const queries: string[] = [];
  const toolIdx = new Map<string, number>();
  const sources: NormSource[] = [];
  const citations: NormCitation[] = [];
  let answer = "";

  for (const b of blocks) {
    if (b.type === "server_tool_use" && b.name === "web_search") {
      const q = b.input?.query;
      if (q) {
        queries.push(q);
        toolIdx.set(b.id, queries.length - 1);
      }
    } else if (b.type === "web_search_tool_result") {
      const qi = toolIdx.get(b.tool_use_id) ?? null;
      if (Array.isArray(b.content)) {
        b.content.forEach((r: any, i: number) => {
          if (r.url) sources.push({ url: r.url, title: r.title, snippet: r.page_age ? `page_age: ${r.page_age}` : null, query_idx: qi, retrieved_rank: i + 1 });
        });
      }
    } else if (b.type === "text") {
      const s = answer.length;
      answer += b.text;
      for (const c of b.citations ?? []) {
        if (c.type !== "web_search_result_location") continue;
        citations.push({
          url: c.url, title: c.title, start_index: s, end_index: answer.length,
          answer_text: b.text.trim().slice(0, 500), cited_text: c.cited_text,
        });
      }
    }
  }
  return {
    model: data?.model ?? model, answer, used_search: queries.length > 0, queries, sources, citations,
    usage, raw: { content: blocks, stop_reason: data?.stop_reason },
  };
}

// ---------------------------------------------------------------------------
// Gemini — generateContent + google_search grounding
export async function runGemini(prompt: string, _m: Market): Promise<NormResult> {
  const model = env("GEMINI_MODEL", "gemini-3-flash-preview");
  const data = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    { "x-goog-api-key": env("GEMINI_API_KEY") },
    { contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ google_search: {} }] },
  );
  const cand = data.candidates?.[0] ?? {};
  const answer = (cand.content?.parts ?? []).filter((p: any) => p.text && !p.thought).map((p: any) => p.text).join("");
  const gm = cand.groundingMetadata ?? {};
  const queries: string[] = gm.webSearchQueries ?? [];
  const chunks: any[] = gm.groundingChunks ?? [];

  // Gemini vraća redirect linkove (vertexaisearch...) — razrešavamo ih u prave URL-ove
  const resolved = await Promise.all(chunks.map((c) => resolveRedirect(c.web?.uri ?? "")));
  const sources: NormSource[] = chunks.map((c, i) => ({
    url: resolved[i] || c.web?.uri,
    title: c.web?.title ?? null,       // obično domen
    query_idx: null,
    retrieved_rank: i + 1,
  })).filter((s) => s.url);

  const citations: NormCitation[] = [];
  for (const sup of gm.groundingSupports ?? []) {
    const segText: string = sup.segment?.text ?? "";
    // indeksi su u bajtovima; tražimo tekst segmenta da dobijemo pozicije u karakterima
    const pos = segText ? answer.indexOf(segText) : -1;
    for (const ci of sup.groundingChunkIndices ?? []) {
      const s = sources[ci];
      if (!s) continue;
      citations.push({
        url: s.url, title: s.title, start_index: pos >= 0 ? pos : null,
        end_index: pos >= 0 ? pos + segText.length : null, answer_text: segText.slice(0, 500),
      });
    }
  }
  return { model: data.modelVersion ?? model, answer, used_search: queries.length > 0 || chunks.length > 0, queries, sources, citations, usage: data.usageMetadata, raw: data };
}

async function resolveRedirect(uri: string): Promise<string> {
  if (!uri || !uri.includes("grounding-api-redirect")) return uri;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(uri, { method: "GET", redirect: "manual", signal: ctrl.signal });
    clearTimeout(t);
    await r.body?.cancel();
    return r.headers.get("location") ?? uri;
  } catch {
    return uri;
  }
}

// ---------------------------------------------------------------------------
// Perplexity — Sonar
export async function runPerplexity(prompt: string, m: Market): Promise<NormResult> {
  const model = env("PERPLEXITY_MODEL", "sonar-pro");
  const data = await postJson("https://api.perplexity.ai/chat/completions", {
    authorization: `Bearer ${env("PERPLEXITY_API_KEY")}`,
  }, {
    model,
    messages: [{ role: "user", content: prompt }],
    web_search_options: { user_location: { country: m.country, city: m.city, region: m.region } },
  });
  let answer: string = data.choices?.[0]?.message?.content ?? "";
  // reasoning modeli vraćaju <think>...</think>
  answer = answer.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const results: any[] = data.search_results ?? (data.citations ?? []).map((u: string) => ({ url: u }));
  const sources: NormSource[] = results.map((r, i) => ({
    url: r.url, title: r.title ?? null, snippet: r.snippet ?? (r.date ? `date: ${r.date}` : null), query_idx: null, retrieved_rank: i + 1,
  }));
  const citations: NormCitation[] = [];
  const re = /\[(\d{1,2})\]/g;
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(answer))) {
    const s = sources[Number(mt[1]) - 1];
    if (!s) continue;
    citations.push({ url: s.url, title: s.title, start_index: mt.index, end_index: mt.index + mt[0].length, answer_text: sentenceBefore(answer, mt.index) });
  }
  const queries: string[] = data.search_queries ?? data.queries ?? [];
  return { model: data.model ?? model, answer, used_search: sources.length > 0, queries, sources, citations, usage: data.usage, raw: data };
}

// ---------------------------------------------------------------------------
// Google AI Overviews — preko SerpApi
export async function runGoogleAIO(prompt: string, m: Market): Promise<NormResult> {
  const key = env("SERPAPI_API_KEY");
  const qs = new URLSearchParams({ engine: "google", q: prompt, gl: m.gl, hl: m.hl, google_domain: m.google_domain, api_key: key });
  let data = await getJson(`https://serpapi.com/search.json?${qs}`);
  let aio = data.ai_overview;
  if (aio?.page_token && !aio.text_blocks) {
    const d2 = await getJson(`https://serpapi.com/search.json?${new URLSearchParams({ engine: "google_ai_overview", page_token: aio.page_token, api_key: key })}`);
    aio = d2.ai_overview ?? aio;
  }
  const sources: NormSource[] = [];
  const citations: NormCitation[] = [];
  // organski rezultati = šta Google rangira; poredimo sa onim što AIO citira
  (data.organic_results ?? []).slice(0, 10).forEach((o: any, i: number) => {
    if (o.link) sources.push({ url: o.link, title: o.title, snippet: o.snippet, query_idx: 0, retrieved_rank: i + 1 });
  });
  if (!aio || !aio.text_blocks?.length) {
    return { model: "google-ai-overview", answer: "", used_search: true, queries: [prompt], sources, citations, raw: { search_metadata: data.search_metadata, ai_overview: aio ?? null }, empty: true };
  }
  const refs: any[] = aio.references ?? [];
  for (const r of refs) {
    if (r.link && !sources.some((s) => s.url === r.link)) sources.push({ url: r.link, title: r.title, snippet: r.snippet, query_idx: 0, retrieved_rank: null });
  }
  let answer = "";
  const addBlock = (b: any, prefix = "") => {
    const text = [b.title, b.snippet].filter(Boolean).join(" ");
    const s = answer.length;
    if (text) answer += prefix + text + "\n";
    for (const ri of b.reference_indexes ?? []) {
      const r = refs.find((x) => x.index === ri) ?? refs[ri];
      if (r?.link) {
        citations.push({ url: r.link, title: r.title, start_index: s, end_index: answer.length, answer_text: text.slice(0, 500), cited_text: textFragment(r.link) });
      }
    }
    for (const li of b.list ?? []) addBlock(li, "• ");
    for (const tb of b.text_blocks ?? []) addBlock(tb);
  };
  for (const b of aio.text_blocks) addBlock(b);
  return { model: "google-ai-overview", answer: answer.trim(), used_search: true, queries: [prompt], sources, citations, raw: { search_metadata: data.search_metadata, ai_overview: aio } };
}

async function getJson(url: string) {
  const r = await fetch(url);
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 400)}`);
  return JSON.parse(t);
}

// Google linkovi često sadrže #:~:text= — tačno parče teksta koje je AI koristio
function textFragment(url: string): string | null {
  const i = url.indexOf("#:~:text=");
  if (i < 0) return null;
  try {
    return decodeURIComponent(url.slice(i + 9).split("&")[0]).replace(/,/g, " … ");
  } catch {
    return null;
  }
}

function sentenceBefore(text: string, pos: number): string {
  const before = text.slice(0, pos);
  const start = Math.max(before.lastIndexOf(". "), before.lastIndexOf("\n"), 0);
  return before.slice(start).replace(/^[.\s]+/, "").trim().slice(-500);
}

export const RUNNERS: Record<Provider, (p: string, m: Market) => Promise<NormResult>> = {
  chatgpt: runChatGPT,
  claude: runClaude,
  gemini: runGemini,
  perplexity: runPerplexity,
  google_aio: runGoogleAIO,
};

export const PROVIDER_KEYS: Record<Provider, string> = {
  chatgpt: "OPENAI_API_KEY",
  claude: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  google_aio: "SERPAPI_API_KEY",
};
