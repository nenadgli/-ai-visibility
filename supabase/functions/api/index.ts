// Javni ulaz za frontend (zahteva ulogovanog korisnika):
//  { action: "status" }                                  → koji AI sistemi imaju ključ
//  { action: "start_run", workspace_id, providers, samples, prompt_ids? }
//  { action: "reanalyze", workspace_id, run_id? }       → ponovo prepoznaj brendove (posle izmene liste)
//  { action: "retry_errors", run_id }
import { createClient } from "npm:@supabase/supabase-js@2";
import { PROVIDER_KEYS } from "../_shared/providers.ts";
import { Provider } from "../_shared/types.ts";
import { handleWorker, WORKER_KEY } from "../_shared/worker.ts";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(URL_, KEY, { auth: { persistSession: false } });

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "content-type": "application/json" } });

const configured = () => (Object.keys(PROVIDER_KEYS) as Provider[]).filter((p) => !!Deno.env.get(PROVIDER_KEYS[p]));

async function callWorker(body: unknown) {
  await fetch(`${URL_}/functions/v1/api`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-worker-key": KEY, authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  }).then((r) => r.body?.cancel());
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  // interni poziv workera (self-chain)
  if (req.headers.get("x-worker-key")) {
    if (req.headers.get("x-worker-key") !== WORKER_KEY) return new Response("forbidden", { status: 403 });
    return handleWorker(await req.json().catch(() => ({})));
  }
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await db.auth.getUser(token);
  if (!u?.user) return json({ error: "Niste ulogovani" }, 401);

  const body = await req.json().catch(() => ({}));
  try {
    switch (body.action) {
      case "status":
        return json({ configured: configured(), analysis: !!Deno.env.get("GEMINI_API_KEY") });

      case "start_run": {
        const providers: Provider[] = (body.providers ?? []).filter((p: Provider) => configured().includes(p));
        if (!providers.length) return json({ error: "Nijedan izabrani AI sistem nema podešen API ključ" }, 400);
        const samples = Math.min(Math.max(Number(body.samples) || 1, 1), 5);
        let q = db.from("prompts").select("id,market").eq("workspace_id", body.workspace_id).eq("active", true);
        if (body.prompt_ids?.length) q = q.in("id", body.prompt_ids);
        const { data: prompts, error } = await q;
        if (error) throw error;
        if (!prompts?.length) return json({ error: "Nema aktivnih upita" }, 400);
        const { data: run, error: e2 } = await db.from("runs").insert({ workspace_id: body.workspace_id, providers, samples, note: body.note ?? null }).select().single();
        if (e2) throw e2;
        const rows = prompts.flatMap((p) => providers.flatMap((provider) =>
          Array.from({ length: samples }, (_, i) => ({ run_id: run.id, workspace_id: body.workspace_id, prompt_id: p.id, provider, market: p.market, sample: i + 1 }))));
        for (let i = 0; i < rows.length; i += 500) {
          const { error: e3 } = await db.from("responses").insert(rows.slice(i, i + 500));
          if (e3) throw e3;
        }
        await callWorker({ mode: "process" });
        return json({ run_id: run.id, jobs: rows.length });
      }

      case "retry_errors": {
        await db.from("responses").update({ status: "pending", attempts: 0, error: null }).eq("run_id", body.run_id).eq("status", "error");
        await db.from("runs").update({ status: "running", finished_at: null }).eq("id", body.run_id);
        await callWorker({ mode: "process" });
        return json({ ok: true });
      }

      case "reanalyze":
        await callWorker({ mode: "reanalyze", workspace_id: body.workspace_id, run_id: body.run_id });
        return json({ ok: true });

      default:
        return json({ error: "Nepoznata akcija" }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
