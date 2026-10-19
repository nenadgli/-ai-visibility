import { Fragment, useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useApp } from "../lib/ctx";
import { fmtDate, supabase } from "../lib/supabase";
import { NoData } from "../components/Filters";

interface Feed { id: string; name: string; url: string; site_url: string | null; market: string }
interface Example { id: string; title: string; link: string; feed_size?: string; site_sizes?: string[] }
interface Check { id: string; severity: "critical" | "high" | "medium" | "low"; title: string; why: string; fix: string; affected: number; base: number; share: number; examples: Example[]; note: string | null }
interface BrandRow { name: string; items: number; sale_pct: number; avg_disc: number; median_price: number; outlet_pct: number; new_pct: number }
interface CatRow { name: string; items: number; sale_pct: number; avg_disc: number; median_price: number }
interface Bot { name: string; purpose: string; kind: "search" | "agent" | "training"; status: number }
interface SnapData {
  summary: { items: number; brands: number; categories: number; on_sale_pct: number; avg_disc: number; deep_disc: number; outlet_pct: number; new_pct: number; median_price: number; currency: string };
  checks: Check[];
  passed: string[];
  fill: { field: string; filled: number; pct: number }[];
  brands: BrandRow[];
  categories: CatRow[];
  disc_buckets: { label: string; items: number }[];
  price_bands: { label: string; items: number }[];
  access: { tested_url: string | null; bots: Bot[]; files: Record<string, number> };
}
interface Snapshot { id: string; scanned_at: string; score: number; items: number; data: SnapData }

const SEV: Record<Check["severity"], { label: string; icon: string; cls: string }> = {
  critical: { label: "Kritično", icon: "●", cls: "sev crit" },
  high: { label: "Važno", icon: "▲", cls: "sev high" },
  medium: { label: "Srednje", icon: "◆", cls: "sev med" },
  low: { label: "Sitno", icon: "○", cls: "sev low" },
};
const KIND: Record<Bot["kind"], string> = { search: "Pretraga", agent: "Agent za kupca", training: "Trening" };
const n0 = (v: number) => v.toLocaleString("sr-Latn-RS");
const scoreWord = (s: number) => (s >= 80 ? "Dobro" : s >= 60 ? "Solidno" : s >= 40 ? "Slabo" : "Loše");

