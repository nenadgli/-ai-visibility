import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { cleanUrl, domainOf, NormResult } from "./types.ts";
import { Brand, detectMentions, judge } from "./analyze.ts";

// Upisuje normalizovan rezultat: fan-out pretrage, izvore, citate
export async function storeResult(db: SupabaseClient, responseId: string, r: NormResult, latency: number) {
  await db.from("search_queries").delete().eq("response_id", responseId);
  await db.from("citations").delete().eq("response_id", responseId);
  await db.from("sources").delete().eq("response_id", responseId);

  if (r.queries.length) {
    await must(db.from("search_queries").insert(r.queries.map((q, idx) => ({ response_id: responseId, idx, query: q }))));
  }

  // spoji izvore po očišćenom URL-u
  const byUrl = new Map<string, any>();
  for (const s of r.sources) {
    const url = cleanUrl(s.url);
    if (!url || byUrl.has(url)) continue;
    byUrl.set(url, {
      response_id: responseId, url, domain: domainOf(url), title: s.title ?? null, snippet: s.snippet ?? null,
      query_idx: s.query_idx ?? null, retrieved_rank: s.retrieved_rank ?? null, cited: false, citation_count: 0, first_cited_pos: null,
    });
  }
  for (const c of r.citations) {
    const url = cleanUrl(c.url);
    let s = byUrl.get(url);
    if (!s) {
      // citiran, a nije bio među "pročitanim" (npr. ChatGPT bez include izvora)
      s = { response_id: responseId, url, domain: domainOf(url), title: c.title ?? null, snippet: null, query_idx: null, retrieved_rank: null, cited: false, citation_count: 0, first_cited_pos: null };
      byUrl.set(url, s);
    }
    s.cited = true;
    s.citation_count++;
    if (c.start_index != null && (s.first_cited_pos == null || c.start_index < s.first_cited_pos)) s.first_cited_pos = c.start_index;
  }
  const rows = [...byUrl.values()].filter((s) => s.domain);
  let ids = new Map<string, string>();
  if (rows.length) {
    const { data } = await must(db.from("sources").insert(rows).select("id,url"));
    ids = new Map((data ?? []).map((x: any) => [x.url, x.id]));
  }
  if (r.citations.length) {
    await must(db.from("citations").insert(r.citations.map((c) => ({
      response_id: responseId, source_id: ids.get(cleanUrl(c.url)) ?? null,
      start_index: c.start_index ?? null, end_index: c.end_index ?? null,
      answer_text: c.answer_text ?? null, cited_text: c.cited_text ?? null,
    }))));
  }

  await must(db.from("responses").update({
    status: r.empty ? "empty" : "done",
    model: r.model, answer: r.answer, used_search: r.used_search, search_count: r.queries.length,
    latency_ms: latency, usage: r.usage ?? null, raw: r.raw ?? null, error: null, completed_at: new Date().toISOString(),
  }).eq("id", responseId));
}

// Detekcija brendova + LLM procena; može se pustiti ponovo kad se promene brendovi
export async function analyzeResponse(db: SupabaseClient, responseId: string) {
  const { data: resp } = await must(db.from("responses").select("id,workspace_id,answer,prompt_id,prompts(text)").eq("id", responseId).single());
  if (!resp) return;
  const { data: brands } = await must(db.from("brands").select("id,name,aliases,domains,is_own").eq("workspace_id", resp.workspace_id));
  const { data: cited } = await must(db.from("sources").select("domain").eq("response_id", responseId).eq("cited", true));
  const citedDomains = new Set<string>((cited ?? []).map((x: any) => x.domain));
  const answer: string = resp.answer ?? "";
  const hits = detectMentions(answer, (brands ?? []) as Brand[], citedDomains);
  const { hits: judged, discovered } = await judge(answer, (resp as any).prompts?.text ?? "", (brands ?? []) as Brand[], hits);

  await db.from("mentions").delete().eq("response_id", responseId);
  if (judged.length) {
    await must(db.from("mentions").insert(judged.map((h) => ({ response_id: responseId, ...h }))));
  }
  await must(db.from("responses").update({ discovered_brands: discovered, analyzed_at: new Date().toISOString() }).eq("id", responseId));
}

async function must<T extends { error: any }>(q: PromiseLike<T>): Promise<T> {
  const r = await q;
  if (r.error) throw new Error(r.error.message ?? String(r.error));
  return r;
}
