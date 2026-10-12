import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useApp } from "../lib/ctx";
import { supabase } from "../lib/supabase";
import { Filters, NoData, PV } from "../components/Filters";

interface Row {
  id: string; provider: string; market: string; sample: number; status: string; error: string | null; search_count: number | null;
  prompts: { text: string } | null;
  mentions: { rank: number; sentiment: string | null; brands: { name: string; is_own: boolean } | null }[];
  sources: { cited: boolean }[];
}

export default function Responses() {
  const { ws, runId, market } = useApp();
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const provider = sp.get("provider");
  const promptId = sp.get("prompt");
  const ownFilter = sp.get("own"); // "yes" | "no"
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ws) return;
    setLoading(true);
    let q = supabase.from("responses")
      .select("id,provider,market,sample,status,error,search_count,prompts(text),mentions(rank,sentiment,brands(name,is_own)),sources(cited)")
      .eq("workspace_id", ws.id).order("created_at", { ascending: false }).limit(500);
    if (runId) q = q.eq("run_id", runId);
    if (market) q = q.eq("market", market);
    if (provider) q = q.eq("provider", provider);
    if (promptId) q = q.eq("prompt_id", promptId);
    q.then(({ data }) => { setRows((data as any) ?? []); setLoading(false); });
  }, [ws, runId, market, provider, promptId]);

  const set = (k: string, v: string | null) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n); };
  const shown = rows.filter((r) => {
    const has = r.mentions.some((m) => m.brands?.is_own);
    return ownFilter === "yes" ? has : ownFilter === "no" ? !has && r.status === "done" : true;
  });

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Odgovori i trag</h1>
          <p>Svaki odgovor sa pretragama koje je AI pokrenuo, stranicama koje je pročitao i delovima koje je citirao. Otvorite red da vidite ceo put.</p>
        </div>
        <div className="filters">
          <Filters provider={provider} setProvider={(p) => set("provider", p)} />
          <select aria-label="Vaš brend" value={ownFilter ?? ""} onChange={(e) => set("own", e.target.value || null)}>
            <option value="">Sa i bez vašeg brenda</option>
            <option value="yes">Samo gde je pomenut</option>
            <option value="no">Samo gde nije pomenut</option>
          </select>
          {promptId && <button className="btn ghost" onClick={() => set("prompt", null)}>Svi upiti</button>}
        </div>
      </div>
      {loading ? <p className="muted">Učitavanje…</p> : !shown.length ? <NoData /> : (
        <div className="panel tablewrap" style={{ padding: 0 }}>
          <table>
            <thead><tr><th>Upit</th><th>AI sistem</th><th>Pomenuti brendovi</th><th className="num">Pretraga</th><th className="num">Citirano</th><th>Status</th></tr></thead>
            <tbody>
              {shown.map((r) => {
                const ms = [...r.mentions].sort((a, b) => a.rank - b.rank);
                return (
                  <tr key={r.id} className="click" onClick={() => nav(`/odgovori/${r.id}`)}>
                    <td style={{ maxWidth: 380 }}>{r.prompts?.text}<span className="faint small"> ({r.market}{r.sample > 1 ? `, ponavljanje ${r.sample}` : ""})</span></td>
                    <td><PV p={r.provider} /></td>
                    <td>
                      {ms.length ? ms.map((m, i) => (
                        <span key={i} className={"tag" + (m.brands?.is_own ? " own" : "") + (m.sentiment === "negative" ? " neg" : "")}>{m.rank}. {m.brands?.name}</span>
                      )) : r.status === "done" ? <span className="faint small">nijedan praćeni</span> : null}
                    </td>
                    <td className="num">{r.search_count ?? "—"}</td>
                    <td className="num">{r.sources.filter((s) => s.cited).length || "—"}</td>
                    <td className="small">
                      {r.status === "done" ? "gotovo" : r.status === "empty" ? <span className="muted">Google nije prikazao AI odgovor</span> : r.status === "error" ? <span className="err" title={r.error ?? ""}>greška</span> : <span className="muted">u obradi</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
