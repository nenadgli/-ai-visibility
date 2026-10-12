import { Fragment, useEffect, useState } from "react";
import { useApp } from "../lib/ctx";
import { pLabel, rpc, supabase } from "../lib/supabase";
import { Filters, NoData } from "../components/Filters";

interface Dom { domain: string; category: string | null; retrieved_in: number; cited_in: number; citations: number; cite_rate: number; cited_with_own: number; cited_with_competitor_no_own: number; providers: string[]; sample_urls: string[] }

const CATS: Record<string, string> = {
  own: "Vaš sajt", competitor: "Konkurent", marketplace: "Marketplace", media: "Medij / blog", forum: "Forum", review: "Recenzije",
  social: "Društvene mreže", wiki: "Wikipedia", brand_official: "Sajt brenda", directory: "Imenik / katalog", other: "Ostalo",
};

export default function Sources() {
  const { ws, runId, market } = useApp();
  const [provider, setProvider] = useState<string | null>(null);
  const [rows, setRows] = useState<Dom[]>([]);
  const [view, setView] = useState<"all" | "gap">("all");
  const [open, setOpen] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    if (!ws) return;
    setLoading(true);
    setRows(await rpc<Dom>("get_domain_influence", { p_ws: ws.id, p_run: runId, p_provider: provider, p_market: market }));
    setLoading(false);
  }
  useEffect(() => { load(); }, [ws, runId, market, provider]); // eslint-disable-line

  async function label(domain: string, category: string) {
    if (category) await supabase.from("domain_labels").upsert({ domain, category });
    else await supabase.from("domain_labels").delete().eq("domain", domain);
    setRows((rs) => rs.map((r) => (r.domain === domain ? { ...r, category: category || null } : r)));
  }

  const maxCited = Math.max(1, ...rows.map((r) => r.cited_in));
  const shown = view === "gap" ? rows.filter((r) => r.cited_with_competitor_no_own > 0 && r.category !== "competitor").sort((a, b) => b.cited_with_competitor_no_own - a.cited_with_competitor_no_own) : rows;

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Izvori koje AI koristi</h1>
          <p>Sajtovi iz kojih AI uzima informacije. Ako se konkurenti pominju uz sajt koji vas ne pominje, tu treba da budete prisutni: PR, saradnja, recenzije ili sopstveni sadržaj.</p>
        </div>
        <Filters provider={provider} setProvider={setProvider} />
      </div>

      <div className="filters" style={{ marginBottom: 12 }}>
        <label className="chk"><input type="radio" checked={view === "all"} onChange={() => setView("all")} /> Svi izvori</label>
        <label className="chk"><input type="radio" checked={view === "gap"} onChange={() => setView("gap")} /> Prilike: citiran uz konkurente, a bez vas</label>
      </div>

      {loading ? <p className="muted">Učitavanje…</p> : !shown.length ? <NoData>{view === "gap" ? "Nema izvora gde se konkurenti pojavljuju bez vas." : undefined}</NoData> : (
        <div className="panel tablewrap" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Domen</th><th>Vrsta</th>
                <th className="num" title="U koliko odgovora je AI pročitao ovaj sajt">Pročitan</th>
                <th>Citiran u odgovorima</th>
                <th className="num" title="Koliko puta pročitan sajt završi kao citat">Stopa citiranja</th>
                <th className="num" title="Citiran u odgovorima koji pominju vaš brend">Uz vaš brend</th>
                <th className="num" title="Citiran u odgovorima koji pominju konkurenta, a vas ne">Uz konkurente, bez vas</th>
                <th>Sistemi</th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, 300).map((r) => (
                <Fragment key={r.domain}>
                  <tr className={"click" + (r.category === "own" ? " own" : "")} onClick={() => setOpen(open === r.domain ? null : r.domain)}>
                    <td>{r.domain}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <select value={r.category ?? ""} onChange={(e) => label(r.domain, e.target.value)} aria-label={`Vrsta za ${r.domain}`} style={{ minHeight: 26, padding: "2px 6px" }}>
                        <option value="">—</option>
                        {Object.entries(CATS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                    </td>
                    <td className="num">{r.retrieved_in}</td>
                    <td style={{ minWidth: 140 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div className="bar cite" style={{ flex: 1 }}><i style={{ width: `${(100 * r.cited_in) / maxCited}%` }} /></div>
                        <span style={{ minWidth: 24, textAlign: "right" }}>{r.cited_in}</span>
                      </div>
                    </td>
                    <td className="num">{r.cite_rate ?? 0}%</td>
                    <td className="num">{r.cited_with_own || "—"}</td>
                    <td className="num" style={{ fontWeight: r.cited_with_competitor_no_own ? 600 : 400 }}>{r.cited_with_competitor_no_own || "—"}</td>
                    <td className="small muted">{r.providers.map(pLabel).join(", ")}</td>
                  </tr>
                  {open === r.domain && (
                    <tr><td colSpan={8} style={{ background: "var(--sunk)" }}>
                      <div className="small muted" style={{ marginBottom: 4 }}>Stranice koje je AI koristio:</div>
                      {r.sample_urls.map((u) => <div key={u} className="small"><a href={u} target="_blank" rel="noreferrer">{u}</a></div>)}
                    </td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
