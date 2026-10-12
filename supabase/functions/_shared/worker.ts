// Obrađuje red čekanja: poziva AI sisteme, čuva trag (pretrage → izvori → citati) i analizira pominjanja.
// Sam sebe ponovo poziva (preko /api sa x-worker-key) dok ima posla.
import { createClient } from "npm:@supabase/supabase-js@2";
import { RUNNERS } from "./providers.ts";
import { MARKETS, Provider } from "./types.ts";
import { analyzeResponse, storeResult } from "./store.ts";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(URL_, KEY, { auth: { persistSession: false } });
const BATCH = Number(Deno.env.get("WORKER_BATCH") ?? "6");

async function processOne(r: any) {
  const { data: p } = await db.from("prompts").select("text").eq("id", r.prompt_id).single();
  const market = MARKETS[r.market] ?? MARKETS.RS;
  const t0 = Date.now();
  try {
    const res = await RUNNERS[r.provider as Provider](p!.text, market);
    await storeResult(db, r.id, res, Date.now() - t0);
    if (!res.empty) await analyzeResponse(db, r.id);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 1000);
    console.error(r.provider, r.id, msg);
    // 429/5xx: vrati u red (najviše 3 pokušaja), ostalo je greška
    const retry = /^(429|5\d\d)|abort|timed out/i.test(msg) && r.attempts < 3;
    await db.from("responses").update({ status: retry ? "pending" : "error", error: msg, latency_ms: Date.now() - t0 }).eq("id", r.id);
  }
}

async function loop() {
  const { data: batch, error } = await db.rpc("claim_responses", { batch: BATCH });
  if (error) {
    console.error("claim", error);
    return;
  }
  if (!batch?.length) return;
  await Promise.all(batch.map(processOne));
  for (const run of new Set(batch.map((b: any) => b.run_id))) await db.rpc("finish_run_if_done", { p_run: run });
  // još posla? pozovi novu instancu (izbegava limit trajanja jedne funkcije)
  const { count } = await db.from("responses").select("id", { count: "exact", head: true }).eq("status", "pending");
  if (count && count > 0) {
    // ako je neko dobio 429, sačekaj malo pre sledećeg talasa
    const { count: retries } = await db.from("responses").select("id", { count: "exact", head: true }).eq("status", "pending").gt("attempts", 0);
    if (retries) await new Promise((r) => setTimeout(r, 15_000));
    await kick();
  }
}

export async function kick() {
  await fetch(`${URL_}/functions/v1/api`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-worker-key": KEY, authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ mode: "process" }),
  }).then((r) => r.body?.cancel()).catch((e) => console.error("kick", e));
}

async function reanalyze(workspaceId: string, runId?: string) {
  let q = db.from("responses").select("id").eq("workspace_id", workspaceId).eq("status", "done");
  if (runId) q = q.eq("run_id", runId);
  const { data } = await q;
  const ids = (data ?? []).map((x: any) => x.id);
  for (let i = 0; i < ids.length; i += 8) {
    await Promise.all(ids.slice(i, i + 8).map((id: string) => analyzeResponse(db, id).catch((e) => console.error("reanalyze", id, e))));
  }
}

export const WORKER_KEY = KEY;

export function handleWorker(body: any): Response {
  const job = body.mode === "reanalyze" ? reanalyze(body.workspace_id, body.run_id) : loop();
  // @ts-ignore EdgeRuntime postoji u Supabase okruženju
  EdgeRuntime.waitUntil(job);
  return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "content-type": "application/json" } });
}
