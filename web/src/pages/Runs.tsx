import { useEffect, useState } from "react";
import { useApp } from "../lib/ctx";
import { api, fmtDate, pLabel, PROVIDERS, supabase } from "../lib/supabase";

type Counts = Record<string, Record<string, number>>; // run_id → status → n

export default function Runs() {
  const { ws, runs, reloadRuns, setRunId } = useApp();
  const [configured, setConfigured] = useState<string[] | null>(null);
  const [analysis, setAnalysis] = useState(true);
  const [sel, setSel] = useState<string[]>([]);
  const [samples, setSamples] = useState(1);
  const [note, setNote] = useState("");
  const [activePrompts, setActivePrompts] = useState(0);
  const [counts, setCounts] = useState<Counts>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    api<{ configured: string[]; analysis: boolean }>({ action: "status" })
      .then((s) => { setConfigured(s.configured); setAnalysis(s.analysis); setSel(s.configured); })
      .catch((e) => { setConfigured([]); setMsg(e.message); });
  }, []);
  useEffect(() => {
    if (!ws) return;
    supabase.from("prompts").select("id", { count: "exact", head: true }).eq("workspace_id", ws.id).eq("active", true).then(({ count }) => setActivePrompts(count ?? 0));
  }, [ws]);

  async function loadCounts() {
    const ids = runs.slice(0, 15).map((r) => r.id);
    if (!ids.length) return;
    const { data } = await supabase.from("responses").select("run_id,status").in("run_id", ids).limit(10000);
    const c: Counts = {};
    for (const r of data ?? []) { c[r.run_id] ??= {}; c[r.run_id][r.status] = (c[r.run_id][r.status] ?? 0) + 1; }
    setCounts(c);
  }
  useEffect(() => { loadCounts(); }, [runs]); // eslint-disable-line

  // osvežavanje dok traje pokretanje
  const running = runs.some((r) => r.status === "running");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => { loadCounts(); reloadRuns(); }, 4000);
    return () => clearInterval(t);
  }, [running]); // eslint-disable-line

  async function start() {
    if (!ws) return;
    setBusy(true); setMsg("");
    try {
      const r = await api<{ run_id: string; jobs: number }>({ action: "start_run", workspace_id: ws.id, providers: sel, samples, note: note || null });
      setMsg(`Pokrenuto: ${r.jobs} odgovora u redu za obradu.`);
      await reloadRuns();
      setRunId(r.run_id);
    } catch (e: any) { setMsg(e.message); }
    setBusy(false);
  }
  async function retry(runId: string) {
    await api({ action: "retry_errors", run_id: runId });
    reloadRuns();
  }
  async function removeRun(id: string) {
    if (!confirm("Obrisati ovo pokretanje i sve njegove odgovore?")) return;
    await supabase.from("runs").delete().eq("id", id);
    setRunId(null);
    reloadRuns();
  }
  async function reanalyze() {
    if (!ws) return;
    await api({ action: "reanalyze", workspace_id: ws.id });
    setMsg("Ponovna analiza pokrenuta. Rezultati se osvežavaju za minut-dva.");
  }

  const jobs = activePrompts * sel.length * samples;

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Pokretanja</h1>
          <p>Jedno pokretanje postavlja sve aktivne upite izabranim AI sistemima. Odgovori se razlikuju iz puta u put, pa ponavljanje daje stabilniju sliku.</p>
        </div>
      </div>

      <section className="panel">
        <h2>Novo pokretanje</h2>
        <p className="sub">{activePrompts} aktivnih upita.</p>
        <div className="filters" style={{ marginBottom: 12 }}>
          {PROVIDERS.map((p) => {
            const ok = configured?.includes(p.id);
            return (
              <label key={p.id} className={"chk" + (ok ? "" : " off")} title={ok ? "" : "API ključ nije podešen"}>
                <input type="checkbox" disabled={!ok} checked={sel.includes(p.id)} onChange={(e) => setSel(e.target.checked ? [...sel, p.id] : sel.filter((x) => x !== p.id))} />
                {p.label}
              </label>
            );
          })}
        </div>
        <div className="filters">
          <label className="muted">Ponavljanja po upitu
            <select value={samples} onChange={(e) => setSamples(Number(e.target.value))} style={{ marginLeft: 8 }}>
              {[1, 2, 3, 5].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <input type="text" placeholder="Beleška (opciono)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn primary" onClick={start} disabled={busy || !jobs}>Pokreni {jobs} odgovora</button>
        </div>
        {configured && configured.length < PROVIDERS.length && (
          <p className="small muted" style={{ marginTop: 10 }}>Sistemi bez ključa: {PROVIDERS.filter((p) => !configured.includes(p.id)).map((p) => p.label).join(", ")}. Ključevi se dodaju u Supabase, Edge Functions, Secrets.</p>
        )}
        {!analysis && <p className="small err" style={{ marginTop: 6 }}>Nema GEMINI_API_KEY: brendovi se prepoznaju, ali bez procene tona i razloga.</p>}
        {msg && <p className="small" style={{ marginTop: 10 }}>{msg}</p>}
      </section>

      <section className="panel">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <h2>Istorija</h2>
          <button className="btn ghost small" onClick={reanalyze} title="Posle izmene brendova ili alijasa">Ponovo prepoznaj brendove</button>
        </div>
        {!runs.length ? <p className="muted">Još nema pokretanja.</p> : (
          <table>
            <thead><tr><th>Vreme</th><th>Sistemi</th><th>Napredak</th><th className="num">Gotovo</th><th className="num">Bez AI odgovora</th><th className="num">Greške</th><th></th></tr></thead>
            <tbody>
              {runs.map((r) => {
                const c = counts[r.id] ?? {};
                const total = Object.values(c).reduce((a, b) => a + b, 0);
                const fin = (c.done ?? 0) + (c.empty ?? 0) + (c.error ?? 0);
                return (
                  <tr key={r.id}>
                    <td>{fmtDate(r.created_at)}{r.note && <div className="small muted">{r.note}</div>}</td>
                    <td className="small">{r.providers.map(pLabel).join(", ")}{r.samples > 1 ? `, ${r.samples}×` : ""}</td>
                    <td style={{ minWidth: 140 }}>
                      <div className="progress"><i style={{ width: total ? `${(100 * fin) / total}%` : "0" }} /></div>
                      <div className="small muted">{r.status === "running" ? `${fin} od ${total}` : "završeno"}</div>
                    </td>
                    <td className="num">{c.done ?? 0}</td>
                    <td className="num">{c.empty ?? 0}</td>
                    <td className="num" style={{ color: c.error ? "var(--neg)" : undefined }}>{c.error ?? 0}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {c.error ? <button className="btn ghost small" onClick={() => retry(r.id)}>Ponovi greške</button> : null}
                      <button className="btn ghost small" onClick={() => removeRun(r.id)}>Obriši</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