export default function FeedXray() {
  const { ws } = useApp();
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [feedId, setFeedId] = useState<string | null>(null);
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [allBrands, setAllBrands] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ws) return;
    setLoading(true);
    supabase.from("feeds").select("*").eq("workspace_id", ws.id).order("created_at").then(({ data }) => {
      setFeeds(data ?? []);
      setFeedId(data?.[0]?.id ?? null);
      if (!data?.length) setLoading(false);
    });
  }, [ws]);

  useEffect(() => {
    if (!feedId) return;
    setLoading(true);
    supabase.from("feed_snapshots").select("*").eq("feed_id", feedId).order("scanned_at", { ascending: false }).limit(30)
      .then(({ data }) => { setSnaps(data ?? []); setLoading(false); });
  }, [feedId]);

  const snap = snaps[0];
  const feed = feeds.find((f) => f.id === feedId);
  const d = snap?.data;
  const insights = useMemo(() => (d ? buildInsights(d) : []), [d]);

  if (loading) return <p className="muted">Učitavanje…</p>;
  if (!feeds.length || !snap || !d) {
    return (
      <>
        <div className="pagehead"><div><h1>Feed X-ray</h1><p>Šta product feed govori o kvalitetu podataka i o samom asortimanu.</p></div></div>
        <NoData>Za ovog klijenta još nema skeniranog feeda. Pokrenite <code>tools/feed-xray/scan.mjs</code> (uputstvo u README).</NoData>
      </>
    );
  }

  const s = d.summary;
  const cur = s.currency || "RSD";
  const bots = d.access?.bots ?? [];
  const brands = allBrands ? d.brands : d.brands.filter((b) => b.items >= 100);
  const maxDisc = Math.max(...d.disc_buckets.map((b) => b.items), 1);

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Feed X-ray</h1>
          <p>Šta product feed govori o kvalitetu podataka (ono što Google i AI agenti vide) i o samom asortimanu. Skenirano {fmtDate(snap.scanned_at)}.</p>
        </div>
        {feeds.length > 1 && (
          <div className="filters">
            <select aria-label="Feed" value={feedId ?? ""} onChange={(e) => setFeedId(e.target.value)}>
              {feeds.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </div>
        )}
      </div>

      <div className="stack">
        <div className="xr-top">
          <section className="panel xr-score">
            <div className="small muted">Kvalitet feeda</div>
            <div className="xr-score-n"><b>{snap.score}</b><span>/100</span></div>
            <div className="bar" style={{ height: 8 }}><i style={{ width: `${snap.score}%`, background: snap.score < 40 ? "var(--neg)" : snap.score < 60 ? "var(--cite)" : "var(--pos)" }} /></div>
            <div className="small" style={{ marginTop: 8 }}><b>{scoreWord(snap.score)}</b> · {d.checks.filter((c) => c.severity === "critical").length} kritična problema · {d.checks.length} ukupno</div>
            {feed && <a className="small" href={feed.url} target="_blank" rel="noreferrer" style={{ display: "block", marginTop: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{feed.name}</a>}
          </section>
          <section className="panel xr-kpis">
            <Kpi v={n0(s.items)} l="artikala u feedu" />
            <Kpi v={String(s.brands)} l="brendova" />
            <Kpi v={`${s.on_sale_pct}%`} l="na popustu" />
            <Kpi v={`−${s.avg_disc}%`} l="prosečan popust" />
            <Kpi v={n0(s.deep_disc)} l="sa popustom ≥ 60%" />
            <Kpi v={`${s.outlet_pct}%`} l="označeno kao outlet" />
            <Kpi v={`${s.new_pct}%`} l="označeno kao novo" />
            <Kpi v={`${n0(s.median_price)} ${cur}`} l="medijalna cena" />
          </section>
        </div>

        {insights.length > 0 && (
          <section className="panel">
            <h2>Šta feed govori o poslovanju</h2>
            <p className="sub">Automatski izvučeno iz cena, popusta i oznaka u feedu. Za razgovor sa direktorom i nabavkom, ne samo sa marketingom.</p>
            <ul className="xr-ins">{insights.map((t, i) => <li key={i}>{t}</li>)}</ul>
          </section>
        )}

        <section className="panel">
          <h2>Šta treba popraviti</h2>
          <p className="sub">Poređano po težini. Udeo = deo kataloga na koji se problem odnosi. Klik otvara objašnjenje i primere.</p>
          <div className="tablewrap">
            <table>
              <thead><tr><th>Težina</th><th>Problem</th><th className="num">Artikala</th><th style={{ width: 160 }}>Udeo kataloga</th></tr></thead>
              <tbody>
                {d.checks.map((c) => (
                  <Fragment key={c.id}>
                    <tr className="click" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>
                      <td><span className={SEV[c.severity].cls}><span aria-hidden>{SEV[c.severity].icon}</span> {SEV[c.severity].label}</span></td>
                      <td>{c.title}</td>
                      <td className="num">{c.id === "bots" ? `${bots.filter((b) => b.kind !== "training" && b.status === 403).length} bota` : n0(c.affected)}</td>
                      <td>{c.id === "bots" ? <span className="small muted">vidi tabelu ispod</span> : <div className="xr-share"><div className="bar"><i style={{ width: `${Math.max(c.share, 0.5)}%`, background: "var(--neg)" }} /></div><span>{c.share}%</span></div>}</td>
                    </tr>
                    {open === c.id && (
                      <tr><td colSpan={4} style={{ background: "var(--sunk)" }}>
                        <div className="xr-detail">
                          <p><b>Zašto je bitno:</b> {c.why}</p>
                          <p><b>Rešenje:</b> {c.fix}</p>
                          {c.note && <p className="small muted">{c.note}</p>}
                          {c.examples.length > 0 && (
                            <div>
                              <div className="small muted" style={{ marginBottom: 4 }}>Primeri</div>
                              {c.examples.map((e) => (
                                <div key={e.id} className="small">
                                  <a href={e.link} target="_blank" rel="noreferrer">{e.title}</a>
                                  {e.site_sizes && <span className="muted"> · feed: <b>{e.feed_size}</b> · sajt: {e.site_sizes.join(", ")}</span>}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {d.passed.length > 0 && <p className="small muted" style={{ marginTop: 10 }}>Provere bez nalaza: {d.passed.map((t) => `„${t}“`).join(", ")}.</p>}
        </section>

        {bots.length > 0 && (
          <section className="panel">
            <h2>Da li AI agenti mogu da otvore sajt</h2>
            <p className="sub">Proizvodna stranica otvorena sa User-Agentom svakog bota. Pretraga i agenti za kupca treba da prolaze; trening crawlere je legitimno blokirati ili naplaćivati.</p>
            <div className="tablewrap">
              <table>
                <thead><tr><th>Bot</th><th>Čemu služi</th><th>Vrsta</th><th>Rezultat</th></tr></thead>
                <tbody>
                  {bots.map((b) => {
                    const ok = b.status >= 200 && b.status < 400;
                    const bad = !ok && b.kind !== "training";
                    return (
                      <tr key={b.name}>
                        <td>{b.name}</td>
                        <td className="muted">{b.purpose}</td>
                        <td><span className="tag">{KIND[b.kind]}</span></td>
                        <td>{ok ? <span className="sev ok">✓ Propušten</span> : <span className={bad ? "sev crit" : "sev low"}>✕ Blokiran ({b.status || "greška"}){bad ? "" : " · u redu"}</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="small muted" style={{ marginTop: 10 }}>
              {Object.entries(d.access.files).map(([p, st]) => `${p}: ${st === 200 ? "postoji" : "ne postoji"}`).join(" · ")}.
              {" "}Test je rađen sa naše IP adrese; potvrditi u Cloudflare → Security → Events.
            </p>
          </section>
        )}

        <div className="grid2">
          <section className="panel">
            <h2>Koliki su popusti</h2>
            <p className="sub">Broj artikala na akciji po visini popusta.</p>
            <Bars data={d.disc_buckets} unit="artikala" highlight={(b) => b.items === maxDisc} />
          </section>
          <section className="panel">
            <h2>Cenovni razredi</h2>
            <p className="sub">Broj artikala po trenutnoj ceni (akcijska ako postoji), u hiljadama {cur}.</p>
            <Bars data={d.price_bands} unit="artikala" />
          </section>
        </div>

        <section className="panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <div>
              <h2>Brendovi</h2>
              <p className="sub">Koliko je svaki brend na popustu i koliko je asortiman svež. Visok udeo popusta = brend se ne prodaje po punoj ceni.</p>
            </div>
            <label className="chk"><input type="checkbox" checked={allBrands} onChange={(e) => setAllBrands(e.target.checked)} /> Svi brendovi ({d.brands.length})</label>
          </div>
          <div className="tablewrap">
            <table>
              <thead><tr><th>Brend</th><th className="num">Artikala</th><th style={{ width: 170 }}>Na popustu</th><th className="num">Prosečan popust</th><th className="num">Medijalna cena</th><th className="num">Outlet</th><th className="num">Novo</th></tr></thead>
              <tbody>
                {brands.map((b) => (
                  <tr key={b.name}>
                    <td>{b.name}</td>
                    <td className="num">{n0(b.items)}</td>
                    <td><div className="xr-share"><div className="bar"><i style={{ width: `${b.sale_pct}%`, background: b.sale_pct >= 60 ? "var(--neg)" : "var(--own)" }} /></div><span>{b.sale_pct}%</span></div></td>
                    <td className="num">{b.avg_disc ? `−${b.avg_disc}%` : "—"}</td>
                    <td className="num">{n0(b.median_price)}</td>
                    <td className="num">{b.outlet_pct}%</td>
                    <td className="num">{b.new_pct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <div className="grid2">
          <section className="panel">
            <h2>Kategorije</h2>
            <p className="sub">Najveće kategorije i koliki deo je na popustu.</p>
            <div className="tablewrap">
              <table>
                <thead><tr><th>Kategorija</th><th className="num">Artikala</th><th style={{ width: 140 }}>Na popustu</th><th className="num">Med. cena</th></tr></thead>
                <tbody>
                  {d.categories.slice(0, 20).map((c) => (
                    <tr key={c.name}>
                      <td className="small">{c.name}</td>
                      <td className="num">{n0(c.items)}</td>
                      <td><div className="xr-share"><div className="bar"><i style={{ width: `${c.sale_pct}%`, background: c.sale_pct >= 60 ? "var(--neg)" : "var(--own)" }} /></div><span>{c.sale_pct}%</span></div></td>
                      <td className="num">{n0(c.median_price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="panel">
            <h2>Popunjenost polja</h2>
            <p className="sub">Koliko artikala ima vrednost u svakom polju feeda.</p>
            <div className="tablewrap">
              <table>
                <thead><tr><th>Polje</th><th style={{ width: 170 }}>Popunjeno</th></tr></thead>
                <tbody>
                  {[...d.fill].sort((a, b) => a.pct - b.pct).map((f) => (
                    <tr key={f.field}>
                      <td><code>{f.field}</code></td>
                      <td><div className="xr-share"><div className="bar"><i style={{ width: `${f.pct}%`, background: f.pct < 50 ? "var(--neg)" : "var(--own)" }} /></div><span>{f.pct}%</span></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

function Kpi({ v, l }: { v: string; l: string }) {
  return <div className="xr-kpi"><b>{v}</b><span>{l}</span></div>;
}

function Bars({ data, unit, highlight }: { data: { label: string; items: number }[]; unit: string; highlight?: (b: { label: string; items: number }) => boolean }) {
  return (
    <div style={{ height: 220 }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ left: -12, right: 8, top: 8 }}>
          <CartesianGrid stroke="var(--line)" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--muted)" }} stroke="var(--line)" tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} stroke="var(--line)" tickLine={false} axisLine={false} tickFormatter={(v) => n0(v)} />
          <Tooltip cursor={{ fill: "var(--sunk)" }} contentStyle={{ background: "var(--surface)", border: "1px solid var(--line)", fontSize: 12, color: "var(--ink)" }}
            formatter={(v: any) => [`${n0(v)} ${unit}`, ""]} separator="" />
          <Bar dataKey="items" radius={[4, 4, 0, 0]} maxBarSize={44} isAnimationActive={false}
            shape={(p: any) => <rect x={p.x} y={p.y} width={p.width} height={p.height} rx={4} fill={highlight?.(p.payload) ? "var(--own)" : "var(--faint)"} />} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Rečenice za menadžment, izračunate iz agregata (bez AI)
function buildInsights(d: SnapData): string[] {
  const s = d.summary;
  const out: string[] = [];
  out.push(`${s.on_sale_pct}% kataloga je na popustu, u proseku −${s.avg_disc}%. ${n0(s.deep_disc)} artikala ima popust od 60% ili više.`);
  if (Math.abs(s.outlet_pct - s.on_sale_pct) < 3) out.push(`Oznaka „outlet“ i akcijska cena se praktično poklapaju (${s.outlet_pct}% i ${s.on_sale_pct}%): skoro sve što je na popustu je u outletu.`);
  const big = d.brands.filter((b) => b.items >= 300 && b.name !== "(prazno)");
  if (big.length >= 4) {
    const hi = [...big].sort((a, b) => b.sale_pct - a.sale_pct).slice(0, 2);
    const lo = [...big].filter((b) => b.sale_pct > 0).sort((a, b) => a.sale_pct - b.sale_pct).slice(0, 2);
    out.push(`Najviše na popustu (među brendovima sa 300+ artikala): ${hi.map((b) => `${b.name} ${b.sale_pct}%`).join(", ")}. Najmanje: ${lo.map((b) => `${b.name} ${b.sale_pct}%`).join(", ")}. Signal za nabavku koji se brendovi ne prodaju po punoj ceni.`);
  }
  const cats = d.categories.filter((c) => c.items >= 200);
  const hot = [...cats].sort((a, b) => b.sale_pct - a.sale_pct).slice(0, 3);
  const cold = [...cats].sort((a, b) => a.sale_pct - b.sale_pct).slice(0, 2);
  if (hot.length) out.push(`Kategorije sa najvećim udelom popusta: ${hot.map((c) => `${short(c.name)} ${c.sale_pct}%`).join(", ")}. Najmanje: ${cold.map((c) => `${short(c.name)} ${c.sale_pct}%`).join(", ")}.`);
  const fresh = d.brands.filter((b) => b.items >= 50 && b.new_pct >= 55).sort((a, b) => b.new_pct - a.new_pct).slice(0, 3);
  if (fresh.length) out.push(`Najsvežiji asortiman (udeo „novo“): ${fresh.map((b) => `${b.name} ${b.new_pct}%`).join(", ")}. To su brendovi za isticanje u kampanjama i AI preporukama.`);
  return out;
}
const short = (c: string) => c.split(" > ").filter((_, i, a) => i === 0 || i === a.length - 1).join(" · ");
