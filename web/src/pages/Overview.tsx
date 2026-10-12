import { useEffect, useMemo, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useApp } from "../lib/ctx";
import { fmtDate, pColor, pLabel, PROVIDERS, rpc } from "../lib/supabase";
import { Filters, NoData, PV } from "../components/Filters";

interface Vis { brand_id: string; brand: string; is_own: boolean; provider: string; responses: number; mentioned: number; mention_rate: number; avg_rank: number | null; top1: number; positive: number; negative: number; recommended: number; linked: number }
interface Proc { provider: string; responses: number; used_search_pct: number; avg_queries: number; avg_retrieved: number; avg_cited: number; avg_answer_len: number; avg_latency_ms: number }
interface Trend { run_id: string; run_at: string; provider: string; own_rate: number }
interface Disc { brand: string; times: number; providers: string[]; prompts: number }

export default function Overview() {
  const { ws, runId, market, brands } = useApp();
  const [vis, setVis] = useState<Vis[]>([]);
  const [proc, setProc] = useState<Proc[]>([]);
  const [trend, setTrend] = useState<Trend[]>([]);
  const [disc, setDisc] = useState<Disc[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ws) return;
    setLoading(true);
    const a = { p_ws: ws.id, p_run: runId, p_market: market };
    Promise.all([
      rpc<Vis>("get_visibility", a),
      rpc<Proc>("get_process_stats", a),
      rpc<Trend>("get_trend", { p_ws: ws.id, p_market: market }),
      rpc<Disc>("get_discovered_brands", a),
    ]).then(([v, p, t, d]) => { setVis(v); setProc(p); setTrend(t); setDisc(d); }).finally(() => setLoading(false));
  }, [ws, runId, market]);

  const providers = PROVIDERS.map((p) => p.id).filter((p) => vis.some((v) => v.provider === p));
  const rows = useMemo(() => {
    const by = new Map<string, { brand: string; is_own: boolean; cells: Record<string, Vis>; total: number; n: number }>();
    for (const v of vis) {
      const r = by.get(v.brand_id) ?? { brand: v.brand, is_own: v.is_own, cells: {}, total: 0, n: 0 };
      r.cells[v.provider] = v;
      r.total += v.mentioned;
      r.n += v.responses;
      by.set(v.brand_id, r);
    }
    return [...by.values()].sort((a, b) => Number(b.is_own) - Number(a.is_own) || b.total - a.total);
  }, [vis]);

  const trendData = useMemo(() => {
    const m = new Map<string, any>();
    for (const t of trend) {
      const row = m.get(t.run_id) ?? { label: fmtDate(t.run_at) };
      row[t.provider] = t.own_rate;
      m.set(t.run_id, row);
    }
    return [...m.values()];
  }, [trend]);

  const own = brands.find((b) => b.is_own);

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Koliko AI pominje {own?.name ?? "vaš brend"}</h1>
          <p>Udeo odgovora u kojima se brend pojavljuje, po AI sistemu. Klik na Odgovori i trag pokazuje kako je do svakog odgovora došlo.</p>
        </div>
        <Filters />
      </div>

      {!own && <div className="empty" style={{ marginBottom: 16 }}>Označite sopstveni brend na stranici Brendovi i klijenti da biste videli poređenje.</div>}

      {loading ? <p className="muted">Učitavanje…</p> : !rows.length || !providers.length ? <NoData /> : (
        <div className="stack">
          <section className="panel">
            <h2>Pominjanja po brendu i AI sistemu</h2>
            <p className="sub">Procenat odgovora u kojima je brend pomenut. Ispod: prosečna pozicija među pomenutim brendovima (1 = prvi).</p>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Brend</th>
                    {providers.map((p) => <th key={p} className="num"><PV p={p} /></th>)}
                    <th className="num">Preporučen</th>
                    <th className="num">Negativno</th>
                    <th className="num">Citiran sajt</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const cells = Object.values(r.cells);
                    const sum = (k: keyof Vis) => cells.reduce((s, c) => s + (c[k] as number), 0);
                    return (
                      <tr key={r.brand} className={r.is_own ? "own" : ""}>
                        <td>{r.brand}</td>
                        {providers.map((p) => {
                          const c = r.cells[p];
                          const rate = c?.mention_rate ?? 0;
                          return (
                            <td key={p} className={"heat" + (rate >= 55 ? " hi" : "")} style={{ ["--a" as any]: Math.min(rate / 100, 0.9) }}>
                              <span>{c?.mentioned ? `${rate}%` : "—"}</span>
                              {c?.avg_rank != null && <div className="small" style={{ position: "relative", opacity: .8 }}>#{c.avg_rank}</div>}
                            </td>
                          );
                        })}
                        <td className="num">{sum("recommended")}</td>
                        <td className="num" style={{ color: sum("negative") ? "var(--neg)" : undefined }}>{sum("negative")}</td>
                        <td className="num">{sum("linked")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <h2>Kako svaki sistem dolazi do odgovora</h2>
            <p className="sub">Prosek po odgovoru: koliko puta pretražuje web, koliko stranica pročita i koliko od njih zaista citira.</p>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr><th>AI sistem</th><th className="num">Odgovora</th><th className="num">Išao na web</th><th className="num">Pretraga</th><th className="num">Pročitano</th><th className="num">Citirano</th><th>Citira od pročitanog</th><th className="num">Dužina</th><th className="num">Vreme</th></tr>
                </thead>
                <tbody>
                  {proc.map((p) => {
                    const ratio = p.avg_retrieved ? Math.round((100 * p.avg_cited) / p.avg_retrieved) : 0;
                    return (
                      <tr key={p.provider}>
                        <td><PV p={p.provider} /></td>
                        <td className="num">{p.responses}</td>
                        <td className="num">{p.used_search_pct}%</td>
                        <td className="num">{p.avg_queries}</td>
                        <td className="num">{p.avg_retrieved}</td>
                        <td className="num">{p.avg_cited}</td>
                        <td><div className="bar cite" title={`${ratio}%`}><i style={{ width: `${Math.min(ratio, 100)}%` }} /></div></td>
                        <td className="num">{p.avg_answer_len} zn.</td>
                        <td className="num">{(p.avg_latency_ms / 1000).toFixed(1)} s</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <div className="grid2">
            <section className="panel">
              <h2>Kretanje kroz vreme</h2>
              <p className="sub">Procenat odgovora sa {own?.name ?? "vašim brendom"}, po pokretanju.</p>
              {trendData.length < 2 ? <p className="muted small">Trend se prikazuje posle drugog pokretanja.</p> : (
                <div style={{ height: 240 }}>
                  <ResponsiveContainer>
                    <LineChart data={trendData} margin={{ left: -16, right: 8, top: 8 }}>
                      <CartesianGrid stroke="var(--line)" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--muted)" }} stroke="var(--line)" />
                      <YAxis unit="%" domain={[0, 100]} tick={{ fontSize: 11, fill: "var(--muted)" }} stroke="var(--line)" />
                      <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--line)", fontSize: 12 }} formatter={(v: any, n: any) => [`${v}%`, pLabel(n)]} />
                      <Legend formatter={(v) => pLabel(v)} wrapperStyle={{ fontSize: 12 }} />
                      {providers.map((p) => <Line key={p} dataKey={p} stroke={pColor(p)} strokeWidth={2} dot={{ r: 3 }} connectNulls />)}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </section>
            <section className="panel">
              <h2>Koga još AI preporučuje</h2>
              <p className="sub">Prodavnice i brendovi iz odgovora koje ne pratite. Kandidati za listu konkurenata.</p>
              {!disc.length ? <p className="muted small">Ništa novo.</p> : (
                <table>
                  <thead><tr><th>Naziv</th><th className="num">Pominjanja</th><th className="num">Upita</th><th>Gde</th></tr></thead>
                  <tbody>
                    {disc.slice(0, 15).map((d) => (
                      <tr key={d.brand}><td>{d.brand}</td><td className="num">{d.times}</td><td className="num">{d.prompts}</td><td className="small">{d.providers.map(pLabel).join(", ")}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        </div>
      )}
    </>
  );
}
