import { Fragment, useEffect, useState } from "react";
import { useApp } from "../lib/ctx";
import { fmtDate, rpc, supabase } from "../lib/supabase";
import { NoData } from "../components/Filters";

// Originalni feed klijenta, takav kakav jeste: svaki <item> doslovno, sa pretragom.
// Puni ga Agent Feed u tabelu feed_source_items (migracija 010); opis izvora je u agent_feeds.stats.source.

interface Source { url: string; bytes: number; items: number; head: string; fields: Record<string, { present: number; filled: number }>; fetched_at: string; changed?: number; removed?: number }
interface Feed { id: string; name: string; source_url: string; stats: { source?: Source } | null }
interface Row { product_id: string; pos: number; title: string | null; brand: string | null; size: string | null; product_type: string | null; price: string | null; sale_price: string | null; availability: string | null }

const PAGE = 50;
const n0 = (v: number | null | undefined) => (v == null ? "—" : Math.round(v).toLocaleString("sr-Latn-RS"));
// isto kao public._norm u bazi
const norm = (t: string) => t.toLowerCase().replace(/[čć]/g, "c").replace(/ž/g, "z").replace(/š/g, "s").replace(/đ/g, "d").replace(/['’]/g, "")
  .replace(/\s*&\s*/g, "&").replace(/[^a-z0-9&]+/g, " ").trim();

export default function SourceFeed() {
  const { ws } = useApp();
  const [feeds, setFeeds] = useState<Feed[] | null>(null);
  const [feedId, setFeedId] = useState<string | null>(null);
  const [brands, setBrands] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [brand, setBrand] = useState("");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [showFields, setShowFields] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!ws) return;
    supabase.from("agent_feeds").select("id,name,source_url,stats").eq("workspace_id", ws.id).order("created_at").then(({ data, error }) => {
      if (error) { setErr(error.message); return; }
      setFeeds((data ?? []) as Feed[]);
      setFeedId(data?.[0]?.id ?? null);
    });
    rpc<{ brands: { brand: string }[] }>("get_feed_compare_summary", { p_ws: ws.id })
      .then((r) => setBrands((r[0]?.brands ?? []).map((b) => b.brand).sort((a, b) => a.localeCompare(b, "sr"))))
      .catch(() => setBrands([]));
  }, [ws]);

  useEffect(() => { const t = setTimeout(() => setQuery(q), 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => { setPage(0); }, [query, brand, feedId]);

  useEffect(() => {
    if (!feedId) return;
    setLoading(true);
    let req = supabase.from("feed_source_items").select("product_id,pos,title,brand,size,product_type,price,sale_price,availability", { count: "exact" }).eq("feed_id", feedId);
    if (brand) req = req.eq("brand", brand);
    for (const w of norm(query).split(" ").filter(Boolean)) req = req.ilike("nsearch", `%${w}%`);
    req.order("pos").range(page * PAGE, page * PAGE + PAGE - 1).then(({ data, count, error }) => {
      setLoading(false);
      if (error) { setErr(error.message); return; }
      setErr(null);
      setRows((data ?? []) as Row[]);
      setTotal(count ?? 0);
      if (data?.length === 1) setOpen((data[0] as Row).product_id);
    });
  }, [feedId, query, brand, page]);

  const feed = feeds?.find((f) => f.id === feedId) ?? null;
  const src = feed?.stats?.source ?? null;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  if (feeds && !feeds.length) return <NoData>Klijent nema podešen feed. Dodaje se u tabelu agent_feeds.</NoData>;

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Originalni feed</h1>
          <p>Feed klijenta tačno kako ga Magento izvozi i kako ga Google i AI čitaju, bez naših ispravki. Osvežava se pri svakom objavljivanju Agent Feeda.</p>
        </div>
        {feeds && feeds.length > 1 && (
          <div className="filters">
            <select aria-label="Feed" value={feedId ?? ""} onChange={(e) => setFeedId(e.target.value)}>
              {feeds.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </div>
        )}
      </div>

      {err && <p className="err" style={{ marginBottom: 16 }}>{err}</p>}
      {feed && !src && <p className="panel small" style={{ marginBottom: 16 }}>Originalni feed se upisuje pri sledećem objavljivanju Agent Feeda (svakog sata u :41).</p>}

      <div className="stack">
        {feed && (
          <section className="panel">
            <div className="xr-kpis">
              <Kpi v={n0(src?.items)} l="proizvoda u feedu" />
              <Kpi v={src ? `${(src.bytes / 1048576).toFixed(1)} MB` : "—"} l="veličina fajla" />
              <Kpi v={src ? String(Object.keys(src.fields).length) : "—"} l="različitih polja" />
              <Kpi v={src ? fmtDate(src.fetched_at) : "—"} l={src?.changed != null ? `preuzeto; izmenjeno ${n0(src.changed)}, uklonjeno ${n0(src.removed)}` : "preuzeto"} />
            </div>
            <p className="small" style={{ marginTop: 12, wordBreak: "break-all" }}>Izvor: <a href={feed.source_url} target="_blank" rel="noreferrer">{feed.source_url}</a></p>
            {src && (
              <>
                <button className="btn ghost" style={{ marginTop: 8, paddingLeft: 0 }} onClick={() => setShowFields(!showFields)}>{showFields ? "▾" : "▸"} Polja u feedu i zaglavlje</button>
                {showFields && (
                  <div className="grid2" style={{ marginTop: 8 }}>
                    <div className="tablewrap">
                      <table>
                        <thead><tr><th>Polje</th><th className="num">Ima polje</th><th className="num">Popunjeno</th></tr></thead>
                        <tbody>
                          {Object.entries(src.fields).sort((a, b) => b[1].present - a[1].present).map(([tag, f]) => (
                            <tr key={tag}>
                              <td><code>{tag}</code></td>
                              <td className="num">{n0(f.present)}</td>
                              <td className="num">{n0(f.filled)} <span className="small muted">({Math.round((100 * f.filled) / src.items)}%)</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <h3 style={{ marginBottom: 6 }}>Zaglavlje (pre prvog proizvoda)</h3>
                      <pre className="fc-xml"><Xml text={src.head} /></pre>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        )}

        <section className="panel">
          <div className="filters" style={{ marginBottom: 12 }}>
            <input type="text" aria-label="Pretraga" placeholder="ID, brend ili naziv: 859813, tommy majica" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: "1 1 280px" }} />
            <select aria-label="Brend" value={brand} onChange={(e) => setBrand(e.target.value)}>
              <option value="">Svi brendovi</option>
              {brands.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <p className="small muted" style={{ marginBottom: 8 }}>{loading ? "Učitavanje…" : `${n0(total)} proizvoda, redosled kao u feedu${total > PAGE ? `, strana ${page + 1} od ${pages}` : ""}. Klik na red prikazuje proizvod tačno kako je u feedu.`}</p>
          <div className="tablewrap">
            <table>
              <thead><tr><th className="num">#</th><th>g:id</th><th>title</th><th>g:brand</th><th>g:size</th><th>g:product_type</th><th className="num">g:price</th><th className="num">g:sale_price</th><th>g:availability</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.product_id}>
                    <tr className="click" onClick={() => setOpen(open === r.product_id ? null : r.product_id)}>
                      <td className="num muted">{r.pos + 1}</td>
                      <td>{r.product_id}</td>
                      <td>{r.title}</td>
                      <td>{r.brand}</td>
                      <td style={{ whiteSpace: "nowrap" }}>{r.size}</td>
                      <td className="small">{r.product_type}</td>
                      <td className="num" style={{ whiteSpace: "nowrap" }}>{r.price}</td>
                      <td className="num" style={{ whiteSpace: "nowrap" }}>{r.sale_price}</td>
                      <td className="small">{r.availability}</td>
                    </tr>
                    {open === r.product_id && feedId && <tr><td colSpan={9} style={{ background: "var(--sunk)" }}><Raw feedId={feedId} id={r.product_id} /></td></tr>}
                  </Fragment>
                ))}
                {!loading && !rows.length && <tr><td colSpan={9} className="muted">{src ? "Nema proizvoda za ovu pretragu. Probaj samo brend ili ID." : "Još nema podataka."}</td></tr>}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="filters" style={{ marginTop: 12, justifyContent: "flex-end" }}>
              <button className="btn" disabled={page === 0} onClick={() => setPage(page - 1)}>← Prethodna</button>
              <span className="small muted">{page + 1} / {pages}</span>
              <button className="btn" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Sledeća →</button>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function Kpi({ v, l }: { v: string; l: string }) {
  return <div className="xr-kpi"><b>{v}</b><span>{l}</span></div>;
}

// sirov <item> iz baze, prikazan doslovno (samo zajedničko uvlačenje redova je skinuto radi čitljivosti)
function Raw({ feedId, id }: { feedId: string; id: string }) {
  const [raw, setRaw] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    supabase.from("feed_source_items").select("raw").eq("feed_id", feedId).eq("product_id", id).single()
      .then(({ data }) => setRaw(data ? dedent((data as { raw: string }).raw) : ""));
  }, [feedId, id]);
  if (raw == null) return <p className="small muted">Učitavanje…</p>;
  const copy = () => navigator.clipboard?.writeText(raw).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  return (
    <div className="fc-detail">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <h3>Proizvod {id} u feedu <span className="small muted">{raw.length.toLocaleString("sr-Latn-RS")} znakova</span></h3>
        <button className="btn" onClick={copy}>{copied ? "Kopirano" : "Kopiraj XML"}</button>
      </div>
      <pre className="fc-xml" style={{ maxHeight: 520 }}><Xml text={raw} /></pre>
    </div>
  );
}

function dedent(s: string) {
  const lines = s.split("\n");
  const ind = Math.min(...lines.slice(1).filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
  return [lines[0], ...lines.slice(1).map((l) => l.slice(Math.min(ind, /^[ \t]*/.exec(l)![0].length)))].join("\n").trimEnd();
}

// oznake bledo, CDATA omotač bledo, vrednosti normalno
function Xml({ text }: { text: string }) {
  const parts = text.split(/(<!\[CDATA\[|\]\]>|<[^>]+>)/);
  return <>{parts.map((p, i) => (i % 2 ? <span key={i} className="fc-t">{p}</span> : p))}</>;
}
