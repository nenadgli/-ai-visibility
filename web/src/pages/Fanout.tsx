import { useEffect, useMemo, useState } from "react";
import { useApp } from "../lib/ctx";
import { pLabel, rpc } from "../lib/supabase";
import { Filters, NoData } from "../components/Filters";

interface Q { query: string; times: number; providers: string[]; prompts: number; avg_sources: number | null }

const STOP = new Set("i u na za od do sa se je su da li ili a the of in for and to on with best najbolje najbolji najbolja koji koja koje gde kako šta sta što to 2024 2025 2026".split(" "));

export default function Fanout() {
  const { ws, runId, market } = useApp();
  const [provider, setProvider] = useState<string | null>(null);
  const [rows, setRows] = useState<Q[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ws) return;
    setLoading(true);
    rpc<Q>("get_fanout", { p_ws: ws.id, p_run: runId, p_provider: provider, p_market: market }).then((d) => { setRows(d); setLoading(false); });
  }, [ws, runId, market, provider]);

  // reči koje AI dodaje u pretrage: otkrivaju šta smatra bitnim (cena, recenzije, godina…)
  const terms = useMemo(() => {
    const c = new Map<string, number>();
    for (const r of rows) for (const w of r.query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (w.length < 3 || STOP.has(w)) continue;
      c.set(w, (c.get(w) ?? 0) + r.times);
    }
    return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
  }, [rows]);
  const years = useMemo(() => {
    const c = new Map<string, number>();
    for (const r of rows) for (const y of r.query.match(/\b20\d\d\b/g) ?? []) c.set(y, (c.get(y) ?? 0) + r.times);
    return [...c.entries()].sort();
  }, [rows]);
  const max = terms[0]?.[1] ?? 1;

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Šta AI pretražuje</h1>
          <p>Pre odgovora AI razbije pitanje na nekoliko pretraga (fan-out). Ove fraze pokazuju na koje stranice treba da rangirate da biste ušli u odgovor.</p>
        </div>
        <Filters provider={provider} setProvider={setProvider} />
      </div>
      {loading ? <p className="muted">Učitavanje…</p> : !rows.length ? <NoData /> : (
        <div className="stack">
          <section className="panel">
            <h2>Najčešće reči u pretragama</h2>
            <p className="sub">Veći tekst znači češće. {years.length ? `Godine u pretragama: ${years.map(([y, n]) => `${y} (${n})`).join(", ")}.` : ""}</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", alignItems: "baseline" }}>
              {terms.map(([w, n]) => (
                <span key={w} title={`${n}×`} style={{ fontSize: 12 + 14 * (n / max), fontWeight: n / max > 0.5 ? 600 : 400, color: n / max > 0.5 ? "var(--ink)" : "var(--muted)" }}>{w}</span>
              ))}
            </div>
          </section>
          <section className="panel tablewrap" style={{ padding: 0 }}>
            <table>
              <thead><tr><th>Pretraga</th><th className="num">Puta</th><th className="num">Upita</th><th className="num">Rezultata</th><th>Sistemi</th></tr></thead>
              <tbody>
                {rows.slice(0, 400).map((r) => (
                  <tr key={r.query}><td>{r.query}</td><td className="num">{r.times}</td><td className="num">{r.prompts}</td><td className="num">{r.avg_sources ?? "—"}</td><td className="small muted">{r.providers.map(pLabel).join(", ")}</td></tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </>
  );
}
